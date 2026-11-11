import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountError } from '../../packages/domain/src/index.ts';
import { ActivityService } from '../../apps/web/server/activities/service.ts';
import { id } from './support/activity-input.mjs';
// Synthetic persistence adapter executes the production service; database races are covered separately.
const now = new Date('2030-06-01T10:00:00Z');
const person = (n) => ({ id: id(n), displayName: 'Synthetic ' + n, profile: null });
function harness() {
  let row = {
    id: id(1),
    title: 'Move fixture',
    description: '',
    category: 'DUNGEON',
    dutySnapshot: null,
    organizerId: id(90),
    organizer: person(90),
    createdAt: now,
    startsAt: new Date('2030-06-01T12:00:00Z'),
    endsAt: new Date('2030-06-01T14:00:00Z'),
    seats: [
      {
        id: id(2),
        position: 0,
        kind: 'ROLE',
        role: 'TANK',
        groupKey: null,
        registration: {
          id: id(5),
          seatId: id(2),
          accountId: id(9),
          job: '骑士',
          createdAt: now,
          account: person(9)
        }
      },
      { id: id(3), position: 1, kind: 'ROLE', role: 'HEALER', groupKey: null, registration: null },
      {
        id: id(4),
        position: 2,
        kind: 'ANY',
        groupKey: null,
        registration: {
          id: id(6),
          seatId: id(4),
          accountId: id(8),
          job: '骑士',
          createdAt: now,
          account: person(8)
        }
      }
    ]
  };
  let authenticated = true,
    actorId = id(9),
    clock = now,
    fail = false;
  const writes = [],
    events = [];
  const tx = {
    $queryRaw: async () => [],
    activity: {
      findUnique: async ({ where }) => (where.id === row.id ? row : null),
      update: async ({ data }) => {
        row.revision = (row.revision ?? 0) + (data.revision?.increment ?? 0);
        return row;
      }
    },
    activityRegistration: {
      updateMany: async ({ where, data }) => {
        writes.push({ where, data });
        if (fail) throw Error('synthetic write failure');
        const source = row.seats.find(
          (s) =>
            s.registration?.id === where.id &&
            s.registration.accountId === where.accountId &&
            s.registration.seatId === where.seatId
        );
        if (!source) return { count: 0 };
        const target = row.seats.find((s) => s.id === data.seatId);
        target.registration = { ...source.registration, ...data };
        source.registration = null;
        return { count: 1 };
      }
    },
    activityOutbox: {
      create: async (args) => {
        events.push(args);
        throw Error('move must not create notifications');
      }
    }
  };
  const auth = {
    db: tx,
    now: () => clock,
    rate: async () => {},
    requireAccount: async () => {
      if (!authenticated) throw new AccountError('UNAUTHENTICATED', 'Login', 401);
      return { id: id(99), accountId: actorId, account: { phone: 'synthetic', membership: 'MEMBER' } };
    },
    transaction: async (fn) => {
      const before = structuredClone(row);
      try {
        return await fn(tx);
      } catch (e) {
        row = before;
        throw e;
      }
    }
  };
  return {
    service: new ActivityService(auth),
    get row() {
      return row;
    },
    writes,
    events,
    setTime: (t) => (clock = new Date(t)),
    setActor: (n) => (actorId = id(n)),
    deny: () => (authenticated = false),
    fail: () => (fail = true)
  };
}
const move = { expectedSeatId: id(2), seatId: id(3), job: '白魔法师' };
test('move changes the same registration atomically and frees source with no outbox', async () => {
  const h = harness(),
    before = structuredClone(h.row.seats[0].registration),
    result = await h.service.moveRegistration(id(1), move);
  assert.equal(result.replayed, false);
  assert.equal(result.activity.seats[0].registration, null);
  assert.equal(result.activity.myRegistration.id, before.id);
  assert.equal(result.activity.myRegistration.seatId, id(3));
  assert.equal(result.activity.myRegistration.job, '白魔法师');
  assert.equal(result.activity.registeredCount, 2);
  assert.equal(h.writes.length, 1);
  assert.equal(h.events.length, 0);
  assert.equal(h.writes[0].where.seatId, id(2));
  assert.equal(h.writes[0].where.accountId, id(9));
});
test('move duplicate request and exact same-seat no-op never write twice, including after cutoff', async () => {
  const h = harness();
  assert.equal(
    (await h.service.moveRegistration(id(1), { expectedSeatId: id(2), seatId: id(2), job: '骑士' })).replayed,
    true
  );
  assert.equal(h.writes.length, 0);
  await h.service.moveRegistration(id(1), move);
  h.setTime('2030-06-01T12:00:00Z');
  assert.equal((await h.service.moveRegistration(id(1), move)).replayed, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.events.length, 0);
});
for (const [label, patch, code] of [
  ['stale source', { expectedSeatId: id(99) }, 'CONFLICT'],
  ['occupied destination', { seatId: id(4), job: '骑士' }, 'CONFLICT'],
  ['foreign destination', { seatId: id(77) }, 'VALIDATION_ERROR'],
  ['ineligible job', { job: '骑士' }, 'VALIDATION_ERROR'],
  ['same seat changed job', { seatId: id(2), job: '战士' }, 'VALIDATION_ERROR'],
  ['unknown fields', { accountId: id(8) }, 'VALIDATION_ERROR']
])
  test('move rejects ' + label + ' and preserves original registration', async () => {
    const h = harness(),
      before = structuredClone(h.row);
    await assert.rejects(
      () => h.service.moveRegistration(id(1), { ...move, ...patch }),
      (e) => e.code === code
    );
    assert.deepEqual(h.row, before);
    assert.equal(h.writes.length, 0);
    assert.equal(h.events.length, 0);
  });
test('move unauthorized or unregistered actor cannot move someone else registration', async () => {
  const h = harness();
  h.deny();
  await assert.rejects(
    () => h.service.moveRegistration(id(1), move),
    (e) => e.code === 'UNAUTHENTICATED'
  );
  const other = harness();
  other.setActor(77);
  await assert.rejects(
    () => other.service.moveRegistration(id(1), move),
    (e) => e.code === 'CONFLICT'
  );
  assert.equal(other.writes.length, 0);
});
test('move failed persistence retains original and request-arrival cutoff is authoritative', async () => {
  const h = harness(),
    before = structuredClone(h.row);
  h.fail();
  await assert.rejects(() => h.service.moveRegistration(id(1), move));
  assert.deepEqual(h.row, before);
  const late = harness();
  late.setTime('2030-06-01T11:30:01Z');
  await assert.rejects(
    () => late.service.moveRegistration(id(1), move, null, new Date('2030-06-01T11:30:00Z')),
    (e) => e.code === 'FORBIDDEN'
  );
  assert.equal(late.writes.length, 0);
  await late.service.moveRegistration(id(1), move, null, new Date('2030-06-01T11:29:59.999Z'));
  assert.equal(late.writes.length, 1);
});
test('social move accepts only null job and preserves registration identity', async () => {
  const h = harness();
  h.row.category = 'SOCIAL';
  h.row.seats[1].kind = 'ANY';
  h.row.seats[0].registration.job = null;
  await assert.rejects(
    () => h.service.moveRegistration(id(1), move),
    (e) => e.code === 'VALIDATION_ERROR'
  );
  const result = await h.service.moveRegistration(id(1), { ...move, job: null });
  assert.equal(result.activity.myRegistration.job, null);
  assert.equal(result.activity.myRegistration.id, id(5));
});
function mineHarness() {
  const calls = [],
    transactions = [];
  let permitted = true;
  const tx = {
    activity: {
      count: async (args) => {
        calls.push({ op: 'count', ...args });
        return args.where.organizerId ? 5 : 23;
      },
      findMany: async (args) => {
        calls.push({ op: 'find', ...args });
        return [];
      }
    },
    activityOutbox: { findMany: async () => [] }
  };
  const db = {
    $transaction: async (fn, options) => {
      transactions.push(options);
      return fn(tx);
    }
  };
  const auth = {
    db,
    now: () => now,
    requireAccount: async () => {
      if (!permitted) throw new AccountError('UNAUTHENTICATED', 'Login', 401);
      return { accountId: id(9) };
    }
  };
  return { service: new ActivityService(auth), calls, transactions, deny: () => (permitted = false) };
}
test('mine requests independent bounded ordered DB pages within one repeatable snapshot', async () => {
  const h = mineHarness(),
    result = await h.service.mine(null, new URL('http://test?registeredPeriod=history&registeredPage=2'));
  assert.deepEqual(result.registeredPagination, {
    page: 2,
    pageSize: 10,
    total: 23,
    totalPages: 3,
    period: 'history'
  });
  assert.equal('published' in result, false);
  assert.equal('publishedPagination' in result, false);
  assert.equal(h.transactions[0].isolationLevel, 'RepeatableRead');
  assert.equal(
    h.calls.some((c) => c.where?.organizerId),
    false
  );
  const registered = h.calls.find((c) => c.op === 'find' && c.where.registrations);
  assert.deepEqual(registered.where, {
    registrations: { some: { accountId: id(9) } },
    OR: [{ cancelledAt: { not: null } }, { endsAt: { lte: now } }]
  });
  assert.equal(registered.skip, 10);
  assert.equal(registered.take, 10);
  assert.deepEqual(registered.orderBy, [{ startsAt: 'desc' }, { id: 'asc' }]);
});
test('mine page inputs are strict positive safe integers and periods stay enumerated', async () => {
  for (const query of [
    'registeredPage=0',
    'registeredPage=-1',
    'registeredPage=1.1',
    'registeredPage=01',
    'registeredPage=9007199254740992',
    'registeredPeriod=all',
    'registeredPeriod='
  ])
    await assert.rejects(
      () => mineHarness().service.mine(null, new URL('http://test?' + query)),
      (e) => e.code === 'VALIDATION_ERROR'
    );
});
test('mine authentication is checked before any pagination data query', async () => {
  const h = mineHarness();
  h.deny();
  await assert.rejects(
    () => h.service.mine(),
    (e) => e.code === 'UNAUTHENTICATED'
  );
  assert.equal(h.calls.length, 0);
});
