// 正常完成（真实 PostgreSQL）：到场的人减 1 点、最低 0；每人每场只结算一次；不满足条件的活动不结算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, noPrivate } from '../activities/support/pg-fixture.mjs';
import { input } from './support/activity-input.mjs';

test('正常完成减分：真实 PostgreSQL', async (t) => {
  const f = await fixture();
  let now = new Date('2030-06-01T10:00:00Z');
  const check = (name, fn) => t.test(name, fn);
  try {
    const { AccountService } = await import('../../apps/web/server/auth/service.ts');
    const { ActivityService } = await import('../../apps/web/server/activities/service.ts');
    const { ActivityAttendanceService } = await import('../../apps/web/server/activities/attendance.ts');
    const { mainlandChinaPhone, unavailableSms } = await import('../../apps/web/server/auth/ports.ts');
    const { processActivityCompletions } = await import('../../packages/db/src/activity-completion.ts');
    const auth = new AccountService(f.db, {
        phone: mainlandChinaPhone,
        sms: unavailableSms,
        environment: 'test',
        now: () => now
      }),
      basic = new ActivityService(auth),
      attendance = new ActivityAttendanceService(auth),
      token = (i) => f.tokens[i];
    await f.db.account.update({ where: { id: f.ids[2] }, data: { adminRole: 'ADMIN' } });
    const balance = (i) =>
      f.db.account.findUniqueOrThrow({
        where: { id: f.ids[i] },
        select: { activityPoints: true, activityDecayAt: true }
      });
    async function activity(member, status = 'PRESENT', points = 0, { legacy = false, capacity = 1 } = {}) {
      now = new Date('2030-06-01T10:00:00Z');
      const a = (
        await basic.create(
          input({
            idempotencyKey: randomUUID(),
            category: 'SOCIAL',
            dutySelection: null,
            seats: Array.from({ length: capacity }, () => ({ kind: 'ANY' }))
          }),
          token(0)
        )
      ).activity;
      await basic.register(a.id, { seatId: a.seats[0].id, job: null }, token(member));
      if (legacy) await f.db.activity.update({ where: { id: a.id }, data: { completionEnabledAt: null } });
      await f.db.account.update({
        where: { id: f.ids[member] },
        data: {
          activityPoints: points,
          activityDecayAt: points >= 3 ? new Date('2030-06-08T12:00:00Z') : null
        }
      });
      const reg = await f.db.activityRegistration.findFirstOrThrow({
        where: { activityId: a.id, accountId: f.ids[member], status: 'ACTIVE' }
      });
      now = new Date(a.startsAt);
      if (status)
        await attendance.record(
          a.id,
          { idempotencyKey: randomUUID(), registrationId: reg.id, status, expectedAttendanceRevision: 0 },
          token(0)
        );
      now = new Date(a.endsAt);
      return { a, reg, member };
    }
    async function correction(v, status) {
      const reg = await f.db.activityRegistration.findUniqueOrThrow({ where: { id: v.reg.id } });
      await attendance.appeal(
        v.a.id,
        {
          idempotencyKey: randomUUID(),
          registrationId: reg.id,
          requestedStatus: status,
          expectedAttendanceRevision: reg.attendanceRevision,
          reason: 'Synthetic completion correction'
        },
        token(v.member)
      );
      const appeal = await f.db.activityAttendanceAppeal.findFirstOrThrow({
        where: { registrationId: reg.id, status: 'PENDING' }
      });
      const body = {
        idempotencyKey: randomUUID(),
        expectedAttendanceRevision: reg.attendanceRevision,
        expectedAppealRevision: 0,
        decision: 'APPROVE',
        reason: 'Synthetic verified result'
      };
      return { appeal, body, run: () => attendance.decide(appeal.id, body, token(2)) };
    }
    const v = await activity(1, 'PRESENT', 3);
    await check('strict end boundary and concurrent workers settle existing registration once', async () => {
      assert.equal(await processActivityCompletions(f.db, new Date(now.getTime() - 1)), 0);
      const out = await Promise.all([
        processActivityCompletions(f.db, now),
        processActivityCompletions(f.db, now)
      ]);
      assert.equal(
        out.reduce((a, b) => a + b, 0),
        1
      );
      assert.equal((await balance(1)).activityPoints, 2);
      assert.equal((await balance(1)).activityDecayAt, null);
      assert.equal(
        await f.db.activityCompletion.count({ where: { activityId: v.a.id, accountId: f.ids[1] } }),
        1
      );
      assert.equal(
        await f.db.activityScoreChange.count({ where: { accountId: f.ids[1], reason: 'NORMAL_COMPLETION' } }),
        1
      );
      const events = await f.db.activityOutbox.findMany({
        where: { registrationId: v.reg.id, kind: 'ACTIVITY_COMPLETED' },
        include: { mockDelivery: true }
      });
      assert.equal(events.length, 1);
      assert.ok(events.every((e) => e.channel === 'IN_APP' && e.recipientId === f.ids[1] && e.mockDelivery));
    });
    await check('database unique indexes and private completion route are enforced', async () => {
      const c = await f.db.activityCompletion.findUniqueOrThrow({ where: { registrationId: v.reg.id } });
      await assert.rejects(
        () => f.db.activityCompletion.create({ data: { ...c, id: randomUUID() } }),
        (e) => e.code === 'P2002'
      );
      await assert.rejects(
        () =>
          f.db.activityOutbox.create({
            data: {
              eventKey: randomUUID(),
              activityId: v.a.id,
              registrationId: v.reg.id,
              recipientId: f.ids[1],
              kind: 'ACTIVITY_COMPLETED',
              channel: 'QQ'
            }
          }),
        (e) => String(e.message).includes('ActivityOutbox_route_check')
      );
    });
    await check(
      'admin corrects the same credited completion and successful repeated decision remains a replay',
      async () => {
        const first = await correction(v, 'ABSENT');
        await first.run();
        assert.equal((await balance(1)).activityPoints, 5);
        assert.equal((await first.run()).replayed, true);
        const second = await correction(v, 'PRESENT');
        await second.run();
        assert.equal((await balance(1)).activityPoints, 2);
        assert.equal(await f.db.activityCompletion.count({ where: { registrationId: v.reg.id } }), 1);
        assert.equal(
          await f.db.activityScoreChange.count({
            where: { accountId: f.ids[1], reason: 'NORMAL_COMPLETION' }
          }),
          1
        );
        assert.equal(
          (await f.db.activityCompletion.findUniqueOrThrow({ where: { registrationId: v.reg.id } })).active,
          true
        );
      }
    );
    const zero = await activity(3, 'PRESENT', 0);
    await processActivityCompletions(f.db, now);
    await check('zero-floor nominal credit reverses without manufacturing an extra point', async () => {
      await (await correction(zero, 'ABSENT')).run();
      assert.equal((await balance(3)).activityPoints, 2);
      await (await correction(zero, 'PRESENT')).run();
      assert.equal((await balance(3)).activityPoints, 0);
      assert.equal(
        (
          await f.db.activityScoreChange.findFirstOrThrow({
            where: { accountId: f.ids[3], reason: 'NORMAL_COMPLETION' }
          })
        ).delta,
        0
      );
    });
    const limit = await activity(4, 'PRESENT', 1);
    await processActivityCompletions(f.db, now);
    await check(
      'credit removal can restore exactly-three restriction and penalty notice uses final balance',
      async () => {
        await (await correction(limit, 'ABSENT')).run();
        assert.equal((await balance(4)).activityPoints, 3);
        assert.ok((await balance(4)).activityDecayAt);
        const latest = await f.db.activityScoreChange.findFirstOrThrow({
          where: { accountId: f.ids[4] },
          orderBy: { sequence: 'desc' }
        });
        assert.ok(latest.notices.includes('RESTRICTION_STARTED'));
        const notice = await f.db.activityOutbox.findFirstOrThrow({
          where: { registrationId: limit.reg.id, kind: 'ACTIVITY_PENALTY' }
        });
        assert.equal(notice.payload.totalPoints, 3);
      }
    );
    const absent = await activity(5, 'ABSENT', 1);
    await processActivityCompletions(f.db, now);
    now = new Date('2030-06-09T14:00:00Z');
    await check(
      'inactive original evaluation activates after late appeal while natural decay is recomputed',
      async () => {
        await (await correction(absent, 'PRESENT')).run();
        assert.equal((await balance(5)).activityPoints, 0);
        assert.equal((await balance(5)).activityDecayAt, null);
        assert.equal(
          await f.db.activityScoreChange.count({
            where: { accountId: f.ids[5], reason: 'NORMAL_COMPLETION' }
          }),
          1
        );
        assert.equal(
          (await f.db.activityCompletion.findUniqueOrThrow({ where: { registrationId: absent.reg.id } }))
            .active,
          true
        );
      }
    );
    const missing = await activity(6, null, 1),
      cancelled = await activity(7, 'PRESENT', 1);
    await f.db.activity.update({
      where: { id: cancelled.a.id },
      data: { cancelledAt: now, cancellationReason: 'ISOLATED_FIXTURE' }
    });
    await check('unrecorded and canceled activity are never rewarded or late-filled', async () => {
      await processActivityCompletions(f.db, now);
      for (const t of [missing, cancelled])
        assert.equal(await f.db.activityCompletion.count({ where: { registrationId: t.reg.id } }), 0);
      assert.equal(
        (await f.db.activityRegistration.findUniqueOrThrow({ where: { id: missing.reg.id } }))
          .attendanceStatus,
        null
      );
      assert.equal((await balance(6)).activityPoints, 1);
    });
    const firstAppeal = await activity(8, 'PRESENT', 1);
    await check(
      'appeal before first worker evaluates atomically without a transient completion notification',
      async () => {
        await (await correction(firstAppeal, 'ABSENT')).run();
        assert.equal((await balance(8)).activityPoints, 3);
        assert.equal(
          await f.db.activityOutbox.count({
            where: { registrationId: firstAppeal.reg.id, kind: 'ACTIVITY_COMPLETED' }
          }),
          0
        );
        await processActivityCompletions(f.db, now);
        assert.equal(
          await f.db.activityCompletion.count({ where: { registrationId: firstAppeal.reg.id } }),
          1
        );
      }
    );
    const undecided = await activity(9, 'PRESENT', 1, { capacity: 2 });
    await check('undecided incomplete activity is skipped even if auto-cancel has a backlog', async () => {
      await processActivityCompletions(f.db, now);
      assert.equal(await f.db.activityCompletion.count({ where: { registrationId: undecided.reg.id } }), 0);
      await f.db.activity.update({
        where: { id: undecided.a.id },
        data: { continuedAt: new Date('2030-06-01T11:30:00Z') }
      });
      await processActivityCompletions(f.db, now);
      assert.equal((await balance(9)).activityPoints, 0);
    });
    const rollback = await activity(10, 'PRESENT', 1);
    await check('notification fault rolls back completion, score and audit; retry awards once', async () => {
      const db = new Proxy(f.db, {
        get(target, key) {
          if (key === '$transaction')
            return async (fn, options) =>
              target.$transaction(
                (tx) =>
                  fn(
                    new Proxy(tx, {
                      get(t, k) {
                        if (k === 'activityOutbox')
                          return {
                            ...t.activityOutbox,
                            create: async () => {
                              throw Error('Synthetic delivery failure');
                            }
                          };
                        return t[k];
                      }
                    })
                  ),
                options
              );
          return target[key];
        }
      });
      assert.equal(await processActivityCompletions(db, now), 0);
      assert.equal(await f.db.activityCompletion.count({ where: { registrationId: rollback.reg.id } }), 0);
      assert.equal((await balance(10)).activityPoints, 1);
      await processActivityCompletions(f.db, now);
      assert.equal((await balance(10)).activityPoints, 0);
    });
    const race = await activity(11, 'PRESENT', 1);
    const decision = await correction(race, 'ABSENT');
    await check(
      'real worker versus admin correction finishes without lock cycle and settles once',
      async () => {
        let release, ready;
        const started = new Promise((r) => (ready = r)),
          unblock = new Promise((r) => (release = r));
        const holder = f.db.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`activity:${race.a.id}`},0))::text`;
            ready();
            await unblock;
          },
          { timeout: 15000 }
        );
        await started;
        const worker = processActivityCompletions(f.db, now).then(
          (value) => ({ value }),
          (error) => ({ error })
        );
        try {
          for (let i = 0; i < 100; i++) {
            const rows = await f.db
              .$queryRaw`SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted`;
            if (rows[0].count) break;
            if (i === 99) throw Error('No worker lock waiter');
            await new Promise((r) => setTimeout(r, 10));
          }
          const deciding = decision.run().then(
            (value) => ({ value }),
            (error) => ({ error })
          );
          release();
          await holder;
          const [w, d] = await Promise.all([worker, deciding]);
          if (w.error) throw w.error;
          if (d.error) throw d.error;
        } finally {
          release();
        }
        assert.equal((await balance(11)).activityPoints, 3);
        assert.equal(await f.db.activityCompletion.count({ where: { registrationId: race.reg.id } }), 1);
        assert.equal(
          await f.db.activityScoreChange.count({
            where: { accountId: f.ids[11], reason: 'NORMAL_COMPLETION' }
          }),
          1
        );
      }
    );
    const legacy = await activity(12, 'ABSENT', 1, { legacy: true });
    await check(
      'appeal on adoption-null activity cannot acquire a completion credit; public DTO is minimal',
      async () => {
        await (await correction(legacy, 'PRESENT')).run();
        assert.equal((await balance(12)).activityPoints, 1);
        assert.equal(await f.db.activityCompletion.count({ where: { registrationId: legacy.reg.id } }), 0);
        const view = await attendance.attendance(v.a.id, token(1));
        noPrivate(view);
        assert.deepEqual(Object.keys(view.items[0].completion).sort(), ['evaluatedAt', 'status']);
      }
    );
  } finally {
    await f.cleanup();
  }
});
