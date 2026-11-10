// 抽奖截止（真实 PostgreSQL）：参加截止、资格变化与月度抽奖的重放。
import { test } from 'node:test';
import { seedMonth, monthCounter } from './support/monthly-fixture.mjs';
import { withFixtureSnapshot } from './support/snapshot-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from '../activities/support/pg-fixture.mjs';

test('抽奖截止与资格：真实 PostgreSQL', async (t) => {
  const f = await fixture();
  try {
    const { AccountService } = await import('../../apps/web/server/auth/service.ts'),
      { LotteryService } = await import('../../apps/web/server/lottery/service.ts'),
      { mainlandChinaPhone, unavailableSms } = await import('../../apps/web/server/auth/ports.ts');
    let clock = new Date('2030-10-01'),
      qualified = new Set([f.ids[0], f.ids[1]]);
    const auth = new AccountService(f.db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      environment: 'test',
      now: () => clock
    });
    const ports = { accountActive: async (_, id) => qualified.has(id) };
    const s = new LotteryService(auth, withFixtureSnapshot(ports)),
      body = () => ({
        idempotencyKey: randomUUID(),
        title: '截止资格',
        kind: 'ORDINARY',
        mode: 'MANUAL',
        audience: 'MEMBER',
        month: null,
        minDays: null,
        prizes: [{ name: 'gift', quantity: 1 }],
        drawAt: '2030-10-20T20:00:00+08:00'
      });
    let b = body(),
      r = (await s.create(b, f.tokens[0])).lottery;
    await s.change(r.id, 'join', { idempotencyKey: randomUUID() }, f.tokens[1]);
    clock = new Date(r.drawAt);
    qualified.add(f.ids[2]);
    await assert.rejects(
      () => new LotteryService(auth, ports).maintain(r.id),
      (e) => e.code === 'SERVICE_UNAVAILABLE'
    );
    assert.equal((await s.create(b, f.tokens[0])).replayed, true);
    console.log(
      'PASS CUTOFF missing as-of-T adapter leaves result unset; successful create replays across cutoff'
    );
    clock = new Date('2030-10-01');
    qualified.delete(f.ids[2]);
    b = {
      ...body(),
      kind: 'MONTHLY',
      mode: 'AUTO',
      month: '2030-11',
      minDays: 2,
      drawAt: '2030-12-01T20:00:00+08:00'
    };
    await seedMonth(f.db, f.ids.slice(0, 4), '2030-11', 2);
    ports.countMonth = monthCounter(f.db, '2030-11');
    r = (await new LotteryService(auth, withFixtureSnapshot(ports)).create(b, f.tokens[0])).lottery;
    qualified.add(f.ids[2]);
    qualified.add(f.ids[3]);
    clock = new Date(r.drawAt);
    const exact = new LotteryService(auth, {
      ...ports,
      drawEligibilityAt: async (tx, request) => {
        const result = await withFixtureSnapshot(ports).drawEligibilityAt(tx, request);
        return {
          ...result,
          accounts: result.accounts.filter((a) => [f.ids[0], f.ids[1], f.ids[2]].includes(a.identity.id))
        };
      }
    });
    assert.equal((await exact.maintain(r.id)).result.participants, 3);
    clock = new Date('2030-10-01');
    b = {
      ...body(),
      kind: 'MONTHLY',
      mode: 'AUTO',
      month: '2030-11',
      minDays: 17,
      prizes: [{ name: 'gift', quantity: 1 }],
      drawAt: '2030-12-01T20:00:00+08:00'
    };
    const monthly = new LotteryService(auth, { ...ports, countMonth: monthCounter(f.db, '2030-11') });
    await monthly.create(b, f.tokens[0]);
    clock = new Date('2030-11-01');
    assert.equal((await monthly.create(b, f.tokens[0])).replayed, true);
  } finally {
    await f.cleanup();
  }
});
