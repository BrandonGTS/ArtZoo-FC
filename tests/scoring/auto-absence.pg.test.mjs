// 活动结束自动记缺席（真实 PostgreSQL）：未登记的有效报名记缺席并扣 2 点；与签到并发时持锁者胜出；
// 取消或退出后在锁内重新检查；事务失败不留下部分结果。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, noPrivate } from '../activities/support/pg-fixture.mjs';
import { processActivityAutoAbsences } from '../../packages/db/src/activity-auto-absence.ts';
import { processActivityCompletions } from '../../packages/db/src/activity-completion.ts';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { ActivityAttendanceService } from '../../apps/web/server/activities/attendance.ts';
import { mainlandChinaPhone, unavailableSms } from '../../apps/web/server/auth/ports.ts';

test('自动记缺席：真实 PostgreSQL', async (t) => {
  const f = await fixture();
  let now = new Date('2030-06-01T14:01:00Z');
  const end = new Date('2030-06-01T14:00:00Z');
  const check = (name, fn) => t.test(name, fn);
  const auth = (db) =>
    new AccountService(db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      environment: 'test',
      now: () => now
    });
  const service = new ActivityAttendanceService(auth(f.db));
  async function make(member = 1, patch = {}, status = 'ACTIVE') {
    if (patch.series) {
      const series = await f.db.activitySeries.create({ data: patch.series.create });
      patch = { ...patch, seriesId: series.id };
      delete patch.series;
    }
    let a;
    try {
      a = await f.db.activity.create({
        data: {
          organizerId: f.ids[0],
          idempotencyKey: randomUUID(),
          requestFingerprint: 'auto-absence-synthetic',
          title: '[自动缺席测试] ' + randomUUID(),
          description: 'Disposable isolated test',
          category: 'SOCIAL',
          startsAt: new Date(+end - 3600000),
          endsAt: end,
          ...patch,
          seats: { create: { position: 0, kind: 'ANY' } }
        },
        include: { seats: true }
      });
    } catch (e) {
      throw e;
    }
    const reg = await f.db.activityRegistration.create({
      data: {
        activityId: a.id,
        seatId: status === 'ACTIVE' ? a.seats[0].id : null,
        accountId: f.ids[member],
        status,
        ...(status === 'ACTIVE'
          ? {}
          : {
              exitedAt: new Date(+end - 7200000),
              seatSnapshot: { position: 0, kind: 'ANY', role: null, job: null, groupKey: null }
            })
      }
    });
    return { a, reg, member };
  }
  const row = (v) => f.db.activityRegistration.findUniqueOrThrow({ where: { id: v.reg.id } });
  const points = (v) =>
    f.db.account
      .findUniqueOrThrow({ where: { id: f.ids[v.member] }, select: { activityPoints: true } })
      .then((x) => x.activityPoints);
  const record = (v) => ({
    idempotencyKey: randomUUID(),
    registrationId: v.reg.id,
    expectedAttendanceRevision: 0,
    status: 'PRESENT'
  });
  const scopedProxy = (onTransaction) =>
    new Proxy(f.db, {
      get(target, key) {
        if (key === '$transaction')
          return (fn, options) => target.$transaction((tx) => fn(onTransaction(tx)), options);
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  try {
    await f.db.account.update({ where: { id: f.ids[2] }, data: { adminRole: 'ADMIN' } });
    const first = await make(1);
    const before = await points(first);
    await check('exact cutoff and concurrent workers charge once with real timestamp', async () => {
      assert.equal(await processActivityAutoAbsences(f.db, new Date(+end - 1)), 0);
      const out = await Promise.all([
        processActivityAutoAbsences(f.db, now),
        processActivityAutoAbsences(f.db, now)
      ]);
      assert.equal(
        out.reduce((a, b) => a + b, 0),
        1
      );
      const current = await row(first);
      assert.equal(current.attendanceStatus, 'ABSENT');
      assert.equal(current.attendanceSource, 'AUTO_DEADLINE');
      assert.equal(+current.attendanceRecordedAt, +now);
      assert.equal(current.attendanceRevision, 1);
      assert.equal(await points(first), before + 2);
      assert.equal(await f.db.activityPenalty.count({ where: { registrationId: first.reg.id } }), 1);
      assert.equal(
        await f.db.activityOutbox.count({
          where: { registrationId: first.reg.id, kind: 'ACTIVITY_PENALTY' }
        }),
        1
      );
      const events = await f.db.activityOutbox.findMany({
        where: { registrationId: first.reg.id },
        include: { mockDelivery: true }
      });
      assert.ok(events.every((e) => e.channel === 'IN_APP' && e.recipientId === f.ids[1] && e.mockDelivery));
      assert.equal(await processActivityAutoAbsences(f.db, now), 0);
    });
    await check(
      'cancellation, exited enrollment, unformed, series and offline receive no penalty',
      async () => {
        const cases = [
          await make(3, { cancelledAt: now }),
          await make(3, {}, 'WITHDRAWN'),
          await make(3, {}, 'CANCELLED'),
          await make(3, {
            scene: 'OFFLINE',
            location: 'Synthetic',
            registrationClosesAt: new Date(+end - 7200000)
          }),
          await make(3, {
            mode: 'SERIES',
            periodNumber: 1,
            series: { create: { weekdays: [6], durationMinutes: 60, totalPeriods: 2 } }
          })
        ];
        const incomplete = await make(3);
        await f.db.activitySeat.create({ data: { activityId: incomplete.a.id, position: 1, kind: 'ANY' } });
        cases.push(incomplete);
        assert.equal(await processActivityAutoAbsences(f.db, now), 0);
        for (const v of cases) {
          assert.equal((await row(v)).attendanceStatus, null);
          assert.equal(await f.db.activityPenalty.count({ where: { registrationId: v.reg.id } }), 0);
        }
      }
    );
    await check('penalty and event transaction failure leaves no partial DB effects', async () => {
      const v = await make(4),
        before = await points(v);
      const db = scopedProxy(
        (tx) =>
          new Proxy(tx, {
            get(target, key) {
              if (key === 'activityOutbox')
                return {
                  create: async () => {
                    throw Error('PUBLIC_SYNTHETIC_EVENT_FAILURE');
                  }
                };
              return Reflect.get(target, key);
            }
          })
      );
      assert.equal(await processActivityAutoAbsences(db, now), 0);
      assert.equal((await row(v)).attendanceStatus, null);
      assert.equal(await points(v), before);
      assert.equal(await f.db.activityPenalty.count({ where: { registrationId: v.reg.id } }), 0);
      assert.equal(await f.db.activityCommand.count({ where: { activityId: v.a.id } }), 0);
      // Take the fixture out of later sweeps.
      await f.db.activity.update({ where: { id: v.a.id }, data: { cancelledAt: now } });
    });
    await check(
      'real sign-in holding shared lock wins over deadline worker without duplicate write',
      async () => {
        const v = await make(5);
        now = new Date(+end - 1);
        let ready, release;
        const locked = new Promise((r) => (ready = r)),
          unblock = new Promise((r) => (release = r));
        const db = scopedProxy(
          (tx) =>
            new Proxy(tx, {
              get(target, key) {
                if (key === '$queryRaw')
                  return async (strings, ...values) => {
                    const result = await target.$queryRaw(strings, ...values);
                    if (String(values[0]) === 'activity:' + v.a.id) {
                      ready();
                      await unblock;
                    }
                    return result;
                  };
                return Reflect.get(target, key);
              }
            })
        );
        const recording = new ActivityAttendanceService(auth(db)).record(v.a.id, record(v), f.tokens[0]);
        await locked;
        const worker = processActivityAutoAbsences(f.db, end);
        release();
        await recording;
        await worker;
        assert.equal((await row(v)).attendanceStatus, 'PRESENT');
        assert.equal(await f.db.activityPenalty.count({ where: { registrationId: v.reg.id } }), 0);
      }
    );
    await check('worker holding lock wins at cutoff; concurrent stale sign-in is refused', async () => {
      const v = await make(6);
      now = end;
      let ready, release;
      const locked = new Promise((r) => (ready = r)),
        unblock = new Promise((r) => (release = r));
      const db = scopedProxy(
        (tx) =>
          new Proxy(tx, {
            get(target, key) {
              if (key === '$queryRaw')
                return async (strings, ...values) => {
                  const result = await target.$queryRaw(strings, ...values);
                  if (String(values[0]) === 'activity:' + v.a.id) {
                    ready();
                    await unblock;
                  }
                  return result;
                };
              return Reflect.get(target, key);
            }
          })
      );
      const worker = processActivityAutoAbsences(db, end);
      await locked;
      const recording = service.record(v.a.id, record(v), f.tokens[0]).then(
        () => null,
        (e) => e
      );
      release();
      await worker;
      assert.ok(['CONFLICT', 'FORBIDDEN'].includes((await recording)?.code));
      assert.equal(await f.db.activityPenalty.count({ where: { registrationId: v.reg.id } }), 1);
    });
    await check('post-candidate cancellation and withdrawal are rechecked under the real lock', async () => {
      for (const kind of ['cancel', 'exit']) {
        const v = await make(7);
        let once = false;
        const db = new Proxy(f.db, {
          get(target, key) {
            if (key === '$transaction')
              return async (fn, options) => {
                if (!once) {
                  once = true;
                  if (kind === 'cancel')
                    await f.db.activity.update({ where: { id: v.a.id }, data: { cancelledAt: now } });
                  else
                    await f.db.activityRegistration.update({
                      where: { id: v.reg.id },
                      data: {
                        status: 'WITHDRAWN',
                        seatId: null,
                        exitedAt: now,
                        seatSnapshot: { position: 0, kind: 'ANY', role: null, job: null, groupKey: null }
                      }
                    });
                }
                return target.$transaction(fn, options);
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
        await processActivityAutoAbsences(db, end);
        assert.equal((await row(v)).attendanceStatus, null);
        assert.equal(await f.db.activityPenalty.count({ where: { registrationId: v.reg.id } }), 0);
      }
    });
    await check(
      'automatic record supports own appeal and admin-only reversal with real completion reconciliation',
      async () => {
        now = new Date(+end + 60000);
        await processActivityCompletions(f.db, now);
        const old = await row(first),
          balance = await points(first);
        const body = {
          idempotencyKey: randomUUID(),
          registrationId: first.reg.id,
          expectedAttendanceRevision: old.attendanceRevision,
          requestedStatus: 'PRESENT',
          reason: 'Public synthetic appeal'
        };
        await assert.rejects(
          () => service.appeal(first.a.id, body, f.tokens[3]),
          (e) => e.code === 'FORBIDDEN'
        );
        const view = await service.attendance(first.a.id, f.tokens[1]);
        noPrivate(view);
        assert.equal(view.items[0].canAppeal, true);
        await service.appeal(first.a.id, body, f.tokens[1]);
        const appeal = await f.db.activityAttendanceAppeal.findFirstOrThrow({
          where: { registrationId: first.reg.id, status: 'PENDING' }
        });
        const decision = {
          idempotencyKey: randomUUID(),
          expectedAttendanceRevision: old.attendanceRevision,
          expectedAppealRevision: 0,
          decision: 'APPROVE',
          reason: 'Public verified synthetic correction'
        };
        await assert.rejects(
          () => service.decide(appeal.id, decision, f.tokens[0]),
          (e) => e.code === 'FORBIDDEN'
        );
        const results = await Promise.all([
          service.decide(appeal.id, decision, f.tokens[2]),
          service.decide(appeal.id, decision, f.tokens[2])
        ]);
        assert.equal(results.filter((x) => !x.replayed).length, 1);
        const current = await row(first);
        assert.equal(current.attendanceSource, 'AUTO_DEADLINE');
        assert.equal(+current.attendanceRecordedAt, +old.attendanceRecordedAt);
        assert.equal(current.attendanceStatus, 'PRESENT');
        assert.equal(await points(first), Math.max(0, balance - 3));
        assert.equal(
          await f.db.activityOutbox.count({
            where: { registrationId: first.reg.id, kind: 'ATTENDANCE_APPEAL_RESULT' }
          }),
          1
        );
        assert.equal(
          await f.db.activityCompletion.count({ where: { registrationId: first.reg.id, active: true } }),
          1
        );
      }
    );
  } finally {
    await f.cleanup();
  }
});
