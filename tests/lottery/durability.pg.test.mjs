// 开奖持久性（真实 PostgreSQL）：事务中途失败不会留下半个结果；
// 已开奖后重试只补发通知，不会再抽一次。
import { test } from 'node:test';
import { seedMonth, monthCounter } from './support/monthly-fixture.mjs';
import { withFixtureSnapshot } from './support/snapshot-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from '../activities/support/pg-fixture.mjs';
// Observe real uncommitted writes only for the internal JavaScript cutoff signal.
// A SQL-aborted transaction must never be queried to manufacture rollback evidence.
function observeCutoffTransactions(run, lotteryId, records) {
  return (action) =>
    run(async (tx) => {
      const record = { queries: [], error: null };
      records.push(record);
      const observed = new Proxy(tx, {
        get(target, key) {
          if (key === '$queryRaw')
            return async (strings, ...values) => {
              record.queries.push({ sql: strings.join('?'), values });
              return target.$queryRaw(strings, ...values);
            };
          return Reflect.get(target, key);
        }
      });
      try {
        return await action(observed);
      } catch (error) {
        record.error = error.constructor.name;
        if (record.error === 'DrawFenceRequired') {
          record.preRollbackEntries = await tx.lotteryEntry.findMany({
            where: { lotteryId },
            orderBy: { accountId: 'asc' }
          });
          record.preRollbackNotices = await tx.lotteryNotification.findMany({
            where: { lotteryId },
            orderBy: { eventKey: 'asc' }
          });
        }
        throw error;
      }
    });
}
function assertFreshDueFence(records) {
  assert.equal(records.length, 2);
  assert.equal(records[0].error, 'DrawFenceRequired');
  assert.ok(!records[0].queries.some((q) => q.sql.includes('lottery_try_account_fence')));
  const due = records[1].queries,
    fence = due.findIndex((q) => q.sql.includes('lottery_try_account_fence')),
    locked = due.findIndex(
      (q) =>
        q.sql.includes('pg_advisory_xact_lock') &&
        q.values[0]?.startsWith('lottery:') &&
        q.values[0] !== 'lottery:write'
    );
  assert.ok(
    fence >= 0 && fence < locked,
    'fresh due transaction must preserve Account fence before lottery advisory'
  );
}

test('开奖结果持久：真实 PostgreSQL', async (t) => {
  const f = await fixture();
  try {
    const { AccountService } = await import('../../apps/web/server/auth/service.ts'),
      { LotteryService } = await import('../../apps/web/server/lottery/service.ts'),
      { mainlandChinaPhone, unavailableSms } = await import('../../apps/web/server/auth/ports.ts');
    let clock = new Date('2030-10-01');
    const auth = new AccountService(f.db, {
        phone: mainlandChinaPhone,
        sms: unavailableSms,
        environment: 'test',
        now: () => clock
      }),
      s = new LotteryService(auth, withFixtureSnapshot()),
      body = (extra = {}) => ({
        idempotencyKey: randomUUID(),
        title: '持久化测试',
        kind: 'ORDINARY',
        mode: 'MANUAL',
        audience: 'MEMBER',
        month: null,
        minDays: null,
        prizes: [{ name: 'gift', quantity: 1 }],
        drawAt: '2030-10-20T20:00:00+08:00',
        ...extra
      });
    const r = (await s.create(body(), f.tokens[0])).lottery;
    await s.change(r.id, 'join', { idempotencyKey: randomUUID() }, f.tokens[1]);
    clock = new Date(r.drawAt);
    await f.db.$executeRawUnsafe(
      `CREATE FUNCTION lottery_test_notice_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."kind"='LOTTERY_WON' THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF; RETURN NEW; END $$`
    );
    await f.db.$executeRawUnsafe(
      'CREATE TRIGGER lottery_test_notice_fail BEFORE INSERT ON "LotteryNotification" FOR EACH ROW EXECUTE FUNCTION lottery_test_notice_fail()'
    );
    try {
      await assert.rejects(() => s.maintain(r.id));
      const [saved] = await f.db.$queryRawUnsafe(
        'SELECT "state","result" FROM "Lottery" WHERE "id"=$1',
        r.id
      );
      assert.equal(saved.state, 'DRAWN');
      assert.equal(saved.result.winners.length, 1);
      await f.db.$executeRawUnsafe('DROP TRIGGER lottery_test_notice_fail ON "LotteryNotification"');
      await f.db.$executeRawUnsafe('DROP FUNCTION lottery_test_notice_fail()');
      const d = await s.maintain(r.id);
      assert.deepEqual(d.result, saved.result);
      assert.equal(
        (
          await f.db.$queryRawUnsafe(
            'SELECT count(*)::int count FROM "LotteryNotification" WHERE "lotteryId"=$1 AND "kind"=$2',
            r.id,
            'LOTTERY_WON'
          )
        )[0].count,
        2
      );
      console.log(
        'PASS DURABILITY failed outbox construction cannot roll back fixed draw; repeated maintain repairs same winners'
      );
    } finally {
      await f.db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS lottery_test_notice_fail ON "LotteryNotification"'
      );
      await f.db.$executeRawUnsafe('DROP FUNCTION IF EXISTS lottery_test_notice_fail()');
    }
    clock = new Date('2030-10-01');
    let allow = false;
    await seedMonth(f.db, f.ids, '2030-11', 2);
    const auto = new LotteryService(auth, {
      accountActive: async (_, id) => id === f.ids[0] || allow,
      countMonth: monthCounter(f.db, '2030-11')
    });
    const a = (
      await auto.create(
        body({
          kind: 'MONTHLY',
          mode: 'AUTO',
          month: '2030-11',
          minDays: 2,
          drawAt: '2030-12-01T20:00:00+08:00'
        }),
        f.tokens[0]
      )
    ).lottery;
    clock = new Date('2030-11-30T16:00:00Z');
    await auto.maintain(a.id);
    allow = true;
    clock = new Date(Date.parse(a.drawAt) - 1000);
    await f.db.$executeRawUnsafe(
      `CREATE FUNCTION lottery_test_entry_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('lottery-test-enroll',0)); RETURN NEW; END $$`
    );
    await f.db.$executeRawUnsafe(
      'CREATE TRIGGER lottery_test_entry_wait BEFORE INSERT ON "LotteryEntry" FOR EACH ROW EXECUTE FUNCTION lottery_test_entry_wait()'
    );
    let ready, release;
    const acquired = new Promise((r) => (ready = r)),
      unblock = new Promise((r) => (release = r));
    const holder = f.db.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtextextended('lottery-test-enroll',0))::text"
        );
        ready();
        await unblock;
      },
      { timeout: 15000 }
    );
    await acquired;
    const beforeEntries = await f.db.lotteryEntry.findMany({
        where: { lotteryId: a.id },
        orderBy: { accountId: 'asc' }
      }),
      beforeNotices = await f.db.lotteryNotification.findMany({
        where: { lotteryId: a.id },
        orderBy: { eventKey: 'asc' }
      }),
      records = [];
    const originalTransaction = auth.transaction;
    auth.transaction = observeCutoffTransactions((fn) => originalTransaction.call(auth, fn), a.id, records);
    const pending = auto.maintain(a.id).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    try {
      let waiting = false;
      for (let n = 0; n < 100; n++) {
        const [row] = await f.db.$queryRawUnsafe(
          "SELECT count(*)::int count FROM pg_locks WHERE locktype='advisory' AND NOT granted"
        );
        if (row.count) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(waiting);
      clock = new Date(a.drawAt);
      release();
      await holder;
      assert.equal((await pending).error?.code, 'SERVICE_UNAVAILABLE');
      assertFreshDueFence(records);
      assert.ok(
        records[0].preRollbackEntries.length > beforeEntries.length,
        'pre transaction must have actual inserts before rollback'
      );
      assert.equal(
        records[0].preRollbackNotices.length - beforeNotices.length,
        records[0].preRollbackEntries.length - beforeEntries.length
      );
      assert.deepEqual(
        await f.db.lotteryEntry.findMany({ where: { lotteryId: a.id }, orderBy: { accountId: 'asc' } }),
        beforeEntries
      );
      assert.deepEqual(
        await f.db.lotteryNotification.findMany({ where: { lotteryId: a.id }, orderBy: { eventKey: 'asc' } }),
        beforeNotices
      );
      const stillOpen = await f.db.lottery.findUnique({ where: { id: a.id } });
      assert.equal(stillOpen.state, 'OPEN');
      assert.equal(stillOpen.result, null);
      const entries = await f.db.$queryRawUnsafe(
        'SELECT "accountId" FROM "LotteryEntry" WHERE "lotteryId"=$1',
        a.id
      );
      assert.deepEqual(
        entries.map((e) => e.accountId),
        [f.ids[0]]
      );
    } finally {
      release();
      await holder;
      auth.transaction = originalTransaction;
      await f.db.$executeRawUnsafe('DROP TRIGGER lottery_test_entry_wait ON "LotteryEntry"');
      await f.db.$executeRawUnsafe('DROP FUNCTION lottery_test_entry_wait()');
    }
    let snapshotCalls = 0,
      randomCalls = 0;
    const sealed = withFixtureSnapshot({
        accountActive: async () => true,
        countMonth: monthCounter(f.db, '2030-11'),
        randomInt: () => {
          randomCalls++;
          return 0;
        }
      }),
      snapshot = sealed.drawEligibilityAt;
    sealed.drawEligibilityAt = async (tx, request) => {
      snapshotCalls++;
      assert.deepEqual(
        await tx.lotteryEntry.findMany({ where: { lotteryId: a.id }, orderBy: { accountId: 'asc' } }),
        beforeEntries
      );
      return snapshot(tx, request);
    };
    const recover = new LotteryService(auth, sealed),
      first = await recover.maintain(a.id),
      fixed = structuredClone(first.result),
      drawCalls = randomCalls;
    assert.equal(first.state, 'DRAWN');
    assert.equal(first.result.drawnAt, a.drawAt);
    assert.equal(first.result.participants, f.ids.length - 1);
    const repaired = await f.db.lotteryNotification.findMany({
      where: { lotteryId: a.id },
      orderBy: { eventKey: 'asc' }
    });
    assert.equal(repaired.filter((n) => n.kind === 'LOTTERY_ENROLLED').length, f.ids.length - 1);
    assert.deepEqual(
      repaired
        .filter((n) => n.kind === 'LOTTERY_WON')
        .map((n) => n.channel)
        .sort(),
      ['IN_APP', 'QQ']
    );
    assert.equal(repaired.length, f.ids.length + 1);
    assert.deepEqual(
      repaired
        .filter((n) => n.kind === 'LOTTERY_WON')
        .map((n) => ({ eventKey: n.eventKey, recipientId: n.recipientId }))
        .sort((x, y) => x.eventKey.localeCompare(y.eventKey)),
      [
        {
          eventKey: `lottery:${a.id}:won:${fixed.winners[0].accountId}:inapp`,
          recipientId: fixed.winners[0].accountId
        },
        {
          eventKey: `lottery:${a.id}:won:${fixed.winners[0].accountId}:qq`,
          recipientId: fixed.winners[0].accountId
        }
      ].sort((x, y) => x.eventKey.localeCompare(y.eventKey))
    );
    await recover.maintain(a.id);
    await recover.enqueueResultNotifications(a.id);
    assert.equal(snapshotCalls, 1);
    assert.equal(randomCalls, drawCalls);
    assert.deepEqual((await f.db.lottery.findUnique({ where: { id: a.id } })).result, fixed);
    assert.deepEqual(
      await f.db.lotteryNotification.findMany({ where: { lotteryId: a.id }, orderBy: { eventKey: 'asc' } }),
      repaired
    );
  } finally {
    await f.cleanup();
  }
});
