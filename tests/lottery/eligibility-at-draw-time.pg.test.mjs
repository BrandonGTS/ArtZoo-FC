// 抽奖资格（真实 PostgreSQL）：按设定开奖时刻的历史记录判断资格，处理时刻的变化不影响结果；
// 记录不完整时拒绝开奖。
import { test } from 'node:test';
import { seedMonth, monthCounter } from './support/monthly-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from '../activities/support/pg-fixture.mjs';

test('抽奖资格按开奖时刻判断：真实 PostgreSQL', async (t) => {
  const f = await fixture();
  let clock = new Date('2030-10-01');
  try {
    const { AccountService } = await import('../../apps/web/server/auth/service.ts'),
      { LotteryService } = await import('../../apps/web/server/lottery/service.ts'),
      { mainlandChinaPhone, unavailableSms } = await import('../../apps/web/server/auth/ports.ts');
    const auth = new AccountService(f.db, {
        phone: mainlandChinaPhone,
        sms: unavailableSms,
        environment: 'test',
        now: () => clock
      }),
      base = new LotteryService(auth),
      body = (extra = {}) => ({
        idempotencyKey: randomUUID(),
        title: '历史资格快照',
        kind: 'ORDINARY',
        mode: 'MANUAL',
        audience: 'MEMBER',
        month: null,
        minDays: null,
        prizes: [{ name: '礼物', quantity: 10 }],
        drawAt: '2030-10-20T20:00:00+08:00',
        ...extra
      }),
      check = (name, fn) => t.test(name, fn);
    const records = (ids) =>
      ids.map((id) => ({
        identity: { id, displayName: '开奖时昵称-' + f.ids.indexOf(id), membership: 'MEMBER', active: true },
        registeredAt: new Date('2029-01-01'),
        monthCount: null
      }));
    const sealed = (row, accounts) => ({ at: new Date(row.drawAt), complete: true, accounts });
    const adapter = (snapshot) => async (_tx, request) => {
      assert.equal(request.lottery.drawAt.toISOString(), snapshot.at.toISOString());
      return {
        ...snapshot,
        accounts: request.accountIds
          ? snapshot.accounts.filter((a) => request.accountIds.includes(a.identity.id))
          : snapshot.accounts
      };
    };
    const raw = (id) =>
      f.db.$queryRawUnsafe('SELECT "state","result" FROM "Lottery" WHERE "id"=$1', id).then((x) => x[0]);
    await check(
      'delayed MANUAL uses membership/disabled/nickname at T, never current facts at R',
      async () => {
        const row = (await base.create(body(), f.tokens[0])).lottery;
        for (const i of [1, 2, 3, 4, 6])
          await base.change(row.id, 'join', { idempotencyKey: randomUUID() }, f.tokens[i]);
        const facts = records([1, 2, 3, 4, 6].map((i) => f.ids[i]));
        facts[1].identity.membership = 'FRIEND';
        facts[2].identity.active = false;
        const snapshot = sealed(row, facts);
        // These are deliberately incompatible execution-time facts. They cannot affect the sealed T cohort.
        for (const i of [1, 2, 3, 4, 6])
          await f.db.account.update({
            where: { id: f.ids[i] },
            data: { membership: 'FRIEND', displayName: '执行时改名-' + i }
          });
        clock = new Date(Date.parse(row.drawAt) + 60000);
        let currentReads = 0;
        const late = new LotteryService(auth, {
          drawEligibilityAt: adapter(snapshot),
          accountActive: async () => {
            currentReads++;
            return false;
          },
          countMonth: async () => {
            throw Error('current count must not be used');
          }
        });
        const d = await late.maintain(row.id);
        assert.equal(currentReads, 0);
        assert.equal(d.result.participants, 3);
        assert.deepEqual(
          d.result.winners.map((w) => w.accountId).sort(),
          [1, 4, 6].map((i) => f.ids[i]).sort()
        );
        assert.ok(d.result.winners.every((w) => w.gameNickname.startsWith('开奖时昵称')));
        assert.equal(d.result.drawnAt, row.drawAt);
        assert.equal(d.result.processedAt, clock.toISOString());
        for (const i of [1, 2, 3, 4, 6])
          await f.db.account.update({
            where: { id: f.ids[i] },
            data: { membership: 'MEMBER', displayName: '已恢复-' + i }
          });
        clock = new Date('2030-10-01');
      }
    );
    await check(
      'AUTO complete snapshot fills last-tick gap, excludes post-T newcomer, preserves permanent optout and rejects reentry',
      async () => {
        await seedMonth(f.db, f.ids, '2030-11', 12);
        const restricted = new LotteryService(auth, {
            accountActive: async (_, id) => [f.ids[0], f.ids[1]].includes(id),
            countMonth: monthCounter(f.db, '2030-11')
          }),
          row = (
            await restricted.create(
              body({
                kind: 'MONTHLY',
                mode: 'AUTO',
                month: '2030-11',
                minDays: 12,
                drawAt: '2030-12-01T20:00:00+08:00'
              }),
              f.tokens[0]
            )
          ).lottery;
        clock = new Date('2030-11-30T16:00:00Z');
        await restricted.maintain(row.id);
        await base.change(row.id, 'leave', { idempotencyKey: randomUUID() }, f.tokens[1]);
        await base.change(row.id, 'leave', { idempotencyKey: randomUUID() }, f.tokens[4]);
        await assert.rejects(
          () => base.change(row.id, 'join', { idempotencyKey: randomUUID() }, f.tokens[4]),
          (e) => e.code === 'FORBIDDEN'
        );
        const snapshot = sealed(
          row,
          records([0, 1, 2, 4, 6].map((i) => f.ids[i])).map((r) => ({ ...r, monthCount: 12 }))
        );
        clock = new Date(Date.parse(row.drawAt) + 86400000);
        const d = await new LotteryService(auth, { drawEligibilityAt: adapter(snapshot) }).maintain(row.id);
        assert.deepEqual(
          d.result.winners.map((w) => w.accountId).sort(),
          [0, 2, 6].map((i) => f.ids[i]).sort()
        );
        assert.equal(d.result.participants, 3);
        assert.ok(
          !d.result.winners.some(
            (w) => w.accountId === f.ids[1] || w.accountId === f.ids[3] || w.accountId === f.ids[4]
          )
        );
        clock = new Date('2030-10-01');
      }
    );
    await check(
      'MONTHLY delayed draw uses sealed month count at T, Nth day included without current-count fallback',
      async () => {
        const monthly = new LotteryService(auth, { countMonth: monthCounter(f.db, '2030-11') }),
          row = (
            await monthly.create(
              body({
                kind: 'MONTHLY',
                mode: 'AUTO',
                month: '2030-11',
                minDays: 12,
                prizes: [{ name: '月礼', quantity: 1 }],
                drawAt: '2030-12-01T20:00:00+08:00'
              }),
              f.tokens[0]
            )
          ).lottery;
        const facts = records([f.ids[1], f.ids[2]]);
        facts[0].monthCount = 11;
        facts[1].monthCount = 12;
        const snapshot = sealed(row, facts);
        clock = new Date('2030-12-04T12:00:00Z');
        const d = await new LotteryService(auth, {
          drawEligibilityAt: adapter(snapshot),
          countMonth: async () => {
            throw Error('execution-time count forbidden');
          }
        }).maintain(row.id);
        assert.equal(d.result.participants, 1);
        assert.equal(d.result.winners[0].accountId, f.ids[2]);
        clock = new Date('2030-10-01');
      }
    );
    await check(
      'missing/incomplete/wrong-time/duplicate/missing manual/future registration snapshot fails closed',
      async () => {
        const row = (await base.create(body(), f.tokens[0])).lottery;
        await base.change(row.id, 'join', { idempotencyKey: randomUUID() }, f.tokens[1]);
        clock = new Date(Date.parse(row.drawAt) + 60000);
        const good = sealed(row, records([f.ids[1]]));
        const variants = [
          undefined,
          { ...good, complete: false },
          { ...good, at: clock },
          { ...good, accounts: [] },
          { ...good, accounts: [...good.accounts, ...good.accounts] },
          { ...good, accounts: [{ ...good.accounts[0], registeredAt: new Date(row.drawAt) }] }
        ];
        for (const snapshot of variants) {
          const service = new LotteryService(
            auth,
            snapshot ? { drawEligibilityAt: async () => snapshot } : {}
          );
          await assert.rejects(
            () => service.maintain(row.id),
            (e) => e.code === 'SERVICE_UNAVAILABLE'
          );
          assert.deepEqual(await raw(row.id), { state: 'OPEN', result: null });
        }
        clock = new Date('2030-10-01');
      }
    );
    await check(
      'fixed result replays after adapter/state changes and does not ask history twice',
      async () => {
        const row = (await base.create(body(), f.tokens[0])).lottery;
        await base.change(row.id, 'join', { idempotencyKey: randomUUID() }, f.tokens[1]);
        const snapshot = sealed(row, records([f.ids[1]]));
        clock = new Date(Date.parse(row.drawAt) + 1000);
        const d = await new LotteryService(auth, { drawEligibilityAt: adapter(snapshot) }).maintain(row.id);
        clock = new Date(+clock + 86400000);
        assert.deepEqual(
          (
            await new LotteryService(auth, {
              drawEligibilityAt: async () => {
                throw Error('must not read after fixed');
              }
            }).maintain(row.id)
          ).result,
          d.result
        );
      }
    );
  } finally {
    await f.cleanup();
  }
});
