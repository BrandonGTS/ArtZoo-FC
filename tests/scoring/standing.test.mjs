import test from 'node:test';
import assert from 'node:assert/strict';
import { settleActivityStanding, addActivityPenaltyPoints } from '../../packages/db/src/activity-standing.ts';

function fixture(points = 0, decayAt = null) {
  const account = { activityPoints: points, activityDecayAt: decayAt },
    events = [];
  const tx = {
    $queryRaw: async () => [structuredClone(account)],
    account: { update: async ({ data }) => Object.assign(account, data) },
    activityScoreChange: {
      create: async ({ data }) => {
        assert.ok(!events.some((e) => e.eventKey === data.eventKey));
        events.push(structuredClone(data));
        return data;
      }
    }
  };
  return { account, events, tx };
}
const entered = new Date('2030-06-01T10:00:00Z'),
  due = new Date('2030-06-08T10:00:00Z');
test('unrestricted points do not decay and zero remains zero', async () => {
  for (const points of [0, 1, 2]) {
    const f = fixture(points);
    assert.equal((await settleActivityStanding(f.tx, 'a', due)).points, points);
    assert.equal(f.events.length, 0);
  }
});
for (const [delta, expected] of [
  [-1, 3],
  [0, 2],
  [1, 2]
])
  test('natural decay exact seven-day boundary ' + delta, async () => {
    const f = fixture(3, due),
      result = await settleActivityStanding(f.tx, 'a', new Date(due.getTime() + delta));
    assert.equal(result.points, expected);
    assert.equal(f.account.activityPoints, expected);
    assert.deepEqual(result.decayAt, expected < 3 ? null : due);
    if (expected < 3) assert.deepEqual(f.events[0].notices, ['POINTS_CHANGED', 'RESTRICTION_ENDED']);
  });
test('restriction remains at three after one interval then ends immediately below three', async () => {
  const f = fixture(4, due);
  const first = await settleActivityStanding(f.tx, 'a', due);
  assert.equal(first.points, 3);
  assert.equal(first.decayAt.toISOString(), '2030-06-15T10:00:00.000Z');
  const next = await settleActivityStanding(f.tx, 'a', first.decayAt);
  assert.equal(next.points, 2);
  assert.equal(next.decayAt, null);
  assert.equal(f.events.length, 2);
  assert.deepEqual(f.events[0].notices, ['POINTS_CHANGED']);
});
test('catchup stops below three and emits one current state record instead of historical notices', async () => {
  const f = fixture(8, due),
    result = await settleActivityStanding(f.tx, 'a', new Date('2030-09-01T10:00:00Z'));
  assert.equal(result.points, 2);
  assert.equal(result.decayAt, null);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].delta, -6);
  await settleActivityStanding(f.tx, 'a', new Date('2030-10-01T10:00:00Z'));
  assert.equal(f.events.length, 1);
});
test('penalties enter restriction at exactly three and preserve the existing reduction schedule', async () => {
  const f = fixture(1);
  await addActivityPenaltyPoints(f.tx, 'a', 2, entered, 'cancel-1', 'p1');
  assert.equal(f.account.activityPoints, 3);
  assert.equal(f.account.activityDecayAt.toISOString(), due.toISOString());
  assert.deepEqual(f.events[0].notices, ['RESTRICTION_STARTED']);
  await addActivityPenaltyPoints(f.tx, 'a', 1, new Date('2030-06-02T10:00:00Z'), 'withdraw-1', 'p2');
  assert.equal(f.account.activityPoints, 4);
  assert.equal(f.account.activityDecayAt.toISOString(), due.toISOString());
  assert.deepEqual(f.events[1].notices, []);
});
test('due decay settles before adding a new penalty and reentry starts a new seven-day interval', async () => {
  const f = fixture(3, due);
  await addActivityPenaltyPoints(f.tx, 'a', 1, due, 'withdraw-2', 'p3');
  assert.equal(f.account.activityPoints, 3);
  assert.equal(f.account.activityDecayAt.toISOString(), '2030-06-15T10:00:00.000Z');
  assert.deepEqual(
    f.events.map((e) => e.reason),
    ['NATURAL_DECAY', 'PENALTY']
  );
});
