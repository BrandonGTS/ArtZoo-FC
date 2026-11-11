// 到场登记（真实 PostgreSQL）：只有发起者在活动时间内登记；缺席记 2 点，时间内改回到场撤销；
// 并发登记与锁等待后的会话复查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, noPrivate } from '../activities/support/pg-fixture.mjs';
import { input } from './support/activity-input.mjs';

test('到场登记：真实 PostgreSQL', async (t) => {
  const f = await fixture();
  let now = new Date('2030-06-01T10:00:00Z');
  const check = (name, fn) => t.test(name, fn);
  const rejects = (fn, code) => assert.rejects(fn, (e) => e.code === code);
  try {
    const { AccountService } = await import('../../apps/web/server/auth/service.ts');
    const { ActivityService } = await import('../../apps/web/server/activities/service.ts');
    const { ActivityAttendanceService } = await import('../../apps/web/server/activities/attendance.ts');
    const { mainlandChinaPhone, unavailableSms } = await import('../../apps/web/server/auth/ports.ts');
    const auth = new AccountService(f.db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      environment: 'test',
      now: () => now
    });
    const basic = new ActivityService(auth),
      attendance = new ActivityAttendanceService(auth),
      token = (i) => f.tokens[i];
    await f.db.account.update({ where: { id: f.ids[2] }, data: { adminRole: 'ADMIN' } });
    async function activity(owner = 0, member = 1) {
      now = new Date('2030-06-01T10:00:00Z');
      const a = (
        await basic.create(
          input({
            idempotencyKey: randomUUID(),
            category: 'SOCIAL',
            dutySelection: null,
            seats: [{ kind: 'ANY' }]
          }),
          token(owner)
        )
      ).activity;
      await basic.register(a.id, { seatId: a.seats[0].id, job: null }, token(member));
      const reg = await f.db.activityRegistration.findFirstOrThrow({
        where: { activityId: a.id, accountId: f.ids[member], status: 'ACTIVE' }
      });
      return { a, reg, owner, member };
    }
    const rec = (v, status = 'ABSENT', revision = 0) => ({
      idempotencyKey: randomUUID(),
      registrationId: v.reg.id,
      status,
      expectedAttendanceRevision: revision
    });
    const appeal = (v, revision = 1) => ({
      idempotencyKey: randomUUID(),
      registrationId: v.reg.id,
      requestedStatus: 'PRESENT',
      reason: 'Synthetic correction',
      expectedAttendanceRevision: revision
    });
    const decision = (revision = 1) => ({
      idempotencyKey: randomUUID(),
      expectedAttendanceRevision: revision,
      expectedAppealRevision: 0,
      decision: 'APPROVE',
      reason: 'Synthetic verified result'
    });
    const v = await activity();
    await f.db.account.update({ where: { id: f.ids[1] }, data: { activityPoints: 1 } });
    await check('anonymous and other actor cannot record before start or impersonate organizer', async () => {
      await rejects(() => attendance.attendance(v.a.id), 'UNAUTHENTICATED');
      await rejects(() => attendance.record(v.a.id, rec(v), token(1)), 'FORBIDDEN');
      await rejects(() => attendance.record(v.a.id, rec(v), token(2)), 'FORBIDDEN');
      await rejects(() => attendance.record(v.a.id, rec(v), token(0)), 'FORBIDDEN');
    });
    await check(
      'exact start accepts concurrent identical absence once with one grant and one command',
      async () => {
        now = new Date(v.a.startsAt);
        const b = rec(v),
          out = await Promise.all([
            attendance.record(v.a.id, b, token(0)),
            attendance.record(v.a.id, b, token(0))
          ]);
        assert.equal(out.filter((x) => !x.replayed).length, 1);
        assert.equal(
          await f.db.activityPenalty.count({ where: { registrationId: v.reg.id, reason: 'NO_SHOW' } }),
          1
        );
        assert.equal((await f.db.account.findUniqueOrThrow({ where: { id: f.ids[1] } })).activityPoints, 3);
      }
    );
    await check('database rejects wrong absence points and external correction routes', async () => {
      await assert.rejects(
        () =>
          f.db.activityPenalty.create({
            data: {
              eventKey: randomUUID(),
              accountId: f.ids[1],
              activityId: v.a.id,
              registrationId: v.reg.id,
              reason: 'NO_SHOW',
              points: 1
            }
          }),
        (e) => String(e.message).includes('ActivityPenalty_points_check')
      );
      await assert.rejects(
        () =>
          f.db.activityOutbox.create({
            data: {
              eventKey: randomUUID(),
              activityId: v.a.id,
              registrationId: v.reg.id,
              kind: 'ACTIVITY_SCORE_CORRECTED',
              channel: 'QQ',
              recipientId: f.ids[1]
            }
          }),
        (e) => String(e.message).includes('ActivityOutbox_route_check')
      );
    });
    await check(
      'stale correction rejects and current correction retains original unrelated point',
      async () => {
        await rejects(() => attendance.record(v.a.id, rec(v, 'PRESENT', 0), token(0)), 'CONFLICT');
        await attendance.record(v.a.id, rec(v, 'PRESENT', 1), token(0));
        assert.equal((await f.db.account.findUniqueOrThrow({ where: { id: f.ids[1] } })).activityPoints, 1);
        assert.equal(
          (await f.db.activityRegistration.findUniqueOrThrow({ where: { id: v.reg.id } }))
            .attendancePenaltyId,
          null
        );
        assert.equal(
          await f.db.activityPenalty.count({
            where: { registrationId: v.reg.id, reversedAt: { not: null } }
          }),
          1
        );
      }
    );
    await check(
      'repeated absence-present corrections retain one point and strictly ordered score ledger',
      async () => {
        await attendance.record(v.a.id, rec(v, 'ABSENT', 2), token(0));
        await attendance.record(v.a.id, rec(v, 'PRESENT', 3), token(0));
        assert.equal((await f.db.account.findUniqueOrThrow({ where: { id: f.ids[1] } })).activityPoints, 1);
        const events = await f.db.activityScoreChange.findMany({
          where: { accountId: f.ids[1] },
          orderBy: { sequence: 'asc' }
        });
        assert.equal(new Set(events.map((e) => String(e.sequence))).size, events.length);
        assert.equal(events.filter((e) => e.reason === 'PENALTY_REVERSED').length, 2);
      }
    );
    const pending = await activity(3, 4);
    now = new Date(pending.a.endsAt);
    await check(
      'exact cutoff never creates missing attendance or permits a fabricated late appeal',
      async () => {
        await rejects(() => attendance.record(pending.a.id, rec(pending, 'PRESENT'), token(3)), 'FORBIDDEN');
        await rejects(() => attendance.appeal(pending.a.id, appeal(pending, 0), token(4)), 'FORBIDDEN');
        assert.equal(
          (await f.db.activityRegistration.findUniqueOrThrow({ where: { id: pending.reg.id } }))
            .attendanceStatus,
          null
        );
        assert.equal(await f.db.activityPenalty.count({ where: { registrationId: pending.reg.id } }), 0);
      }
    );
    await check('waiting for shared activity lock across cutoff rejects at locked current time', async () => {
      now = new Date('2030-06-01T13:59:59.999Z');
      let release, ready;
      const waiting = new Promise((r) => (ready = r)),
        unblock = new Promise((r) => (release = r));
      const holder = f.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`activity:${pending.a.id}`},0))::text`;
          ready();
          await unblock;
        },
        { timeout: 10000 }
      );
      await waiting;
      const command = attendance.record(pending.a.id, rec(pending, 'PRESENT'), token(3)).then(
        () => null,
        (error) => error
      );
      try {
        for (let i = 0; i < 100; i++) {
          const rows = await f.db
            .$queryRaw`SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted`;
          if (rows[0].count > 0) break;
          if (i === 99) throw new Error('No deterministic lock waiter');
          await new Promise((r) => setTimeout(r, 10));
        }
        now = new Date(pending.a.endsAt);
      } finally {
        release();
      }
      await holder;
      assert.equal((await command)?.code, 'FORBIDDEN');
      assert.equal(
        (await f.db.activityRegistration.findUniqueOrThrow({ where: { id: pending.reg.id } }))
          .attendanceStatus,
        null
      );
    });
    const n = await activity(6, 7);
    await f.db.account.update({ where: { id: f.ids[7] }, data: { activityPoints: 1 } });
    now = new Date(n.a.startsAt);
    await attendance.record(n.a.id, rec(n), token(6));
    now = new Date('2030-06-09T12:00:00Z');
    await check(
      'self post-deadline appeal retains restriction, hides reason from others and blocks duplicate pending',
      async () => {
        await attendance.appeal(n.a.id, appeal(n), token(7));
        await rejects(() => attendance.appeal(n.a.id, appeal(n), token(7)), 'CONFLICT');
        await rejects(() => attendance.appeal(n.a.id, appeal(n), token(6)), 'FORBIDDEN');
        const own = await attendance.attendance(n.a.id, token(7)),
          other = await attendance.attendance(n.a.id, token(6));
        assert.ok(own.items[0].appeal);
        assert.equal(other.items[0].appeal, null);
        noPrivate(own);
        assert.equal((await f.db.account.findUniqueOrThrow({ where: { id: f.ids[7] } })).activityPoints, 3);
      }
    );
    const a = await f.db.activityAttendanceAppeal.findFirstOrThrow({ where: { registrationId: n.reg.id } });
    await check(
      'non-admin decision rejects; concurrent repeated admin approval reverses exactly once after decay',
      async () => {
        await rejects(() => attendance.decide(a.id, decision(), token(6)), 'FORBIDDEN');
        const b = decision(),
          out = await Promise.all([
            attendance.decide(a.id, b, token(2)),
            attendance.decide(a.id, b, token(2))
          ]);
        assert.equal(out.filter((x) => !x.replayed).length, 1);
        const account = await f.db.account.findUniqueOrThrow({ where: { id: f.ids[7] } });
        // Absence reversed; the corrected PRESENT record also earns the normal completion credit.
        assert.equal(account.activityPoints, 0);
        assert.equal(account.activityDecayAt, null);
        assert.equal(
          (await f.db.activityRegistration.findUniqueOrThrow({ where: { id: n.reg.id } })).attendanceStatus,
          'PRESENT'
        );
        assert.equal(
          await f.db.activityOutbox.count({
            where: { registrationId: n.reg.id, kind: 'ATTENDANCE_APPEAL_RESULT' }
          }),
          1
        );
      }
    );
    await check(
      'absence grants and private simulated notices remain durable and previous records are retained',
      async () => {
        const penalties = await f.db.activityPenalty.findMany({ where: { registrationId: n.reg.id } });
        assert.equal(penalties.length, 1);
        assert.ok(penalties[0].reversedAt);
        assert.equal(await f.db.activityRegistration.count({ where: { id: n.reg.id } }), 1);
        const events = await f.db.activityOutbox.findMany({
          where: {
            registrationId: n.reg.id,
            kind: { in: ['ACTIVITY_PENALTY', 'ACTIVITY_SCORE_CORRECTED', 'ATTENDANCE_APPEAL_RESULT'] }
          },
          include: { mockDelivery: true }
        });
        assert.equal(events.length, 3);
        assert.ok(
          events.every((e) => e.channel === 'IN_APP' && e.recipientId === f.ids[7] && e.mockDelivery)
        );
      }
    );
    const x = await activity(8, 9),
      y = await activity(9, 8);
    now = new Date(x.a.startsAt);
    await check(
      'opposite organizer-recipient score writes in two activities finish without account/activity lock cycle',
      async () => {
        const out = await Promise.all([
          attendance.record(x.a.id, rec(x), token(8)),
          attendance.record(y.a.id, rec(y), token(9))
        ]);
        assert.equal(out.length, 2);
        for (const index of [8, 9])
          assert.equal(
            (await f.db.account.findUniqueOrThrow({ where: { id: f.ids[index] } })).activityPoints,
            2
          );
      }
    );
    await check('admin role is rechecked before listing appeals', async () => {
      await f.db.account.update({ where: { id: f.ids[2] }, data: { adminRole: 'NONE' } });
      await rejects(() => attendance.appeals(new URL('http://local'), token(2)), 'FORBIDDEN');
    });
  } finally {
    await f.cleanup();
  }
});
