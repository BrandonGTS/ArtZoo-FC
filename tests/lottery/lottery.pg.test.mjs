// 抽奖（真实 PostgreSQL）：发布权限、参加与退出、开奖只执行一次、结果不可修改、
// 通知失败不重抽、锁等待后重新核对、中奖分布均匀。
import { test } from 'node:test';
import { seedMonth, monthCounter } from './support/monthly-fixture.mjs';
import { withFixtureSnapshot } from './support/snapshot-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, noPrivate } from '../activities/support/pg-fixture.mjs';

test('抽奖：真实 PostgreSQL', async (t) => {
  const f = await fixture();
  let clock = new Date('2030-10-01T00:00:00Z');
  const { AccountService } = await import('../../apps/web/server/auth/service.ts'),
    { LotteryService } = await import('../../apps/web/server/lottery/service.ts'),
    { mainlandChinaPhone, unavailableSms } = await import('../../apps/web/server/auth/ports.ts');
  const { validateLottery, selectWinners, monthBounds } =
    await import('../../apps/web/server/lottery/contract.ts');
  const auth = new AccountService(f.db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      environment: 'test',
      now: () => clock
    }),
    disabled = new Set(),
    s = new LotteryService(
      auth,
      withFixtureSnapshot({
        accountActive: async (_, id) => !disabled.has(id),
        countMonth: monthCounter(f.db, '2030-11')
      })
    );
  const input = (extra = {}) => ({
    idempotencyKey: randomUUID(),
    title: '秋日小礼物',
    kind: 'ORDINARY',
    mode: 'MANUAL',
    audience: 'MEMBER',
    month: null,
    minDays: null,
    prizes: [
      { name: '手账本', quantity: 1 },
      { name: '明信片', quantity: 2 }
    ],
    drawAt: '2030-10-20T20:00:00+08:00',
    ...extra
  });
  const cmd = () => ({ idempotencyKey: randomUUID() }),
    create = async (extra = {}) => (await s.create(input(extra), f.tokens[0])).lottery,
    change = (row, a, i = 1) => s.change(row.id, a, cmd(), f.tokens[i]);
  const raw = (id) => f.db.$queryRawUnsafe('SELECT * FROM "Lottery" WHERE "id"=$1', id).then((r) => r[0]);
  const entries = (id) =>
      f.db.$queryRawUnsafe('SELECT * FROM "LotteryEntry" WHERE "lotteryId"=$1 ORDER BY "accountId"', id),
    notes = (id) => f.db.$queryRawUnsafe('SELECT * FROM "LotteryNotification" WHERE "lotteryId"=$1', id);
  const check = (name, fn) => t.test(name, fn);
  const reset = () => {
    clock = new Date('2030-10-01T00:00:00Z');
    disabled.clear();
  };
  const waitLock = async () => {
    for (let i = 0; i < 100; i++) {
      const [r] = await f.db.$queryRawUnsafe(
        "SELECT count(*)::int count FROM pg_locks WHERE locktype='advisory' AND NOT granted"
      );
      if (r.count) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error('lock not observed');
  };
  async function held(key, work, advance) {
    let ready, release;
    const acquired = new Promise((r) => (ready = r)),
      unblock = new Promise((r) => (release = r));
    const holder = f.db.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text', key);
        ready();
        await unblock;
      },
      { timeout: 15000 }
    );
    await acquired;
    const pending = work().then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    try {
      await waitLock();
      await advance();
      release();
      await holder;
      return await pending;
    } finally {
      release();
      await holder;
    }
  }
  try {
    await check('anonymous guarded, friend cannot publish, administrator may publish', async () => {
      await assert.rejects(
        () => s.list(null),
        (e) => e.code === 'UNAUTHENTICATED'
      );
      await assert.rejects(
        () => s.create(input(), f.tokens[5]),
        (e) => e.code === 'FORBIDDEN'
      );
      await f.db.account.update({ where: { id: f.ids[5] }, data: { adminRole: 'ADMIN' } });
      assert.equal((await s.create(input(), f.tokens[5])).lottery.creator.id, f.ids[5]);
      await f.db.account.update({ where: { id: f.ids[5] }, data: { adminRole: 'NONE' } });
    });
    await check(
      'defaults, strict schema, China month/leap boundary and no guessed monthly thresholds',
      async () => {
        const b = input();
        for (const extra of [
          { prizes: [] },
          { winnerCount: 4 },
          { drawAt: '2030-02-30T20:00:00+08:00' },
          { kind: 'MONTHLY', mode: 'AUTO', month: '2030-09', minDays: 10 },
          {
            kind: 'MONTHLY',
            mode: 'AUTO',
            month: '2030-11',
            minDays: null,
            drawAt: '2030-12-01T00:00:00+08:00'
          },
          {
            kind: 'MONTHLY',
            mode: 'AUTO',
            month: '2030-11',
            minDays: 31,
            drawAt: '2030-12-01T00:00:00+08:00'
          }
        ])
          assert.throws(() => validateLottery({ ...b, ...extra }, clock));
        assert.equal(
          validateLottery(input({ kind: 'MONTHLY', mode: 'AUTO', month: '2030-10', minDays: 10 }), clock)
            .month,
          '2030-10'
        );
        assert.throws(() =>
          validateLottery(
            input({
              kind: 'MONTHLY',
              mode: 'AUTO',
              month: '2030-10',
              minDays: 10,
              drawAt: '2030-10-10T00:00:00+08:00'
            }),
            clock
          )
        );
        assert.equal(monthBounds('2032-02').days, 29);
        assert.equal(monthBounds('2030-12').end.toISOString(), '2030-12-31T16:00:00.000Z');
        assert.equal(
          validateLottery(
            input({
              kind: 'MONTHLY',
              mode: 'AUTO',
              month: '2030-12',
              minDays: 17,
              drawAt: '2031-01-01T00:00:00+08:00',
              prizes: [{ name: 'monthly', quantity: 1 }]
            }),
            clock
          ).minDays,
          17
        );
      }
    );
    await check(
      'retired ordinary AUTO and monthly MANUAL publication reject without lottery writes',
      async () => {
        const capture = async () => ({
          rows: await f.db.lottery.findMany({ orderBy: { id: 'asc' } }),
          entries: await f.db.lotteryEntry.findMany({
            orderBy: [{ lotteryId: 'asc' }, { accountId: 'asc' }]
          }),
          commands: await f.db.lotteryCommand.findMany({
            orderBy: [{ lotteryId: 'asc' }, { actorId: 'asc' }, { key: 'asc' }]
          }),
          notifications: await f.db.lotteryNotification.findMany({ orderBy: { eventKey: 'asc' } })
        });
        for (const extra of [
          { mode: 'AUTO' },
          {
            kind: 'MONTHLY',
            mode: 'MANUAL',
            month: '2030-11',
            minDays: 2,
            drawAt: '2030-12-01T20:00:00+08:00'
          }
        ]) {
          const before = await capture();
          await assert.rejects(
            () => s.create(input(extra), f.tokens[0]),
            (e) => e.code === 'VALIDATION_ERROR'
          );
          assert.deepEqual(await capture(), before);
        }
      }
    );
    await check(
      'published settings immutable, same publish key replays once, changed content conflicts',
      async () => {
        const b = input(),
          r = await Promise.all([s.create(b, f.tokens[0]), s.create(b, f.tokens[0])]);
        assert.equal(r[0].lottery.id, r[1].lottery.id);
        assert.equal(r.filter((x) => x.replayed).length, 1);
        await assert.rejects(
          () => s.create({ ...b, title: 'changed' }, f.tokens[0]),
          (e) => e.code === 'CONFLICT'
        );
        await assert.rejects(() =>
          f.db.$executeRawUnsafe('UPDATE "Lottery" SET "title"=$1 WHERE "id"=$2', 'changed', r[0].lottery.id)
        );
      }
    );
    await check(
      'identity scope, activity points irrelevant, ordinary join leave rejoin and unique entry',
      async () => {
        const r = await create();
        await assert.rejects(
          () => change(r, 'join', 5),
          (e) => e.code === 'FORBIDDEN'
        );
        await f.db.account.update({
          where: { id: f.ids[1] },
          data: { activityPoints: 8, activityDecayAt: new Date('2031-01-01') }
        });
        const c = cmd();
        await Promise.all([s.change(r.id, 'join', c, f.tokens[1]), s.change(r.id, 'join', c, f.tokens[1])]);
        assert.equal((await entries(r.id)).length, 1);
        assert.equal((await change(r, 'leave')).lottery.mine.state, 'WITHDRAWN');
        assert.equal((await change(r, 'join')).lottery.mine.state, 'ACTIVE');
        const b = await create({ audience: 'MEMBER_FRIEND' });
        assert.equal((await change(b, 'join', 5)).lottery.mine.eligible, true);
      }
    );
    await check(
      'monthly AUTO publication enrolls immediately; worker retains month-end boundary and opt-outs',
      async () => {
        disabled.add(f.ids[2]);
        await seedMonth(f.db, f.ids, '2030-11', 2);
        const auto = new LotteryService(
          auth,
          withFixtureSnapshot({
            accountActive: async (_, id) => !disabled.has(id),
            countMonth: monthCounter(f.db, '2030-11')
          })
        );
        const r = (
          await auto.create(
            input({
              kind: 'MONTHLY',
              mode: 'AUTO',
              month: '2030-11',
              minDays: 2,
              drawAt: '2030-12-01T20:00:00+08:00'
            }),
            f.tokens[0]
          )
        ).lottery;
        assert.equal((await entries(r.id)).length, 11);
        const publishedEntries = await entries(r.id),
          publishedNotes = await notes(r.id);
        assert.ok(publishedEntries.every((e) => e.source === 'AUTO' && e.state === 'ACTIVE'));
        assert.equal(publishedNotes.filter((n) => n.kind === 'LOTTERY_ENROLLED').length, 11);
        await auto.maintain(r.id);
        assert.deepEqual(await entries(r.id), publishedEntries);
        assert.deepEqual(await notes(r.id), publishedNotes);
        clock = new Date('2030-11-30T16:00:00Z');
        await auto.maintain(r.id);
        assert.equal((await entries(r.id)).length, 11);
        await change(r, 'leave', 1);
        disabled.delete(f.ids[2]);
        await auto.maintain(r.id);
        assert.equal((await s.get(r.id, f.tokens[1])).mine.state, 'WITHDRAWN');
        assert.equal((await s.get(r.id, f.tokens[2])).mine.state, 'ACTIVE');
        await assert.rejects(
          () => change(r, 'join', 1),
          (e) => e.code === 'FORBIDDEN'
        );
        await auto.maintain(r.id);
        assert.equal((await s.get(r.id, f.tokens[1])).mine.state, 'WITHDRAWN');
        const ns = await notes(r.id);
        assert.equal(ns.filter((n) => n.kind === 'LOTTERY_PUBLISHED' && n.channel === 'QQ').length, 0);
        assert.equal(ns.filter((n) => n.kind === 'LOTTERY_ENROLLED' && n.recipientId === f.ids[1]).length, 1);
        reset();
      }
    );
    await check(
      'qualification rechecked on draw: membership changes and disabled accounts excluded',
      async () => {
        const r = await create();
        for (const i of [1, 2, 3, 4]) await change(r, 'join', i);
        await f.db.account.update({ where: { id: f.ids[2] }, data: { membership: 'FRIEND' } });
        disabled.add(f.ids[3]);
        clock = new Date(r.drawAt);
        const d = await s.maintain(r.id);
        assert.equal(d.result.participants, 2);
        assert.equal(d.result.winners.length, 2);
        assert.ok(d.result.winners.every((w) => [f.ids[1], f.ids[4]].includes(w.accountId)));
        assert.equal(d.result.unassigned, 1);
        await f.db.account.update({ where: { id: f.ids[2] }, data: { membership: 'MEMBER' } });
        reset();
      }
    );
    await check(
      'due boundary blocks both modes and concurrent workers permanently fix unique winners/prize units',
      async () => {
        const r = await create({ audience: 'MEMBER_FRIEND' });
        for (let i = 0; i < 8; i++) await change(r, 'join', i);
        clock = new Date(r.drawAt);
        for (const a of ['join', 'leave', 'cancel'])
          await assert.rejects(
            () => change(r, a, a === 'cancel' ? 0 : 1),
            (e) => e.code === 'CONFLICT'
          );
        const ds = await Promise.all(Array.from({ length: 5 }, () => s.maintain(r.id)));
        for (const d of ds) assert.deepEqual(d.result, ds[0].result);
        const result = ds[0].result;
        assert.equal(new Set(result.winners.map((w) => w.accountId)).size, 3);
        assert.deepEqual(result.winners.map((w) => w.prize).sort(), ['手账本', '明信片', '明信片'].sort());
        const ns = await notes(r.id);
        assert.equal(ns.filter((n) => n.kind === 'LOTTERY_WON').length, 6);
        assert.equal(ns.filter((n) => n.kind === 'LOTTERY_WON' && n.channel === 'IN_APP').length, 3);
        assert.ok(!ns.some((n) => n.kind === 'LOTTERY_LOST'));
        const dto = await s.get(r.id, f.tokens[1]);
        noPrivate(dto);
        assert.ok(dto.result.winners.every((w) => !Object.hasOwn(w, 'accountId')));
        await assert.rejects(() =>
          f.db.$executeRawUnsafe('UPDATE "Lottery" SET "result"=$1::jsonb WHERE "id"=$2', '{}', r.id)
        );
        reset();
      }
    );
    await check(
      'zero participants records no winners; fewer people yield one each and no replacement',
      async () => {
        const zero = await create();
        clock = new Date(zero.drawAt);
        assert.deepEqual((await s.maintain(zero.id)).result.winners, []);
        reset();
        const r = await create();
        await change(r, 'join', 1);
        clock = new Date(r.drawAt);
        const d = await s.maintain(r.id);
        assert.equal(d.result.winners.length, 1);
        assert.equal(d.result.unassigned, 2);
        assert.deepEqual((await s.maintain(r.id)).result, d.result);
        reset();
      }
    );
    await check('notification delivery failure leaves fixed result and retry never draws again', async () => {
      const r = await create();
      await change(r, 'join');
      clock = new Date(r.drawAt);
      const d = await s.maintain(r.id);
      await assert.rejects(() =>
        s.simulateNotifications(async () => {
          throw Error('synthetic notify failure');
        })
      );
      assert.deepEqual((await raw(r.id)).result, d.result);
      assert.ok((await notes(r.id)).some((n) => n.simulatedAt === null));
      await Promise.all([s.simulateNotifications(), s.simulateNotifications()]);
      assert.deepEqual((await raw(r.id)).result, d.result);
      assert.ok((await notes(r.id)).every((n) => n.simulatedAt && n.attempts === 1));
      reset();
    });
    await check(
      'cancel owner only before draw, preserves entries and notifies active participants once',
      async () => {
        const r = await create();
        await change(r, 'join', 1);
        await change(r, 'join', 2);
        await change(r, 'leave', 2);
        await assert.rejects(
          () => change(r, 'cancel', 1),
          (e) => e.code === 'FORBIDDEN'
        );
        const c = cmd();
        assert.equal((await s.change(r.id, 'cancel', c, f.tokens[0])).lottery.state, 'CANCELLED');
        assert.equal((await s.change(r.id, 'cancel', c, f.tokens[0])).replayed, true);
        assert.equal((await entries(r.id)).length, 2);
        assert.deepEqual(
          (await notes(r.id)).filter((n) => n.kind === 'LOTTERY_CANCELLED').map((n) => n.recipientId),
          [f.ids[1]]
        );
        assert.equal((await s.maintain(r.id)).state, 'CANCELLED');
      }
    );
    await check(
      'monthly threshold includes Nth day, month-end AUTO, single winner unweighted, no historical notices',
      async () => {
        const r = await create({
          kind: 'MONTHLY',
          mode: 'AUTO',
          month: '2030-11',
          minDays: 12,
          prizes: [{ name: '汉堡', quantity: 1 }],
          drawAt: '2030-12-01T20:00:00+08:00'
        });
        await seedMonth(f.db, [f.ids[1]], '2030-11', 11);
        await seedMonth(f.db, [f.ids[2]], '2030-11', 12);
        await seedMonth(f.db, [f.ids[3]], '2030-11', 30);
        assert.equal((await notes(r.id)).length, 0);
        clock = new Date('2030-11-30T15:59:59Z');
        await s.maintain(r.id);
        assert.equal((await entries(r.id)).length, 0);
        clock = new Date('2030-11-30T16:00:00Z');
        await s.maintain(r.id);
        assert.equal((await entries(r.id)).length, 2);
        assert.equal((await s.get(r.id, f.tokens[1])).mine.eligible, false);
        await seedMonth(f.db, [f.ids[1]], '2030-11', 12);
        await s.maintain(r.id);
        assert.equal((await entries(r.id)).length, 3);
        await change(r, 'leave', 2);
        await s.maintain(r.id);
        clock = new Date(r.drawAt);
        const d = await s.maintain(r.id);
        assert.equal(d.result.participants, 2);
        assert.equal(d.result.winners.length, 1);
        assert.ok(!(await notes(r.id)).some((n) => n.kind === 'LOTTERY_PUBLISHED'));
        reset();
      }
    );
    await check('monthly accepts multiple prize entries and quantities like ordinary lotteries', async () => {
      const b = input({
        kind: 'MONTHLY',
        mode: 'AUTO',
        month: '2030-11',
        minDays: 12,
        drawAt: '2030-12-01T00:00:00+08:00'
      });
      const result = await s.create(b, f.tokens[0]);
      assert.deepEqual(result.lottery.prizes, b.prizes);
      assert.equal(
        result.lottery.prizes.reduce((n, p) => n + p.quantity, 0),
        3
      );
    });
    await check('business-lock wait revalidates expiry, membership and exact draw time', async () => {
      let r = await create();
      let heldResult = await held(
        'lottery:write',
        () => change(r, 'join', 1),
        async () => {
          clock = new Date(r.drawAt);
        }
      );
      assert.equal(heldResult.error?.code, 'CONFLICT');
      assert.equal((await entries(r.id)).length, 0);
      reset();
      r = await create();
      heldResult = await held(
        'lottery:write',
        () => change(r, 'join', 1),
        async () => {
          await f.db.account.update({ where: { id: f.ids[1] }, data: { membership: 'FRIEND' } });
        }
      );
      assert.equal(heldResult.error?.code, 'FORBIDDEN');
      await f.db.account.update({ where: { id: f.ids[1] }, data: { membership: 'MEMBER' } });
      await f.db.accountSession.updateMany({
        where: { accountId: f.ids[1] },
        data: { expiresAt: new Date(clock.getTime() + 1000) }
      });
      heldResult = await held(
        'lottery:write',
        () => change(r, 'join', 1),
        async () => {
          clock = new Date(clock.getTime() + 1000);
        }
      );
      assert.equal(heldResult.error?.code, 'UNAUTHENTICATED');
      assert.equal((await entries(r.id)).length, 0);
      await f.db.accountSession.updateMany({
        where: { accountId: f.ids[1] },
        data: { expiresAt: new Date('2035-01-01') }
      });
      reset();
    });
    await check('write wait after mutation still rolls back on expired session', async () => {
      const r = await create();
      await f.db.accountSession.updateMany({
        where: { accountId: f.ids[1] },
        data: { expiresAt: new Date(clock.getTime() + 1000) }
      });
      await f.db.$executeRawUnsafe(
        `CREATE FUNCTION lottery_test_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('lottery-test-insert',0)); RETURN NEW; END $$`
      );
      await f.db.$executeRawUnsafe(
        'CREATE TRIGGER lottery_test_wait BEFORE INSERT ON "LotteryCommand" FOR EACH ROW EXECUTE FUNCTION lottery_test_wait()'
      );
      try {
        const result = await held(
          'lottery-test-insert',
          () => change(r, 'join', 1),
          async () => {
            clock = new Date(clock.getTime() + 1000);
          }
        );
        assert.equal(result.error?.code, 'UNAUTHENTICATED');
        assert.equal((await entries(r.id)).length, 0);
      } finally {
        await f.db.$executeRawUnsafe('DROP TRIGGER lottery_test_wait ON "LotteryCommand"');
        await f.db.$executeRawUnsafe('DROP FUNCTION lottery_test_wait()');
        await f.db.accountSession.updateMany({
          where: { accountId: f.ids[1] },
          data: { expiresAt: new Date('2035-01-01') }
        });
        reset();
      }
    });
    await check(
      'pool selection deduplicates people, uses unbiased shuffles and no checkin weight',
      async () => {
        const people = f.ids
          .slice(0, 4)
          .map((id) => ({ id, displayName: id, membership: 'MEMBER', active: true }));
        let seed = 1;
        const random = (max) => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return Math.floor((seed / 4294967296) * max);
        };
        const totals = new Map();
        for (let n = 0; n < 10000; n++) {
          const w = selectWinners([...people, people[0]], [{ name: 'gift', quantity: 1 }], random)[0];
          totals.set(w.accountId, (totals.get(w.accountId) || 0) + 1);
        }
        assert.equal(totals.size, 4);
        assert.ok([...totals.values()].every((n) => n > 2200 && n < 2800));
      }
    );
  } finally {
    await f.cleanup();
  }
});
