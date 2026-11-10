import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityService } from '../../apps/web/server/activities/service.ts';
import { id } from './support/activity-input.mjs';

const now = new Date('2030-06-01T10:00:00Z');
const person = (n) => ({ id: id(n), displayName: 'Synthetic ' + n, profile: null });
function row(n, organizer = 9, participant = 9) {
  const canceled = n <= 11 || n === 22 || n >= 27;
  const ended = n >= 12 && n <= 23;
  const registrations = [
    {
      id: id(n + 100),
      accountId: id(participant),
      status: canceled ? 'CANCELLED' : 'ACTIVE',
      job: null,
      exitedAt: canceled ? now : null
    }
  ];
  return {
    id: id(n),
    organizerId: id(organizer),
    organizer: person(organizer),
    registrations,
    title: 'Activity ' + n,
    description: '',
    category: 'SOCIAL',
    createdAt: now,
    revision: 0,
    dutySnapshot: null,
    startsAt: new Date(ended ? '2030-05-31T08:00:00Z' : '2030-06-01T12:00:00Z'),
    endsAt: n === 23 ? now : new Date(ended ? '2030-05-31T10:00:00Z' : '2030-06-01T14:00:00Z'),
    cancelledAt: canceled ? new Date('2030-06-01T09:00:00Z') : null,
    cancellationReason: canceled ? 'ORGANIZER_CANCELLED' : null,
    continuedAt: null,
    seats: [{ id: id(n + 200), position: 0, kind: 'ANY', groupKey: null, registration: null }]
  };
}
// Generic small Prisma-where evaluator: production service supplies the tested filter, not fixture classification.
function matches(value, where) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some((branch) => matches(value, branch));
    if (key === 'registrations') return value.registrations.some((item) => matches(item, condition.some));
    if (condition === null || typeof condition !== 'object' || condition instanceof Date)
      return value[key] === condition;
    return Object.entries(condition).every(([op, wanted]) =>
      op === 'not'
        ? value[key] !== wanted
        : op === 'gt'
          ? value[key] > wanted
          : op === 'lte'
            ? value[key] <= wanted
            : false
    );
  });
}
function harness() {
  const rows = Array.from({ length: 26 }, (_, i) => row(i + 1));
  rows.push(row(27, 88, 88), row(28, 88, 9), row(29, 9, 88));
  rows[0].registrations.push({ ...rows[0].registrations[0], id: id(999), status: 'WITHDRAWN' });
  const calls = [];
  const tx = {
    activity: {
      count: async (query) => {
        calls.push(['count', query]);
        return rows.filter((item) => matches(item, query.where)).length;
      },
      findMany: async (query) => {
        calls.push(['rows', query]);
        return rows
          .filter((item) => matches(item, query.where))
          .sort((a, b) => {
            for (const order of query.orderBy) {
              const [field, direction] = Object.entries(order)[0],
                diff = field === 'id' ? a.id.localeCompare(b.id) : a[field] - b[field];
              if (diff) return direction === 'desc' ? -diff : diff;
            }
            return 0;
          })
          .slice(query.skip, query.skip + query.take);
      }
    },
    activityOutbox: { findMany: async () => [] }
  };
  const auth = {
    now: () => now,
    requireAccount: async () => ({ accountId: id(9) }),
    db: {
      $transaction: async (fn, options) => {
        assert.equal(options.isolationLevel, 'RepeatableRead');
        return fn(tx);
      }
    }
  };
  const service = new ActivityService(auth);
  return { rows, calls, read: (query) => service.mine('token', new URL('http://local/me?' + query)) };
}
for (const kind of ['registered', 'published'])
  test(
    'mine ' +
      kind +
      ' current excludes canceled and history retains future/past cancellations exactly once across pages',
    async () => {
      const h = harness(),
        other = kind === 'registered' ? 28 : 29;
      const current = await h.read(kind + 'Period=current');
      assert.deepEqual(
        current[kind].map((x) => x.id),
        [24, 25, 26].map(id)
      );
      assert.equal(current[kind + 'Pagination'].total, 3);
      const all = [];
      for (let page = 1; page <= 3; page++) {
        const result = await h.read(kind + 'Period=history&' + kind + 'Page=' + page);
        assert.deepEqual(result[kind + 'Pagination'], {
          page,
          pageSize: 10,
          total: 24,
          totalPages: 3,
          period: 'history'
        });
        assert.equal(result[kind].length, page === 3 ? 4 : 10);
        all.push(...result[kind].map((x) => x.id));
      }
      assert.equal(new Set(all).size, 24);
      assert.deepEqual(
        [...all].sort(),
        [...Array.from({ length: 23 }, (_, i) => id(i + 1)), id(other)].sort()
      );
      assert.equal(all.includes(id(27)), false);
      assert.equal(
        current[kind].some((x) => all.includes(x.id)),
        false
      );
      assert.equal(h.rows.length, 29);
      assert.equal(h.rows[0].registrations.length, 2);
      const countFilters = h.calls.filter((x) => x[0] === 'count').map((x) => JSON.stringify(x[1].where));
      for (const [, query] of h.calls.filter((x) => x[0] === 'rows'))
        assert.ok(countFilters.includes(JSON.stringify(query.where)));
    }
  );
test('canceling a future activity moves it from current to history in both sections and clamps stale pages', async () => {
  const h = harness();
  h.rows.find((x) => x.id === id(24)).cancelledAt = now;
  const current = await h.read('registeredPage=99&publishedPage=99');
  for (const kind of ['registered', 'published']) {
    assert.deepEqual(
      current[kind].map((x) => x.id),
      [25, 26].map(id)
    );
    assert.equal(current[kind + 'Pagination'].total, 2);
    assert.equal(current[kind + 'Pagination'].page, 1);
  }
  const past = await h.read(
    'registeredPeriod=history&publishedPeriod=history&registeredPage=99&publishedPage=99'
  );
  for (const kind of ['registered', 'published'])
    assert.deepEqual(past[kind + 'Pagination'], {
      page: 3,
      pageSize: 10,
      total: 25,
      totalPages: 3,
      period: 'history'
    });
  const archived = { registered: [], published: [] };
  for (let page = 1; page <= 3; page++) {
    const result = await h.read(
      'registeredPeriod=history&publishedPeriod=history&registeredPage=' + page + '&publishedPage=' + page
    );
    for (const kind of ['registered', 'published']) archived[kind].push(...result[kind]);
  }
  for (const kind of ['registered', 'published']) {
    assert.equal(archived[kind].filter((x) => x.id === id(24)).length, 1);
    assert.equal(new Set(archived[kind].map((x) => x.id)).size, 25);
  }
  assert.equal(h.rows.length, 29);
});
