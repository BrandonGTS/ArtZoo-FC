import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ActivityService } from '../../../apps/web/server/activities/service.ts';
import { noPrivate } from './pg-fixture.mjs';
// Only invoked after parent runner has verified the disposable database.
export async function seedPagination(f, now) {
  const rows = [];
  for (let i = 0; i < 35; i++) {
    const history = i >= 23;
    const startsAt = new Date(
      now.getTime() +
        (history ? -7200000 - Math.floor((i - 23) / 3) * 60000 : Math.floor(i / 3) * 60000 - 60000)
    );
    const endsAt = new Date(now.getTime() + (history ? (i === 23 ? 0 : -1000 * (i - 23)) : 3600000));
    const id = randomUUID(),
      seatId = randomUUID();
    await f.db.activity.create({
      data: {
        id,
        organizerId: f.ids[10],
        idempotencyKey: randomUUID(),
        requestFingerprint: 'isolated-pagination',
        title: 'Page ' + i,
        description: '',
        category: 'SOCIAL',
        startsAt,
        endsAt,
        seats: { create: { id: seatId, position: 0, kind: 'ANY' } }
      }
    });
    await f.db.activityRegistration.create({
      data: { activityId: id, seatId, accountId: f.ids[11], job: null }
    });
    rows.push({ id, startsAt, endsAt, history });
  }
  for (let i = 0; i < 5; i++)
    await f.db.activity.create({
      data: {
        organizerId: f.ids[11],
        idempotencyKey: randomUUID(),
        requestFingerprint: 'isolated-pagination',
        title: 'Own ' + i,
        description: '',
        category: 'SOCIAL',
        startsAt: new Date(now.getTime() + 1000),
        endsAt: new Date(now.getTime() + 3600000),
        seats: { create: { position: 0, kind: 'ANY' } }
      }
    });
  return rows;
}
const order = (rows, history) =>
  rows
    .filter((r) => r.history === history)
    .sort((a, b) => (history ? b.startsAt - a.startsAt : a.startsAt - b.startsAt) || a.id.localeCompare(b.id))
    .map((r) => r.id);
export async function eightPostgresCases({ f, auth, service, check, token, fresh }) {
  const reject = (fn, code) => assert.rejects(fn, (e) => e.code === code),
    any = (n) => Array.from({ length: n }, () => ({ kind: 'ANY' }));
  const create = async (seats) => (await service.create(fresh({ seats }), token(6))).activity;
  const reg = (a, i, seat = 0, job = '骑士') =>
    service.register(a.id, { seatId: a.seats[seat].id, job }, token(i));
  const move = (a, i, from, to, job = '骑士', s = service, at) =>
    s.moveRegistration(a.id, { expectedSeatId: a.seats[from].id, seatId: a.seats[to].id, job }, token(i), at);
  await check(
    'MOVE same row frees old seat changes eligible job and creates no additional event or receipt',
    async () => {
      const a = await create([
          { kind: 'ROLE', role: 'TANK' },
          { kind: 'ROLE', role: 'HEALER' }
        ]),
        before = (await reg(a, 7)).activity.myRegistration;
      const count = await f.db.activityOutbox.count({ where: { activityId: a.id } }),
        receipts = await f.db.activityMockDelivery.count({ where: { event: { activityId: a.id } } });
      const result = await move(a, 7, 0, 1, '白魔法师');
      assert.equal(result.replayed, false);
      assert.equal(result.activity.myRegistration.id, before.id);
      assert.equal(result.activity.myRegistration.job, '白魔法师');
      assert.equal(result.activity.seats[0].registration, null);
      assert.equal((await move(a, 7, 0, 1, '白魔法师')).replayed, true);
      assert.equal(await f.db.activityRegistration.count({ where: { activityId: a.id } }), 1);
      assert.equal(await f.db.activityOutbox.count({ where: { activityId: a.id } }), count);
      assert.equal(
        await f.db.activityMockDelivery.count({ where: { event: { activityId: a.id } } }),
        receipts
      );
    }
  );
  await check(
    'MOVE invalid occupied stale source unauthorized and unregistered attempts preserve original',
    async () => {
      const a = await create([{ kind: 'ANY' }, { kind: 'ROLE', role: 'HEALER' }, { kind: 'ANY' }]);
      await reg(a, 7);
      await reg(a, 8, 2);
      for (const [fn, code] of [
        [() => move(a, 7, 0, 1), 'VALIDATION_ERROR'],
        [() => move(a, 7, 0, 2), 'CONFLICT'],
        [() => move(a, 7, 2, 1, '白魔法师'), 'CONFLICT'],
        [() => move(a, 9, 0, 1, '白魔法师'), 'CONFLICT'],
        [
          () =>
            service.moveRegistration(a.id, {
              expectedSeatId: a.seats[0].id,
              seatId: a.seats[1].id,
              job: '白魔法师'
            }),
          'UNAUTHENTICATED'
        ]
      ])
        await reject(fn, code);
      assert.equal((await service.detail(a.id, token(7))).myRegistration.seatId, a.seats[0].id);
    }
  );
  await check('MOVE two actors racing one destination retain losing original seat', async () => {
    const a = await create(any(3));
    await reg(a, 7);
    await reg(a, 8, 1);
    const results = await Promise.allSettled([move(a, 7, 0, 2), move(a, 8, 1, 2)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'CONFLICT');
    const d = await service.detail(a.id, token(6));
    assert.equal(d.registeredCount, 2);
    assert.ok(d.seats[2].registration);
    assert.equal(d.seats.filter((s) => !s.registration).length, 1);
    const loser = results[0].status === 'rejected' ? 0 : 1;
    assert.ok(d.seats[loser].registration);
    assert.equal(await f.db.activityOutbox.count({ where: { activityId: a.id } }), 3);
  });
  await check(
    'MOVE same-account different targets race uses expected source and never occupies two seats',
    async () => {
      const a = await create(any(3));
      await reg(a, 7);
      const results = await Promise.allSettled([move(a, 7, 0, 1), move(a, 7, 0, 2)]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'CONFLICT');
      assert.equal(
        await f.db.activityRegistration.count({ where: { activityId: a.id, accountId: f.ids[7] } }),
        1
      );
    }
  );
  await check(
    'MOVE versus first signup race serializes destination without releasing a losing source',
    async () => {
      const a = await create(any(2));
      await reg(a, 7);
      const results = await Promise.allSettled([move(a, 7, 0, 1), reg(a, 8, 1)]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'CONFLICT');
      const d = await service.detail(a.id, token(7));
      assert.equal(d.myRegistration.seatId, a.seats[results[0].status === 'fulfilled' ? 1 : 0].id);
      assert.equal(d.registeredCount, results[0].status === 'fulfilled' ? 1 : 2);
    }
  );
  await check('MOVE transaction failure after SQL update rolls back to original seat', async () => {
    const a = await create(any(2));
    await reg(a, 7);
    const failing = Object.create(auth);
    failing.transaction = (fn) =>
      auth.transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, key) {
              if (key === 'activityRegistration')
                return {
                  ...target.activityRegistration,
                  updateMany: async (args) => {
                    await target.activityRegistration.updateMany(args);
                    throw Error('synthetic after-update failure');
                  }
                };
              const v = Reflect.get(target, key);
              return typeof v === 'function' ? v.bind(target) : v;
            }
          })
        )
      );
    await assert.rejects(() => move(a, 7, 0, 1, '骑士', new ActivityService(failing)));
    const d = await service.detail(a.id, token(7));
    assert.equal(d.myRegistration.seatId, a.seats[0].id);
    assert.equal(d.seats[1].registration, null);
  });
  await check(
    'MOVE received-before cutoff accepted after wait; exact cutoff denies; replay stays harmless',
    async () => {
      const a = await create(any(3));
      await reg(a, 7);
      const delayed = Object.create(auth);
      delayed.now = () => new Date('2030-06-01T11:30:01Z');
      const s = new ActivityService(delayed);
      await reject(() => move(a, 7, 0, 1, '骑士', s, new Date('2030-06-01T11:30:00Z')), 'FORBIDDEN');
      await move(a, 7, 0, 1, '骑士', s, new Date('2030-06-01T11:29:59.999Z'));
      assert.equal((await move(a, 7, 0, 1, '骑士', s, new Date('2030-06-01T11:30:02Z'))).replayed, true);
      await reject(() => move(a, 7, 1, 2, '骑士', s, new Date('2030-06-01T11:30:02Z')), 'FORBIDDEN');
    }
  );
  await check(
    'MINE repeatable snapshot keeps count and page consistent across concurrent committed insert',
    async () => {
      let inserted = false,
        createdId;
      const raced = Object.create(auth);
      raced.db = new Proxy(f.db, {
        get(target, key) {
          if (key === '$transaction')
            return (fn, options) =>
              target.$transaction(
                (tx) =>
                  fn(
                    new Proxy(tx, {
                      get(t, k) {
                        if (k === 'activity')
                          return new Proxy(t.activity, {
                            get(model, method) {
                              if (method === 'count')
                                return async (args) => {
                                  const total = await model.count(args);
                                  if (!inserted) {
                                    inserted = true;
                                    const created = await f.db.activity.create({
                                      data: {
                                        organizerId: f.ids[12],
                                        idempotencyKey: randomUUID(),
                                        requestFingerprint: 'snapshot-interleave',
                                        title: 'Concurrent committed',
                                        description: '',
                                        category: 'SOCIAL',
                                        startsAt: new Date(auth.now().getTime() + 3600000),
                                        endsAt: new Date(auth.now().getTime() + 7200000),
                                        seats: { create: { position: 0, kind: 'ANY' } }
                                      }
                                    });
                                    createdId = created.id;
                                  }
                                  return total;
                                };
                              const v = Reflect.get(model, method);
                              return typeof v === 'function' ? v.bind(model) : v;
                            }
                          });
                        const v = Reflect.get(t, k);
                        return typeof v === 'function' ? v.bind(t) : v;
                      }
                    })
                  ),
                options
              );
          const v = Reflect.get(target, key);
          return typeof v === 'function' ? v.bind(target) : v;
        }
      });
      const first = await new ActivityService(raced).mine(token(12));
      assert.equal(first.publishedPagination.total, 0);
      assert.equal(first.published.length, 0);
      assert.equal(inserted, true);
      const next = await service.mine(token(12));
      assert.equal(next.publishedPagination.total, 1);
      assert.equal(next.published[0].id, createdId);
    }
  );
  const seeded = await seedPagination(f, auth.now()),
    current = order(seeded, false),
    history = order(seeded, true);
  await check(
    'MINE true DB current/history independent paging stable tie ordering and equality boundary',
    async () => {
      const first = await service.mine(token(11));
      assert.deepEqual(
        first.registered.map((x) => x.id),
        current.slice(0, 10)
      );
      assert.equal(first.registeredPagination.total, 23);
      assert.equal(first.publishedPagination.total, 5);
      const second = await service.mine(
        token(11),
        new URL('http://test?registeredPage=2&publishedPeriod=history')
      );
      assert.deepEqual(
        second.registered.map((x) => x.id),
        current.slice(10, 20)
      );
      assert.equal(second.published.length, 0);
      assert.equal(second.publishedPagination.totalPages, 0);
      assert.equal(second.publishedPagination.page, 1);
      const past = await service.mine(
        token(11),
        new URL('http://test?registeredPeriod=history&registeredPage=2')
      );
      assert.deepEqual(
        past.registered.map((x) => x.id),
        history.slice(10)
      );
      assert.equal(past.registeredPagination.total, 12);
      assert.equal(past.publishedPagination.total, 5);
      const firstPast = await service.mine(token(11), new URL('http://test?registeredPeriod=history'));
      assert.ok(
        firstPast.registered.some(
          (x) => x.id === seeded.find((r) => r.endsAt.getTime() === auth.now().getTime()).id
        )
      );
      noPrivate(first);
      noPrivate(past);
    }
  );
  await check('MINE page clamping and published history filtering use own DB predicates', async () => {
    const mine = await service.mine(token(11), new URL('http://test?registeredPage=999&publishedPage=999'));
    assert.equal(mine.registeredPagination.page, 3);
    assert.deepEqual(
      mine.registered.map((x) => x.id),
      current.slice(20)
    );
    assert.equal(mine.publishedPagination.page, 1);
    const owner = await service.mine(
      token(10),
      new URL('http://test?publishedPeriod=history&publishedPage=999&registeredPeriod=history')
    );
    assert.equal(owner.publishedPagination.total, 12);
    assert.equal(owner.publishedPagination.page, 2);
    assert.deepEqual(
      owner.published.map((x) => x.id),
      history.slice(10)
    );
    assert.equal(owner.registered.length, 0);
  });
  await check(
    'MINE invalid query unauthenticated and unrelated actors never leak another account pages',
    async () => {
      for (const query of [
        'registeredPage=0',
        'publishedPage=-1',
        'registeredPage=1.5',
        'publishedPage=9007199254740992',
        'registeredPeriod=all',
        'publishedPeriod=bad'
      ])
        await reject(() => service.mine(token(11), new URL('http://test?' + query)), 'VALIDATION_ERROR');
      await reject(() => service.mine(), 'UNAUTHENTICATED');
      const other = await service.mine(token(12));
      assert.ok(other.registered.every((x) => x.myRegistration?.participant.id === f.ids[12]));
      assert.ok(other.published.every((x) => x.organizer.id === f.ids[12]));
      assert.ok([...other.registered, ...other.published].every((x) => !seeded.some((r) => r.id === x.id)));
    }
  );
}
export async function eightHttpCases({ f, check, call, headers, post, data, body, origin }) {
  const patch = (a, b, i = 7, extra = {}) =>
    call('/api/activities/' + a.id + '/registrations', {
      method: 'PATCH',
      headers: {
        ...(i === null ? {} : headers(i)),
        origin,
        'content-type': 'application/json',
        'x-artzoo-request': '1',
        ...extra
      },
      body: JSON.stringify(b)
    });
  const create = async () =>
    (
      await data(
        await post(
          '/api/activities',
          {
            ...body,
            idempotencyKey: randomUUID(),
            seats: [{ kind: 'ANY' }, { kind: 'ROLE', role: 'HEALER' }, { kind: 'ANY' }]
          },
          6
        )
      )
    ).activity;
  const signup = (a, i, position = 0) =>
    post('/api/activities/' + a.id + '/registrations', { seatId: a.seats[position].id, job: '骑士' }, i);
  let a, change, registration;
  await check('MOVE HTTP PATCH boundary validates auth origin marker and strict body', async () => {
    a = await create();
    registration = (await data(await signup(a, 7))).activity.myRegistration;
    change = { expectedSeatId: a.seats[0].id, seatId: a.seats[1].id, job: '白魔法师' };
    assert.equal((await patch(a, change, null)).status, 401);
    for (const extra of [
      { origin: 'http://evil.invalid' },
      { 'x-artzoo-request': '0' },
      { 'sec-fetch-site': 'cross-site' }
    ])
      assert.equal((await patch(a, change, 7, extra)).status, 403);
    for (const b of [
      { ...change, accountId: f.ids[8] },
      { seatId: change.seatId, job: change.job },
      { ...change, job: '骑士' }
    ])
      assert.equal((await patch(a, b)).status, 400);
    assert.equal((await patch(a, change, 8)).status, 409);
  });
  await check('MOVE HTTP updates one registration and duplicate creates no notification', async () => {
    const before = await f.db.activityOutbox.count({ where: { activityId: a.id } });
    const moved = await data(await patch(a, change));
    assert.equal(moved.replayed, false);
    assert.equal(moved.activity.myRegistration.id, registration.id);
    assert.equal(moved.activity.seats[0].registration, null);
    assert.equal(moved.activity.myRegistration.job, '白魔法师');
    assert.equal((await data(await patch(a, change))).replayed, true);
    assert.equal(await f.db.activityOutbox.count({ where: { activityId: a.id } }), before);
    assert.equal(
      (await patch(a, { expectedSeatId: a.seats[0].id, seatId: a.seats[2].id, job: '骑士' })).status,
      409
    );
  });
  await check(
    'MOVE HTTP races new signup for one destination without losing original registration',
    async () => {
      const race = await create();
      await data(await signup(race, 7));
      const responses = await Promise.all([
        patch(race, { expectedSeatId: race.seats[0].id, seatId: race.seats[2].id, job: '骑士' }),
        signup(race, 8, 2)
      ]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      const d = await data(await call('/api/activities/' + race.id, { headers: headers(7) }));
      assert.equal(d.myRegistration.seatId, race.seats[responses[0].status === 200 ? 2 : 0].id);
      assert.equal(d.registeredCount, responses[0].status === 200 ? 1 : 2);
    }
  );
  await check('MOVE HTTP after cutoff denies and original seat survives', async () => {
    await f.db.activity.update({
      where: { id: a.id },
      data: { startsAt: new Date(Date.now() + 10 * 60000), endsAt: new Date(Date.now() + 3600000) }
    });
    assert.equal(
      (await patch(a, { expectedSeatId: a.seats[1].id, seatId: a.seats[2].id, job: '骑士' })).status,
      403
    );
    assert.equal(
      (await data(await call('/api/activities/' + a.id, { headers: headers(7) }))).myRegistration.seatId,
      a.seats[1].id
    );
  });
  const seeded = await seedPagination(f, new Date()),
    current = order(seeded, false),
    history = order(seeded, true);
  await check('MINE HTTP independent bounded DB pages periods and clamping', async () => {
    const mine = await data(
      await call('/api/me/activities?registeredPage=2&publishedPeriod=history', { headers: headers(11) })
    );
    assert.deepEqual(
      mine.registered.map((x) => x.id),
      current.slice(10, 20)
    );
    assert.deepEqual(mine.registeredPagination, {
      page: 2,
      pageSize: 10,
      total: 23,
      totalPages: 3,
      period: 'current'
    });
    assert.equal(mine.publishedPagination.total, 0);
    const past = await data(
      await call('/api/me/activities?registeredPeriod=history&registeredPage=999', { headers: headers(11) })
    );
    assert.deepEqual(
      past.registered.map((x) => x.id),
      history.slice(10)
    );
    assert.equal(past.registeredPagination.page, 2);
    assert.equal(past.publishedPagination.total, 5);
    const owner = await data(
      await call('/api/me/activities?publishedPeriod=history', { headers: headers(10) })
    );
    assert.deepEqual(
      owner.published.map((x) => x.id),
      history.slice(0, 10)
    );
  });
  await check('MINE HTTP invalid queries and unrelated account exclude private pages', async () => {
    for (const query of ['registeredPage=0', 'publishedPage=1.1', 'registeredPeriod=all'])
      assert.equal((await call('/api/me/activities?' + query, { headers: headers(11) })).status, 400);
    assert.equal((await call('/api/me/activities?registeredPeriod=history')).status, 401);
    const unrelated = await data(await call('/api/me/activities', { headers: headers(12) }));
    assert.equal(unrelated.registered.length, 0);
    assert.equal(unrelated.published.length, 0);
    assert.equal(unrelated.registeredPagination.total, 0);
  });
}
