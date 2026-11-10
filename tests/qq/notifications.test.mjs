import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  planQqActivityNotifications,
  qqFirstPeriodId,
  qqScheduleFingerprint,
  qqNotificationEventKey,
  validateQqDelivery,
  qqDeliveryOutcomeTransition,
  claimQqDelivery,
  beginQqDelivery,
  completeQqDelivery,
  recoverQqDeliveryLeases,
  enqueueQqActivityNotifications
} from '../../packages/db/src/qq-official-notifications.ts';

const now = new Date('2030-06-01T00:00:00Z');
const target = {
  appId: 'app',
  botId: 'bot',
  groupOpenId: 'test-group',
  enabled: true,
  enabledAt: new Date('2030-05-01T00:00:00Z'),
  testGroupOnly: true
};
const activity = (extra = {}) => ({
  id: 'activity',
  revision: 4,
  title: '活动',
  scene: 'GAME',
  mode: 'SINGLE',
  startsAt: new Date('2030-06-01T04:00:00Z'),
  endsAt: new Date('2030-06-01T06:00:00Z'),
  createdAt: new Date('2030-05-20T00:00:00Z'),
  cancelledAt: null,
  ...extra
});
const delivery = (plan, extra = {}) => ({
  id: 'delivery',
  ...plan,
  status: 'CLAIMED',
  attempts: 1,
  fence: 1,
  leaseOwner: null,
  leaseUntil: new Date(now.getTime() + 30000),
  dispatchedAt: null,
  sentAt: null,
  resultCode: null,
  providerMessageId: null,
  createdAt: now,
  updatedAt: now,
  ...extra
});
const reminders = (plans) => plans.filter((row) => row.kind.startsWith('REMINDER_'));

for (const scene of ['GAME', 'OFFLINE'])
  for (const mode of ['SINGLE', 'SERIES'])
    test(scene + ' ' + mode + ' plans publish plus 2h/1h at absolute UTC instants', () => {
      const row = activity({
        scene,
        mode,
        ...(mode === 'SERIES'
          ? {
              seriesId: 'series',
              periodNumber: 1,
              series: {
                activities: [
                  { id: 'second', periodNumber: 2 },
                  { id: 'activity', periodNumber: 1 }
                ]
              }
            }
          : {})
      });
      const plans = planQqActivityNotifications(row, 'PUBLISHED', target, now);
      assert.deepEqual(
        plans.map((row) => row.kind),
        ['PUBLISHED', 'REMINDER_2H', 'REMINDER_1H']
      );
      assert.deepEqual(
        reminders(plans).map((row) => [row.dueAt.toISOString(), row.expiresAt.toISOString()]),
        [
          ['2030-06-01T02:00:00.000Z', '2030-06-01T02:01:00.000Z'],
          ['2030-06-01T03:00:00.000Z', '2030-06-01T03:01:00.000Z']
        ]
      );
    });
test('series always chooses lowest original period number even when past/cancelled; never next remaining', () => {
  const row = activity({
    id: 'second',
    mode: 'SERIES',
    periodNumber: 2,
    seriesId: 'series',
    series: {
      activities: [
        { id: 'second', periodNumber: 2 },
        { id: 'original', periodNumber: 1 }
      ]
    }
  });
  assert.equal(qqFirstPeriodId(row), 'original');
  assert.equal(reminders(planQqActivityNotifications(row, 'PUBLISHED', target, now)).length, 0);
  assert.equal(
    reminders(planQqActivityNotifications({ ...row, series: null }, 'PUBLISHED', target, now)).length,
    0
  );
});
test('near start never catches up overdue reminders and publish expiry is capped by start', () => {
  for (const minutes of [59, 1, 0, -1]) {
    const row = activity({ startsAt: new Date(now.getTime() + minutes * 60000) });
    const plans = planQqActivityNotifications(row, 'PUBLISHED', target, now);
    assert.equal(reminders(plans).length, 0);
    assert.equal(plans.length, minutes > 0 ? 1 : 0);
    if (minutes === 1) assert.equal(plans[0].expiresAt.getTime(), row.startsAt.getTime());
  }
  const between = activity({ startsAt: new Date(now.getTime() + 90 * 60000) });
  assert.deepEqual(
    reminders(planQqActivityNotifications(between, 'PUBLISHED', target, now)).map((row) => row.kind),
    ['REMINDER_1H']
  );
});
test('enablement and test-group gates are forward only; actual future changes/cancels still allowed', () => {
  const old = activity({ createdAt: new Date('2030-04-01T00:00:00Z') });
  assert.equal(planQqActivityNotifications(old, 'PUBLISHED', target, now).length, 0);
  assert.equal(planQqActivityNotifications(old, 'REMINDERS', target, now).length, 0);
  assert.deepEqual(
    planQqActivityNotifications(old, 'CHANGED', target, now).map((row) => row.kind),
    ['CHANGED']
  );
  assert.deepEqual(
    planQqActivityNotifications({ ...old, cancelledAt: now }, 'CANCELLED', target, now).map(
      (row) => row.kind
    ),
    ['CANCELLED']
  );
  for (const patch of [
    { enabled: false },
    { testGroupOnly: false },
    { enabledAt: new Date('2031-01-01') },
    { appId: '' },
    { groupOpenId: '' }
  ])
    assert.equal(
      planQqActivityNotifications(activity(), 'PUBLISHED', { ...target, ...patch }, now).length,
      0
    );
});
test('cancel removes publication/reminders; cancellation has one short event and cannot reactivate activity', () => {
  const cancelled = activity({ cancelledAt: now });
  assert.equal(planQqActivityNotifications(cancelled, 'PUBLISHED', target, now).length, 0);
  assert.equal(planQqActivityNotifications(cancelled, 'REMINDERS', target, now).length, 0);
  const plan = planQqActivityNotifications(cancelled, 'CANCELLED', target, now);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].expiresAt.getTime(), now.getTime() + 600000);
  assert.equal(validateQqDelivery(delivery(plan[0]), activity(), target, now), 'CANCELLED');
});
test('reschedule invalidates old schedule; registration-only revision preserves reminder validity', () => {
  const original = activity(),
    plan = planQqActivityNotifications(original, 'REMINDERS', target, now)[0];
  const atDue = plan.dueAt;
  assert.equal(validateQqDelivery(delivery(plan), activity({ revision: 999 }), target, atDue), 'VALID');
  assert.equal(
    validateQqDelivery(
      delivery(plan),
      activity({ startsAt: new Date('2030-06-01T05:00:00Z') }),
      target,
      atDue
    ),
    'CANCELLED'
  );
  assert.equal(
    validateQqDelivery(delivery(plan), activity({ cancelledAt: atDue }), target, atDue),
    'CANCELLED'
  );
  assert.equal(
    validateQqDelivery(delivery(plan), activity({ title: '已修改标题' }), target, atDue),
    'CANCELLED'
  );
  assert.equal(
    validateQqDelivery(delivery(plan), activity({ location: '已修改地点' }), target, atDue),
    'CANCELLED'
  );
  assert.equal(validateQqDelivery(delivery(plan), activity({ id: 'wrong' }), target, atDue), 'CANCELLED');
  assert.equal(validateQqDelivery(delivery(plan), original, target, plan.expiresAt), 'EXPIRED');
});
test('delivery rejects changed target, re-enable epoch, and formal/non-test configuration', () => {
  const plan = planQqActivityNotifications(activity(), 'PUBLISHED', target, now)[0],
    row = delivery(plan);
  for (const patch of [
    { botId: 'other' },
    { appId: 'other' },
    { groupOpenId: 'other' },
    { enabled: false },
    { testGroupOnly: false },
    { enabledAt: new Date(now.getTime() + 1) }
  ])
    assert.equal(
      validateQqDelivery(row, activity(), { ...target, ...patch }, new Date(now.getTime() + 2)),
      'DENIED'
    );
});
test('UTC schedules remain stable across host timezones and DST transitions', () => {
  const previous = process.env.TZ;
  try {
    const results = [];
    for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/Berlin']) {
      process.env.TZ = tz;
      const row = activity({
        startsAt: new Date('2030-03-10T15:00:00+08:00'),
        endsAt: new Date('2030-03-10T18:00:00+08:00'),
        createdAt: new Date('2030-03-01T00:00:00Z')
      });
      const plans = planQqActivityNotifications(
        row,
        'PUBLISHED',
        { ...target, enabledAt: new Date('2030-02-01T00:00:00Z') },
        new Date('2030-03-10T00:00:00Z')
      );
      results.push(plans.map((row) => [row.dueAt.toISOString(), row.expiresAt.toISOString()]));
    }
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.equal(results[0][1][0], '2030-03-10T05:00:00.000Z');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
test('event keys scope bot/app/group/activity/revision/kind without delimiter collisions', () => {
  const baseline = qqNotificationEventKey(target, activity(), 'PUBLISHED');
  assert.equal(baseline, qqNotificationEventKey(target, activity(), 'PUBLISHED'));
  for (const patch of [{ botId: 'b' }, { appId: 'a' }, { groupOpenId: 'g' }])
    assert.notEqual(baseline, qqNotificationEventKey({ ...target, ...patch }, activity(), 'PUBLISHED'));
  assert.notEqual(baseline, qqNotificationEventKey(target, activity({ revision: 5 }), 'PUBLISHED'));
  assert.notEqual(baseline, qqNotificationEventKey(target, activity(), 'CHANGED'));
  assert.notEqual(
    qqNotificationEventKey({ ...target, appId: 'a:b', botId: 'c' }, activity(), 'PUBLISHED'),
    qqNotificationEventKey({ ...target, appId: 'a', botId: 'b:c' }, activity(), 'PUBLISHED')
  );
});
test('uncertain dispatch and no permission are terminal; only definite safe pre-send failure retries bounded', () => {
  const row = { attempts: 1, expiresAt: new Date(now.getTime() + 60000) };
  for (const outcome of [{ kind: 'UNKNOWN' }, { kind: 'DENIED' }]) {
    const next = qqDeliveryOutcomeTransition(row, outcome, now);
    assert.equal(next.status, outcome.kind);
    assert.equal(next.dueAt, null);
  }
  assert.equal(qqDeliveryOutcomeTransition(row, { kind: 'SAFE_PRE_SEND_FAILURE' }, now).status, 'PENDING');
  assert.equal(
    qqDeliveryOutcomeTransition({ ...row, attempts: 3 }, { kind: 'SAFE_PRE_SEND_FAILURE' }, now).status,
    'FAILED'
  );
  assert.equal(
    qqDeliveryOutcomeTransition(
      { ...row, expiresAt: new Date(now.getTime() + 1000) },
      { kind: 'SAFE_PRE_SEND_FAILURE' },
      now
    ).status,
    'EXPIRED'
  );
});
test('persistent enqueue uses independent delivery table and dedup conflict key, never mock receipts', async () => {
  const calls = [],
    tx = {
      $queryRawUnsafe: async () => [],
      $executeRawUnsafe: async (sql, ...params) => {
        calls.push({ sql, params });
        return 1;
      }
    };
  assert.equal(await enqueueQqActivityNotifications(tx, activity(), 'PUBLISHED', target, now), 3);
  for (const { sql, params } of calls) {
    assert.match(sql, /INSERT INTO "QqOfficialDelivery"/);
    assert.match(sql, /ON CONFLICT \("eventKey"\) DO NOTHING/);
    assert.doesNotMatch(sql, /ActivityMockDelivery|ActivityOutbox/);
    assert.equal(params.includes(target.groupOpenId), true);
    assert.equal(sql.includes(target.groupOpenId), false);
  }
});
test('claim stores hashed opaque token, uses atomic lock/fence, and disabled target cannot mutate storage', async () => {
  const writes = [],
    queries = [],
    row = delivery(planQqActivityNotifications(activity(), 'PUBLISHED', target, now)[0]);
  const tx = {
    $executeRawUnsafe: async (sql, ...params) => {
      writes.push({ sql, params });
      return 1;
    },
    $queryRawUnsafe: async (sql, ...params) => {
      queries.push({ sql, params });
      return [row];
    }
  };
  assert.equal(await claimQqDelivery(tx, { ...target, enabled: false }, now), null);
  assert.equal(writes.length, 0);
  const claim = await claimQqDelivery(tx, target, now);
  assert.match(claim.claimToken, /^[a-f0-9]{64}$/);
  assert.equal(queries[0].params[6], createHash('sha256').update(claim.claimToken).digest('hex'));
  assert.notEqual(queries[0].params[6], claim.claimToken);
  assert.match(queries[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(queries[0].sql, /"fence" = d\."fence"\+1/);
});
test('stale/duplicate begin or completion does not transition or acknowledge delivery', async () => {
  let writes = 0;
  const tx = {
    $queryRawUnsafe: async (sql) => {
      assert.match(sql, /"fence" = \$2/);
      assert.match(sql, /"leaseOwner" = \$3/);
      return [];
    },
    $executeRawUnsafe: async () => {
      writes++;
      return 1;
    }
  };
  const identity = { id: 'delivery', fence: 1, claimToken: 'secret' };
  assert.equal(await beginQqDelivery(tx, identity, activity(), target, now), null);
  assert.equal(
    await completeQqDelivery(tx, identity, { kind: 'SENT', providerMessageId: 'provider' }, now),
    false
  );
  assert.equal(writes, 0);
});
test('expired dispatched lease recovers UNKNOWN while expired claimed lease may retry', async () => {
  let call;
  await recoverQqDeliveryLeases(
    {
      $executeRawUnsafe: async (sql, ...params) => {
        call = { sql, params };
        return 1;
      }
    },
    now
  );
  assert.match(call.sql, /WHEN "status" = 'DISPATCHING' THEN 'UNKNOWN'/);
  assert.match(call.sql, /ELSE 'PENDING'/);
  assert.match(call.sql, /"attempts" >= \$2 THEN 'FAILED'/);
  assert.match(call.sql, /"leaseUntil" <= \$1/);
});
