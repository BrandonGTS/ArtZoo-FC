// Execute the real list service with an in-memory Prisma query interpreter. No DB or session is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityService, activitySummary } from '../../apps/web/server/activities/service.ts';
const now = new Date('2030-01-01T00:00:00Z');
const row = (id, extra = {}) => ({
  id,
  title: id,
  description: 'synthetic',
  category: 'SOCIAL',
  scene: 'GAME',
  mode: 'SINGLE',
  startsAt: new Date(+now + 3600000),
  endsAt: new Date(+now + 7200000),
  registrationClosesAt: null,
  createdAt: new Date(+now - 86400000),
  organizerId: 'owner',
  organizer: { id: 'owner', displayName: 'Synthetic', profile: null },
  cancelledAt: null,
  capacityUnlimited: false,
  seats: [{ id: id + '-seat', position: 0, kind: 'ANY', registration: null }],
  registrations: [],
  ...extra
});
function matches(value, where) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return condition.every((part) => matches(value, part));
    if (key === 'OR') return condition.some((part) => matches(value, part));
    const actual = value[key];
    if (condition === null) return actual === null;
    if (typeof condition !== 'object') return actual === condition;
    if ('gt' in condition) return actual > condition.gt;
    if ('gte' in condition || 'lt' in condition)
      return (
        (!('gte' in condition) || actual >= condition.gte) && (!('lt' in condition) || actual < condition.lt)
      );
    if ('some' in condition) return actual.some((item) => matches(item, condition.some));
    if ('is' in condition) return actual === condition.is;
    return actual !== null && matches(actual, condition);
  });
}
function fixture(rows) {
  const queries = [];
  const tx = {
    activity: {
      findMany: async (query) => {
        queries.push(query);
        assert.deepEqual(query.orderBy, [{ startsAt: 'asc' }, { id: 'asc' }]);
        const eligible = rows
          .filter((item) => matches(item, query.where))
          .sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
        return query.take ? eligible.slice(0, query.take) : eligible;
      }
    }
  };
  const auth = {
    now: () => now,
    requireAccount: async () => ({ accountId: 'viewer' }),
    transaction: (fn) => fn(tx)
  };
  return { service: new ActivityService(auth), queries };
}
for (const [name, cutoff, expected] of [
  ['past', new Date(+now - 1), false],
  ['exact', now, false],
  ['future', new Date(+now + 1), true],
  ['legacy-null', null, true]
]) {
  test('upcoming respects ' + name + ' explicit GAME cutoff before take3', async () => {
    const f = fixture([row('one', { registrationClosesAt: cutoff })]);
    const result = await f.service.list(new URL('https://synthetic/api/activities?upcoming=1'), 'synthetic');
    assert.deepEqual(
      result.items.map((item) => item.id),
      expected ? ['one'] : []
    );
    if (expected) assert.equal(result.items[0].status, 'OPEN');
    assert.equal(f.queries[0].take, 3);
  });
}
test('three closed legacy records no longer consume all three homepage slots', async () => {
  const closed = ['a', 'b', 'c'].map((id) => row(id, { registrationClosesAt: new Date(+now - 86400000) }));
  assert.ok(closed.every((item) => activitySummary(item, 'viewer', now).status === 'REGISTRATION_CLOSED'));
  const f = fixture([...closed, row('d'), row('e'), row('f'), row('g')]);
  const result = await f.service.list(new URL('https://synthetic/api/activities?upcoming=1'), 'synthetic');
  assert.deepEqual(
    result.items.map((item) => item.id),
    ['d', 'e', 'f']
  );
  assert.ok(result.items.every((item) => item.status === 'OPEN'));
});
test('legacy-null still excludes start at or inside thirty-minute cutoff', async () => {
  const f = fixture([
    row('past', { startsAt: new Date(+now + 29 * 60000) }),
    row('exact', { startsAt: new Date(+now + 30 * 60000) }),
    row('later')
  ]);
  assert.deepEqual(
    (await f.service.list(new URL('https://synthetic/?upcoming=1'), 'synthetic')).items.map(
      (item) => item.id
    ),
    ['later']
  );
});
test('series first-period recruiting, vacancies, offline cutoff and cancellation restrictions stay intact', async () => {
  const series = (state) => ({ id: 'series', state, formedAt: null, totalPeriods: 2, activities: [] });
  const f = fixture([
    row('formed', { mode: 'SERIES', periodNumber: 1, series: series('FORMED') }),
    row('second', { mode: 'SERIES', periodNumber: 2, series: series('RECRUITING') }),
    row('cancelled', { cancelledAt: now }),
    row('full', { seats: [{ registration: {} }] }),
    row('offline-closed', { scene: 'OFFLINE', registrationClosesAt: now }),
    row('recruiting', { mode: 'SERIES', periodNumber: 1, series: series('RECRUITING') }),
    row('offline', { scene: 'OFFLINE', registrationClosesAt: new Date(+now + 1) }),
    row('unlimited', { capacityUnlimited: true, seats: [] })
  ]);
  assert.deepEqual(
    (await f.service.list(new URL('https://synthetic/?upcoming=1'), 'synthetic')).items.map(
      (item) => item.id
    ),
    ['offline', 'recruiting', 'unlimited']
  );
});
test('monthly calendar read keeps legacy closed records; only upcoming selection is narrowed', async () => {
  const f = fixture([row('legacy', { registrationClosesAt: new Date(+now - 1) })]);
  assert.equal(
    (await f.service.list(new URL('https://synthetic/?month=2030-01'), 'synthetic')).items.length,
    1
  );
  assert.equal(f.queries[0].take, undefined);
});

test('explicit future GAME cutoff remains authoritative inside the fallback window', async () => {
  const f = fixture([
    row('explicit', { startsAt: new Date(+now + 10 * 60000), registrationClosesAt: new Date(+now + 1) }),
    row('null', { startsAt: new Date(+now + 10 * 60000) })
  ]);
  const result = await f.service.list(new URL('https://synthetic/?upcoming=1'), 'synthetic');
  assert.deepEqual(
    result.items.map((item) => item.id),
    ['explicit']
  );
  assert.equal(result.items[0].status, 'OPEN');
});
test('explicit future cutoff does not include already-started GAME activities', async () => {
  const f = fixture([row('started', { startsAt: now, registrationClosesAt: new Date(+now + 60000) })]);
  assert.deepEqual((await f.service.list(new URL('https://synthetic/?upcoming=1'), 'synthetic')).items, []);
});
