import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { input } from './activity-input.mjs';
import { AccountService } from '../../../apps/web/server/auth/service.ts';
import { ActivityService } from '../../../apps/web/server/activities/service.ts';
import { ActivityManagementService } from '../../../apps/web/server/activities/management.ts';
import { mainlandChinaPhone, unavailableSms } from '../../../apps/web/server/auth/ports.ts';
import { processActivityMaintenance } from '../../../packages/db/src/activity-maintenance.ts';

export async function managementPostgresCases({ f, check }) {
  let now = new Date('2030-06-01T06:00:00Z');
  const auth = new AccountService(f.db, {
    phone: mainlandChinaPhone,
    sms: unavailableSms,
    environment: 'test',
    now: () => now
  });
  const basic = new ActivityService(auth),
    manage = new ActivityManagementService(auth),
    token = (i) => f.tokens[i];
  const reset = async (i) =>
    f.db.account.update({ where: { id: f.ids[i] }, data: { activityPoints: 0, activityDecayAt: null } });
  const cmd = (revision) => ({ idempotencyKey: randomUUID(), expectedRevision: revision });
  const reject = (fn, code) => assert.rejects(fn, (e) => e.code === code);
  const create = async (capacity = 2) => {
    now = new Date('2030-06-01T06:00:00Z');
    for (const i of [7, 8, 9, 10]) await reset(i);
    return (
      await basic.create(
        input({
          idempotencyKey: randomUUID(),
          seats: Array.from({ length: capacity }, () => ({ kind: 'ANY' }))
        }),
        token(10)
      )
    ).activity;
  };
  const signup = async (a, i = 7, position = 0) =>
    (await basic.register(a.id, { seatId: a.seats[position].id, job: '骑士' }, token(i))).activity;
  const withdrawBody = (a) => ({
    ...cmd(a.revision),
    expectedRegistrationId: a.myRegistration.id,
    expectedPenaltyPoints:
      !a.myRegistration.rescheduleExitAllowed && Date.parse(a.startsAt) - now.getTime() < 2 * 3600000 ? 1 : 0
  });
  const cancelBody = (a) => ({
    ...cmd(a.revision),
    expectedPenaltyPoints:
      now.getTime() >= Date.parse(a.registrationClosesAt) && a.registeredCount < a.capacity && !a.continuedAt
        ? 0
        : Date.parse(a.startsAt) - now.getTime() < 4 * 3600000
          ? 2
          : 0
  });
  const editBody = (a) => ({
    ...input(),
    ...cmd(a.revision),
    seats: a.seats.map((s) => ({ id: s.id, requirement: s.requirement }))
  });
  for (const [delta, points] of [
    [-1, 0],
    [0, 0],
    [1, 1]
  ])
    await check('MANAGEMENT PG withdrawal 2h boundary ' + delta, async () => {
      const a = await signup(await create());
      now = new Date(Date.parse(a.startsAt) - 2 * 3600000 + delta);
      const body = withdrawBody(a),
        first = await manage.withdraw(a.id, body, token(7));
      assert.equal(first.activity.myRegistration, null);
      const archived = await f.db.activityRegistration.findUnique({
        where: { id: body.expectedRegistrationId }
      });
      assert.equal(archived.status, 'WITHDRAWN');
      assert.equal(archived.seatId, null);
      assert.ok(archived.seatSnapshot);
      assert.equal((await f.db.account.findUnique({ where: { id: f.ids[7] } })).activityPoints, points);
      const before = await f.db.activityOutbox.count({ where: { activityId: a.id } });
      assert.equal((await manage.withdraw(a.id, body, token(7))).replayed, true);
      assert.equal(await f.db.activityOutbox.count({ where: { activityId: a.id } }), before);
      assert.equal(await f.db.activityPenalty.count({ where: { activityId: a.id } }), points ? 1 : 0);
    });
  for (const [delta, points] of [
    [-1, 0],
    [0, 0],
    [1, 2]
  ])
    await check('MANAGEMENT PG cancellation 4h boundary ' + delta, async () => {
      let a = await signup(await create(), 7);
      a = await signup(a, 8, 1);
      now = new Date(Date.parse(a.startsAt) - 4 * 3600000 + delta);
      const result = await manage.cancel(a.id, cancelBody(a), token(10));
      assert.equal(result.activity.status, 'CANCELLED');
      assert.equal(result.activity.registeredCount, 0);
      const regs = await f.db.activityRegistration.findMany({ where: { activityId: a.id } });
      assert.equal(regs.length, 2);
      assert.ok(regs.every((r) => r.status === 'CANCELLED' && r.seatId === null));
      assert.equal((await f.db.account.findUnique({ where: { id: f.ids[10] } })).activityPoints, points);
      assert.equal(
        await f.db.activityOutbox.count({
          where: { activityId: a.id, kind: 'ACTIVITY_CANCELLED', channel: 'IN_APP' }
        }),
        2
      );
      assert.equal(
        await f.db.activityOutbox.count({
          where: { activityId: a.id, kind: 'ACTIVITY_CANCELLED', channel: 'QQ' }
        }),
        1
      );
      await reject(() => basic.register(a.id, { seatId: a.seats[0].id, job: '骑士' }, token(9)), 'FORBIDDEN');
    });
  await check(
    'MANAGEMENT PG exits may rejoin without deleting historical attempt or notification',
    async () => {
      const a = await signup(await create());
      await manage.withdraw(a.id, withdrawBody(a), token(7));
      const joined = await signup(a);
      assert.notEqual(joined.myRegistration.id, a.myRegistration.id);
      assert.equal(joined.myParticipation.status, 'ACTIVE');
      assert.equal(
        await f.db.activityRegistration.count({ where: { activityId: a.id, accountId: f.ids[7] } }),
        2
      );
      await assert.rejects(
        () =>
          f.db.activityRegistration.create({
            data: {
              activityId: a.id,
              seatId: a.seats[1].id,
              accountId: f.ids[7],
              job: '骑士',
              createdAt: now
            }
          }),
        (e) => e.code === 'P2002'
      );
    }
  );
  await check(
    'MANAGEMENT PG concurrent duplicate withdrawal commits one penalty audit and notice',
    async () => {
      const a = await signup(await create());
      now = new Date('2030-06-01T10:01:00Z');
      const body = withdrawBody(a);
      const results = await Promise.all([
        manage.withdraw(a.id, body, token(7)),
        manage.withdraw(a.id, body, token(7))
      ]);
      assert.equal(results.filter((r) => !r.replayed).length, 1);
      assert.equal(await f.db.activityPenalty.count({ where: { activityId: a.id } }), 1);
      assert.equal(await f.db.activityCommand.count({ where: { activityId: a.id, kind: 'WITHDRAW' } }), 1);
      assert.equal(
        await f.db.activityOutbox.count({ where: { activityId: a.id, kind: 'REGISTRATION_WITHDRAWN' } }),
        1
      );
    }
  );
  await check('MANAGEMENT PG withdraw races signup without double occupying the released seat', async () => {
    const a = await signup(await create(1));
    const results = await Promise.allSettled([
      manage.withdraw(a.id, withdrawBody(a), token(7)),
      signup(a, 8)
    ]);
    assert.equal(results[0].status, 'fulfilled');
    if (results[1].status === 'rejected') assert.equal(results[1].reason.code, 'CONFLICT');
    const active = await f.db.activityRegistration.findMany({
      where: { activityId: a.id, status: 'ACTIVE' }
    });
    assert.equal(active.length, results[1].status === 'fulfilled' ? 1 : 0);
    const old = await f.db.activityRegistration.findUnique({ where: { id: a.myRegistration.id } });
    assert.equal(old.status, 'WITHDRAWN');
  });
  await check(
    'MANAGEMENT PG cancellation races signup and stale confirmation cannot silently change penalty',
    async () => {
      const a = await create(1),
        results = await Promise.allSettled([manage.cancel(a.id, cancelBody(a), token(10)), signup(a, 7)]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const loser = results.find((r) => r.status === 'rejected');
      assert.ok(['FORBIDDEN', 'CONFLICT'].includes(loser.reason.code));
      const row = await f.db.activity.findUnique({ where: { id: a.id } });
      assert.equal(
        await f.db.activityRegistration.count({ where: { activityId: a.id, status: 'ACTIVE' } }),
        row.cancelledAt ? 0 : 1
      );
    }
  );
  await check(
    'MANAGEMENT PG editing races signup and cannot leave an incompatible registration',
    async () => {
      const a = await create(1),
        body = editBody(a);
      body.seats[0].requirement = { kind: 'ROLE', role: 'HEALER' };
      const result = await Promise.allSettled([manage.edit(a.id, body, token(10)), signup(a, 7)]);
      assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
      assert.ok(
        ['CONFLICT', 'VALIDATION_ERROR'].includes(result.find((r) => r.status === 'rejected').reason.code)
      );
      const row = await f.db.activitySeat.findUnique({
        where: { id: a.seats[0].id },
        include: { registration: true }
      });
      assert.ok(!row.registration || row.kind === 'ANY');
    }
  );
  await check('MANAGEMENT PG occupied seats retain identities across safe SQL position reorder', async () => {
    let a = await signup(await create());
    a = await signup(a, 8, 1);
    const body = editBody(a);
    body.seats.reverse();
    const result = await manage.edit(a.id, body, token(10));
    assert.deepEqual(
      result.activity.seats.map((s) => s.id),
      body.seats.map((s) => s.id)
    );
    assert.equal(await f.db.activityRegistration.count({ where: { activityId: a.id, status: 'ACTIVE' } }), 2);
    await reject(
      () =>
        manage.edit(
          a.id,
          { ...body, ...cmd(result.activity.revision), seats: body.seats.slice(0, 1) },
          token(10)
        ),
      'CONFLICT'
    );
  });
  await check(
    'MANAGEMENT PG reschedule notices and no-fault exit are persisted at original 4h boundary',
    async () => {
      const a = await signup(await create());
      now = new Date('2030-06-01T08:00:00Z');
      const body = editBody(a);
      body.startsAt = '2030-06-01T21:00:00+08:00';
      const edited = await manage.edit(a.id, body, token(10));
      assert.equal(
        await f.db.activityOutbox.count({ where: { activityId: a.id, kind: 'ACTIVITY_RESCHEDULED' } }),
        2
      );
      const d = await basic.detail(a.id, token(7));
      assert.equal(d.myRegistration.rescheduleExitAllowed, true);
      now = new Date('2030-06-01T12:59:00Z');
      await manage.withdraw(a.id, withdrawBody(d), token(7));
      assert.equal(await f.db.activityPenalty.count({ where: { activityId: a.id } }), 0);
      assert.equal(edited.activity.registeredCount, 1);
    }
  );
  await check(
    'MANAGEMENT PG full cancellation failure rolls back registration score and durable events',
    async () => {
      const a = await signup(await create(1));
      now = new Date('2030-06-01T10:01:00Z');
      const proxy = new Proxy(auth, {
        get(t, k) {
          if (k === 'transaction')
            return (fn) =>
              t.transaction((tx) =>
                fn(
                  new Proxy(tx, {
                    get(db, key) {
                      if (key === 'activityOutbox')
                        return new Proxy(db.activityOutbox, {
                          get(model, method) {
                            if (method === 'create')
                              return async () => {
                                throw new Error('Synthetic outbox failure');
                              };
                            const v = Reflect.get(model, method);
                            return typeof v === 'function' ? v.bind(model) : v;
                          }
                        });
                      const v = Reflect.get(db, key);
                      return typeof v === 'function' ? v.bind(db) : v;
                    }
                  })
                )
              );
          const v = Reflect.get(t, k);
          return typeof v === 'function' ? v.bind(t) : v;
        }
      });
      await assert.rejects(() => new ActivityManagementService(proxy).cancel(a.id, cancelBody(a), token(10)));
      assert.equal((await basic.detail(a.id, token(7))).myRegistration.id, a.myRegistration.id);
      assert.equal(await f.db.activityPenalty.count({ where: { activityId: a.id } }), 0);
      assert.equal((await f.db.account.findUnique({ where: { id: f.ids[10] } })).activityPoints, 0);
    }
  );
  await check('MANAGEMENT PG exact start denies all new commands after activity-lock wait', async () => {
    const a = await signup(await create());
    now = new Date(a.startsAt);
    await reject(() => manage.withdraw(a.id, withdrawBody(a), token(7)), 'FORBIDDEN');
    await reject(() => manage.cancel(a.id, cancelBody(a), token(10)), 'FORBIDDEN');
    await reject(() => manage.edit(a.id, editBody(a), token(10)), 'FORBIDDEN');
    now = new Date('2030-06-01T11:59:59.999Z');
    let release, locked;
    const acquired = new Promise((r) => (locked = r)),
      wait = new Promise((r) => (release = r));
    const blocker = f.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`activity:${a.id}`},0))::text`;
      locked();
      await wait;
    });
    await acquired;
    const pending = manage.cancel(a.id, cancelBody(a), token(10));
    await new Promise((r) => setTimeout(r, 80));
    now = new Date(a.startsAt);
    release();
    await blocker;
    await reject(() => pending, 'FORBIDDEN');
    assert.equal((await basic.detail(a.id, token(7))).registeredCount, 1);
  });
  await check(
    'MANAGEMENT PG restricted fresh writes deny but exact natural decay releases without altering existing bookings',
    async () => {
      const a = await signup(await create());
      const due = new Date('2030-06-08T06:00:00Z');
      await f.db.account.update({
        where: { id: f.ids[7] },
        data: { activityPoints: 3, activityDecayAt: due }
      });
      await reject(() => basic.create(input({ idempotencyKey: randomUUID() }), token(7)), 'FORBIDDEN');
      assert.equal(
        (await basic.register(a.id, { seatId: a.seats[0].id, job: '骑士' }, token(7))).replayed,
        true
      );
      const other = await create();
      await f.db.account.update({
        where: { id: f.ids[7] },
        data: { activityPoints: 3, activityDecayAt: due }
      });
      await reject(
        () => basic.register(other.id, { seatId: other.seats[0].id, job: '骑士' }, token(7)),
        'FORBIDDEN'
      );
      now = due;
      const released = (
        await basic.create(
          input({
            idempotencyKey: randomUUID(),
            startsAt: '2030-06-08T20:00:00+08:00',
            endsAt: '2030-06-08T22:00:00+08:00'
          }),
          token(7)
        )
      ).activity;
      assert.ok(released.id);
      assert.equal((await f.db.account.findUnique({ where: { id: f.ids[7] } })).activityPoints, 2);
      assert.equal((await basic.detail(a.id, token(7))).myRegistration.id, a.myRegistration.id);
    }
  );
  await check(
    'MANAGEMENT PG background auto cancel is idempotent and excludes legacy history full and continued activities',
    async () => {
      const pending = await signup(await create());
      const full = await signup(await create(1));
      const continued = await signup(await create());
      now = new Date('2030-06-01T11:30:00Z');
      await manage.continueActivity(continued.id, cmd(continued.revision), token(10));
      const legacy = await create();
      await f.db.activity.update({
        where: { id: legacy.id },
        data: { managementEnabledAt: new Date('2030-06-02T00:00:00Z') }
      });
      now = new Date('2030-06-01T12:00:00Z');
      await processActivityMaintenance(f.db, now);
      assert.equal((await basic.detail(pending.id, token(7))).status, 'CANCELLED');
      assert.equal((await basic.detail(full.id, token(7))).status, 'IN_PROGRESS');
      assert.equal((await basic.detail(continued.id, token(7))).status, 'IN_PROGRESS');
      assert.equal((await basic.detail(legacy.id, token(10))).status, 'IN_PROGRESS');
      const count = await f.db.activityOutbox.count({ where: { activityId: pending.id } });
      await processActivityMaintenance(f.db, now);
      assert.equal(await f.db.activityOutbox.count({ where: { activityId: pending.id } }), count);
    }
  );
  await check(
    'MANAGEMENT PG worker settles seven-day restriction records with no historical notification fanout',
    async () => {
      now = new Date('2030-06-08T10:00:00Z');
      await f.db.account.update({
        where: { id: f.ids[9] },
        data: { activityPoints: 4, activityDecayAt: new Date('2030-06-01T10:00:00Z') }
      });
      const before = await f.db.activityScoreChange.count({
        where: { accountId: f.ids[9], reason: 'NATURAL_DECAY' }
      });
      await processActivityMaintenance(f.db, now);
      assert.equal((await f.db.account.findUnique({ where: { id: f.ids[9] } })).activityPoints, 2);
      assert.equal(
        await f.db.activityScoreChange.count({ where: { accountId: f.ids[9], reason: 'NATURAL_DECAY' } }),
        before + 1
      );
    }
  );

  const wrapTx = (tx, onQuery) =>
    new Proxy(tx, {
      get(t, k) {
        if (k === '$queryRaw')
          return async (parts, ...values) => {
            const result = await t.$queryRaw(parts, ...values);
            await onQuery(parts.join(''), values);
            return result;
          };
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      }
    });
  const wrappedAuth = (onQuery) =>
    new Proxy(auth, {
      get(t, k) {
        if (k === 'transaction') return (fn) => t.transaction((tx) => fn(wrapTx(tx, onQuery)));
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      }
    });
  const outcome = (p) =>
    p.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    );
  function barrier() {
    let ready, release;
    return {
      ready: new Promise((r) => (ready = r)),
      wait: new Promise((r) => (release = r)),
      signal: () => ready(),
      release: () => release()
    };
  }
  await check(
    'MANAGEMENT PG deterministic booked-participant exit vs organizer cancel has no account/activity deadlock',
    async () => {
      const a = await signup(await create(1)),
        cancellation = barrier(),
        participant = barrier();
      const cancellationService = new ActivityManagementService(
        wrappedAuth(async (sql, values) => {
          if (sql.includes('pg_advisory_xact_lock') && values[0] === `activity:${a.id}`) {
            cancellation.signal();
            await cancellation.wait;
          }
        })
      );
      const exitService = new ActivityManagementService(
        wrappedAuth(async (sql, values) => {
          if (sql.includes('SELECT "id" FROM "Account"') && values[0] === f.ids[7]) participant.signal();
        })
      );
      const cancelled = outcome(cancellationService.cancel(a.id, cancelBody(a), token(10)));
      await cancellation.ready;
      const exited = outcome(exitService.withdraw(a.id, withdrawBody(a), token(7)));
      await participant.ready;
      cancellation.release();
      const [c, e] = await Promise.all([cancelled, exited]);
      assert.equal(c.ok, true);
      assert.equal(e.ok, false);
      assert.equal(e.error.code, 'FORBIDDEN');
      assert.equal((await basic.detail(a.id, token(7))).myParticipation.status, 'CANCELLED');
      assert.equal(await f.db.activityRegistration.count({ where: { activityId: a.id } }), 1);
    }
  );
  await check(
    'MANAGEMENT PG deterministic booked-participant exit vs automatic cancellation has no deadlock',
    async () => {
      const a = await signup(await create()),
        automatic = barrier(),
        participant = barrier();
      now = new Date('2030-06-01T11:59:59.999Z');
      const db = new Proxy(f.db, {
        get(t, k) {
          if (k === '$transaction')
            return (fn, options) =>
              t.$transaction(
                (tx) =>
                  fn(
                    wrapTx(tx, async (sql, values) => {
                      if (sql.includes('pg_advisory_xact_lock') && values[0] === `activity:${a.id}`) {
                        automatic.signal();
                        await automatic.wait;
                      }
                    })
                  ),
                options
              );
          const v = Reflect.get(t, k);
          return typeof v === 'function' ? v.bind(t) : v;
        }
      });
      const exitService = new ActivityManagementService(
        wrappedAuth(async (sql, values) => {
          if (sql.includes('SELECT "id" FROM "Account"') && values[0] === f.ids[7]) participant.signal();
        })
      );
      const cancelled = outcome(processActivityMaintenance(db, new Date(a.startsAt)));
      await automatic.ready;
      const exited = outcome(exitService.withdraw(a.id, withdrawBody(a), token(7)));
      await participant.ready;
      now = new Date(a.startsAt);
      automatic.release();
      const [c, e] = await Promise.all([cancelled, exited]);
      assert.equal(c.ok, true);
      assert.equal(e.ok, false);
      assert.equal(e.error.code, 'FORBIDDEN');
      assert.equal((await basic.detail(a.id, token(7))).status, 'CANCELLED');
    }
  );
  for (const kind of ['withdraw', 'cancel'])
    await check(
      'MANAGEMENT PG waiting request crossing penalty boundary requires renewed confirmation ' + kind,
      async () => {
        const a = await signup(await create(1));
        now = new Date(kind === 'withdraw' ? '2030-06-01T10:00:00Z' : '2030-06-01T08:00:00Z');
        const body = kind === 'withdraw' ? withdrawBody(a) : cancelBody(a),
          locked = barrier(),
          actor = barrier();
        const blocker = f.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`activity:${a.id}`},0))::text`;
          locked.signal();
          await locked.wait;
        });
        await locked.ready;
        const service = new ActivityManagementService(
          wrappedAuth(async (sql) => {
            if (sql.includes('SELECT "id" FROM "Account"')) actor.signal();
          })
        );
        const pending = outcome(service[kind](a.id, body, token(kind === 'withdraw' ? 7 : 10)));
        await actor.ready;
        now = new Date(now.getTime() + 1);
        locked.release();
        await blocker;
        const result = await pending;
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'CONFLICT');
        assert.equal(await f.db.activityPenalty.count({ where: { activityId: a.id } }), 0);
        assert.equal((await basic.detail(a.id, token(7))).myRegistration.id, a.myRegistration.id);
        await manage[kind](
          a.id,
          kind === 'withdraw' ? withdrawBody(a) : cancelBody(a),
          token(kind === 'withdraw' ? 7 : 10)
        );
        assert.equal(await f.db.activityPenalty.count({ where: { activityId: a.id } }), 1);
      }
    );
}
