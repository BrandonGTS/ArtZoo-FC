import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountError } from '../../packages/domain/src/index.ts';
import { ActivityService } from '../../apps/web/server/activities/service.ts';
import { id } from './support/activity-input.mjs';

function harness(actorId = id(9), adminRole = 'NONE') {
  let allowed = true,
    exists = true;
  const queries = [];
  const records = Array.from({ length: 25 }, (_, i) => ({
    id: id(100 + i),
    activityId: i === 24 ? id(2) : id(1),
    actorId: i === 0 ? null : i % 2 ? id(7) : id(8),
    actor: i === 0 ? null : { displayName: i % 2 ? 'Member A' : 'Member B', phone: 'private-phone' },
    kind: i === 0 ? 'AUTO_CANCEL' : i % 2 ? 'WITHDRAW' : 'EDIT',
    before: { private: 'hidden-before' },
    after: { private: 'hidden-after' },
    idempotencyKey: 'private-key',
    requestFingerprint: 'private-fingerprint',
    createdAt: new Date('2030-06-01T10:00:00Z')
  }));
  const filtered = (where) =>
    records.filter(
      (x) =>
        x.activityId === where.activityId && (!Object.hasOwn(where, 'actorId') || x.actorId === where.actorId)
    );
  const tx = {
    activity: {
      findUnique: async (q) => {
        queries.push(['activity', q]);
        return exists && q.where.id === id(1) ? { organizerId: id(9), cancelledAt: new Date() } : null;
      }
    },
    activityCommand: {
      count: async (q) => {
        queries.push(['count', q]);
        return filtered(q.where).length;
      },
      findMany: async (q) => {
        queries.push(['find', q]);
        return filtered(q.where)
          .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
          .slice(q.skip, q.skip + q.take);
      }
    }
  };
  const auth = {
    requireAccount: async () => {
      if (!allowed) throw new AccountError('UNAUTHENTICATED', 'Login', 401);
      return { accountId: actorId, account: { adminRole } };
    },
    db: {
      $transaction: async (fn, options) => {
        assert.equal(options.isolationLevel, 'RepeatableRead');
        return fn(tx);
      }
    }
  };
  const service = new ActivityService(auth);
  return {
    queries,
    records,
    read: (query = '', key = id(1)) =>
      service.history(key, new URL('http://localhost/history' + query), 'token'),
    deny: () => (allowed = false),
    missing: () => (exists = false)
  };
}
test('organizer sees all commands including system and canceled activity with stable paginated ordering', async () => {
  const h = harness(),
    a = await h.read(),
    b = await h.read('?page=2');
  assert.equal(a.scope, 'activity');
  assert.equal(a.total, 24);
  assert.equal(a.items.length, 20);
  assert.equal(b.items.length, 4);
  assert.equal(new Set([...a.items, ...b.items].map((x) => x.id)).size, 24);
  assert.equal(b.items.at(-1).actorName, '系统');
  const query = h.queries.find((x) => x[0] === 'find')[1];
  assert.deepEqual(query.where, { activityId: id(1) });
  assert.deepEqual(query.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  assert.equal(query.take, 20);
});
for (const role of ['NONE', 'ADMIN', 'SUPER_ADMIN'])
  test(
    'non-organizer ' + role + ' only receives own commands; forged scope and actor do not widen access',
    async () => {
      const h = harness(id(7), role),
        result = await h.read('?scope=activity&actorId=' + id(8));
      assert.equal(result.scope, 'own');
      assert.equal(result.total, 12);
      assert.ok(result.items.every((x) => x.actorName === 'Member A'));
      for (const [kind, q] of h.queries)
        if (kind !== 'activity') assert.deepEqual(q.where, { activityId: id(1), actorId: id(7) });
    }
  );
test('history selects and returns only readable fields, never internal snapshots keys fingerprints or account metadata', async () => {
  const h = harness(),
    result = await h.read();
  const query = h.queries.find((x) => x[0] === 'find')[1];
  assert.deepEqual(Object.keys(query.select).sort(), ['actor', 'createdAt', 'id', 'kind']);
  assert.deepEqual(query.select.actor, { select: { displayName: true } });
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['action', 'actorName', 'createdAt', 'id']);
  assert.doesNotMatch(
    JSON.stringify(result),
    /hidden-|private-|before|after|idempotency|requestFingerprint|phone/
  );
});
test('user without own history receives a truthful empty result; high page clamps safely', async () => {
  const h = harness(id(77)),
    result = await h.read('?page=999');
  assert.deepEqual(result.items, []);
  assert.equal(result.total, 0);
  assert.equal(result.page, 1);
  assert.equal(result.scope, 'own');
  const owner = await harness().read('?page=999');
  assert.equal(owner.page, 2);
  assert.equal(owner.items.length, 4);
});
test('unauthenticated and missing activity history cannot be enumerated', async () => {
  const h = harness();
  h.deny();
  await assert.rejects(
    () => h.read(),
    (e) => e.code === 'UNAUTHENTICATED'
  );
  assert.equal(h.queries.length, 0);
  for (const key of ['bad', id(2)])
    await assert.rejects(
      () => harness().read('', key),
      (e) => e.code === 'NOT_FOUND'
    );
});
test('invalid pages reject before command queries', async () => {
  for (const page of ['0', '-1', '1.5', '01', 'x', '9007199254740992']) {
    const h = harness();
    await assert.rejects(
      () => h.read('?page=' + page),
      (e) => e.code === 'VALIDATION_ERROR'
    );
    assert.equal(
      h.queries.some((q) => q[0] === 'count'),
      false
    );
  }
});

test('completion settlement uses the existing system history label without widening member access', async () => {
  const owner = harness();
  owner.records[0].kind = 'AUTO_COMPLETION';
  const result = await owner.read('?page=2');
  const system = result.items.find((row) => row.id === id(100));
  assert.equal(system.actorName, '系统');
  assert.equal(system.action, '系统结算正常完成');
  const member = harness(id(7));
  member.records[0].kind = 'AUTO_COMPLETION';
  assert.equal(
    (await member.read()).items.some((row) => row.id === id(100)),
    false
  );
});
