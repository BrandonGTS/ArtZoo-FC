import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  processActivityCompletions,
  completionEligible,
  evaluateActivityCompletion
} from '../../packages/db/src/activity-completion.ts';
import { settleActivityStanding, replayActivityStanding } from '../../packages/db/src/activity-standing.ts';
import { harness } from './support/attendance-fixture.mjs';
import { id } from './support/activity-input.mjs';
const end = new Date('2030-06-01T14:00:00Z');
const record = (status = 'PRESENT', revision = 0) => ({
  idempotencyKey: randomUUID(),
  registrationId: id(2),
  expectedAttendanceRevision: revision,
  status
});
async function setup(status = 'PRESENT', points = 0) {
  const h = harness();
  h.state.activity.completionEnabledAt = new Date('2030-05-01');
  h.state.accounts[id(7)].activityPoints = points;
  if (points >= 3) h.state.accounts[id(7)].activityDecayAt = new Date('2030-06-08T12:00:00Z');
  if (status) await h.service.record(id(1), record(status));
  h.time(end.toISOString());
  return h;
}
async function correct(h, status) {
  h.actor(7);
  await h.service.appeal(id(1), {
    idempotencyKey: randomUUID(),
    registrationId: id(2),
    expectedAttendanceRevision: h.state.reg.attendanceRevision,
    requestedStatus: status,
    reason: 'Correct synthetic result'
  });
  h.actor(8);
  const appeal = h.state.appeals.at(-1);
  return h.service.decide(appeal.id, {
    idempotencyKey: randomUUID(),
    expectedAttendanceRevision: h.state.reg.attendanceRevision,
    expectedAppealRevision: 0,
    decision: 'APPROVE',
    reason: 'Verified synthetic result'
  });
}
for (const [points, expected] of [
  [0, 0],
  [1, 0],
  [3, 2],
  [4, 3]
])
  test('completion exact cutoff floors points once: ' + points, async () => {
    const h = await setup('PRESENT', points);
    h.time(new Date(end.getTime() - 1).toISOString());
    assert.equal(await processActivityCompletions(h.db, new Date(end.getTime() - 1)), 0);
    assert.equal(h.state.completions.length, 0);
    h.time(end.toISOString());
    assert.equal(await processActivityCompletions(h.db, end), 1);
    assert.equal(h.state.accounts[id(7)].activityPoints, expected);
    assert.equal(h.state.completions.length, 1);
    assert.equal(h.state.scores.filter((s) => s.reason === 'NORMAL_COMPLETION').length, 1);
    const before = structuredClone(h.state);
    assert.equal(await processActivityCompletions(h.db, end), 0);
    assert.deepEqual(h.state, before);
    assert.equal(h.state.events.filter((e) => e.kind === 'ACTIVITY_COMPLETED').length, points ? 1 : 0);
    if (points === 3) assert.equal(h.state.accounts[id(7)].activityDecayAt, null);
    if (points === 4)
      assert.equal(h.state.accounts[id(7)].activityDecayAt.toISOString(), '2030-06-08T12:00:00.000Z');
  });
test('concurrent worker attempts evaluate once through transaction serialization and recipient-before-activity lock order', async () => {
  const h = await setup('PRESENT', 1);
  const results = await Promise.all([
    processActivityCompletions(h.db, end),
    processActivityCompletions(h.db, end)
  ]);
  assert.equal(
    results.reduce((a, b) => a + b, 0),
    1
  );
  assert.equal(h.state.completions.length, 1);
  const first = h.locks.findIndex((l) => l.query.includes('FOR NO KEY UPDATE'));
  const activity = h.locks.findIndex((l, i) => i > first && l.values[0] === 'activity:' + id(1));
  assert.ok(first >= 0 && activity > first);
  assert.equal(h.locks[first].values[0], id(7));
});
test('absent gets only an inactive zero-delta anchor; unrecorded and canceled get no credit', async () => {
  const absent = await setup('ABSENT', 0);
  assert.equal(await processActivityCompletions(absent.db, end), 0);
  assert.equal(absent.state.completions[0].active, false);
  assert.equal(absent.state.accounts[id(7)].activityPoints, 2);
  assert.equal(absent.state.scores.at(-1).delta, 0);
  assert.equal(absent.state.events.filter((e) => e.kind === 'ACTIVITY_COMPLETED').length, 0);
  for (const mutate of [
    (h) => (h.state.activity.cancelledAt = end),
    (h) => (h.state.activity.completionEnabledAt = null),
    (h) => (h.state.reg.status = 'WITHDRAWN'),
    (h) => (h.state.reg.attendanceRecordedAt = new Date('2030-06-01T14:00:00Z'))
  ]) {
    const h = await setup('PRESENT', 1);
    mutate(h);
    assert.equal(await processActivityCompletions(h.db, end), 0);
    assert.equal(h.state.completions.length, 0);
  }
  const missing = await setup(null, 1);
  await processActivityCompletions(missing.db, end);
  assert.equal(missing.state.reg.attendanceStatus, null);
  assert.equal(missing.state.completions.length, 0);
  assert.equal(missing.state.accounts[id(7)].activityPoints, 1);
});
test('undecided incomplete activity is never rewarded before a delayed auto-cancel batch; explicit continuation qualifies', async () => {
  const h = await setup('PRESENT', 1);
  h.state.activity.seats.push({ registration: null });
  assert.equal(completionEligible(h.state.activity, h.state.reg, end), false);
  assert.equal(await processActivityCompletions(h.db, end), 0);
  h.state.activity.continuedAt = new Date('2030-06-01T11:30:00Z');
  assert.equal(await processActivityCompletions(h.db, end), 1);
});
test('worker rechecks cancellation and registration status after waiting for activity lock', async () => {
  for (const mutate of [
    (h) => (h.state.activity.cancelledAt = end),
    (h) => (h.state.reg.status = 'CANCELLED')
  ]) {
    const h = await setup('PRESENT', 1);
    h.atActivityLock(() => mutate(h));
    assert.equal(await processActivityCompletions(h.db, end), 0);
    assert.equal(h.state.completions.length, 0);
    assert.equal(h.state.accounts[id(7)].activityPoints, 1);
  }
});
test('completion notices are private simulated records and audit remains system-owned', async () => {
  const h = await setup('PRESENT', 3);
  await processActivityCompletions(h.db, end);
  const event = h.state.events.find((e) => e.kind === 'ACTIVITY_COMPLETED');
  assert.equal(event.channel, 'IN_APP');
  assert.equal(event.recipientId, id(7));
  assert.ok(event.mockDelivery.create);
  const command = h.state.commands.find((c) => c.kind === 'AUTO_COMPLETION');
  assert.equal(command.actorId, null);
  assert.equal(h.state.scores.at(-1).notices.includes('RESTRICTION_ENDED'), true);
});
test('worker event failure rolls back evaluation, score, and audit', async () => {
  const h = await setup('PRESENT', 1);
  h.fail();
  const before = structuredClone(h.state);
  assert.equal(await processActivityCompletions(h.db, end), 0);
  assert.deepEqual(h.state, before);
});
test('appeal withdraws and restores the same completion credit together with absence penalty', async () => {
  const h = await setup('PRESENT', 3);
  await processActivityCompletions(h.db, end);
  const completionId = h.state.completions[0].id;
  assert.equal(h.state.accounts[id(7)].activityPoints, 2);
  await correct(h, 'ABSENT');
  assert.equal(h.state.accounts[id(7)].activityPoints, 5);
  assert.equal(h.state.completions[0].active, false);
  assert.equal(h.state.events.filter((e) => e.kind === 'ACTIVITY_PENALTY').at(-1).payload.totalPoints, 5);
  await correct(h, 'PRESENT');
  assert.equal(h.state.accounts[id(7)].activityPoints, 2);
  assert.equal(h.state.completions.length, 1);
  assert.equal(h.state.completions[0].id, completionId);
  assert.equal(h.state.completions[0].active, true);
  assert.equal(h.state.scores.filter((s) => s.reason === 'NORMAL_COMPLETION').length, 1);
});
test('revoking a one-point completion after zero floor restores restriction and emits final three-point notice', async () => {
  const h = await setup('PRESENT', 1);
  await processActivityCompletions(h.db, end);
  assert.equal(h.state.accounts[id(7)].activityPoints, 0);
  await correct(h, 'ABSENT');
  assert.equal(h.state.accounts[id(7)].activityPoints, 3);
  assert.equal(h.state.accounts[id(7)].activityDecayAt.toISOString(), '2030-06-08T14:00:00.000Z');
  assert.ok(h.state.scores.at(-1).notices.includes('RESTRICTION_STARTED'));
  assert.equal(h.state.events.find((e) => e.kind === 'ACTIVITY_PENALTY').payload.totalPoints, 3);
});
test('initial zero-delta nominal credit is not turned into an extra point when revoked', async () => {
  const h = await setup('PRESENT', 0);
  await processActivityCompletions(h.db, end);
  assert.equal(h.state.scores.find((s) => s.reason === 'NORMAL_COMPLETION').delta, 0);
  await correct(h, 'ABSENT');
  assert.equal(h.state.accounts[id(7)].activityPoints, 2);
  await correct(h, 'PRESENT');
  assert.equal(h.state.accounts[id(7)].activityPoints, 0);
});
test('late appeal activates original inactive evaluation and recalculates natural decay without a second completion grant', async () => {
  const h = await setup('ABSENT', 1);
  await processActivityCompletions(h.db, end);
  const evaluatedAt = h.state.completions[0].evaluatedAt;
  h.time('2030-06-09T14:00:00Z');
  await correct(h, 'PRESENT');
  assert.equal(h.state.accounts[id(7)].activityPoints, 0);
  assert.equal(h.state.accounts[id(7)].activityDecayAt, null);
  assert.deepEqual(h.state.completions[0].evaluatedAt, evaluatedAt);
  assert.equal(h.state.scores.filter((s) => s.reason === 'NORMAL_COMPLETION').length, 1);
  assert.ok(h.state.scores.some((s) => s.reason === 'NATURAL_DECAY'));
});
test('appeal before first worker evaluates atomically and does not emit a transient completion notice', async () => {
  for (const [original, next, points, expected] of [
    ['PRESENT', 'ABSENT', 1, 3],
    ['ABSENT', 'PRESENT', 1, 0]
  ]) {
    const h = await setup(original, points);
    await correct(h, next);
    assert.equal(h.state.accounts[id(7)].activityPoints, expected);
    assert.equal(h.state.completions.length, 1);
    assert.equal(h.state.events.filter((e) => e.kind === 'ACTIVITY_COMPLETED').length, 0);
    assert.equal(await processActivityCompletions(h.db, end), 0);
  }
});
test('adoption-null activity never acquires completion through appeal and pending record is never inserted', async () => {
  const h = await setup('ABSENT', 1);
  h.state.activity.completionEnabledAt = null;
  await correct(h, 'PRESENT');
  assert.equal(h.state.accounts[id(7)].activityPoints, 1);
  assert.equal(h.state.completions.length, 0);
});
test('attendance DTO exposes only minimal pending, credited, and corrected settlement state', async () => {
  const h = await setup('PRESENT', 1);
  assert.equal((await h.service.attendance(id(1))).items[0].completion.status, 'PENDING');
  await processActivityCompletions(h.db, end);
  let view = (await h.service.attendance(id(1))).items[0].completion;
  assert.equal(view.status, 'CREDITED');
  assert.equal(typeof view.evaluatedAt, 'string');
  await correct(h, 'ABSENT');
  view = (await h.service.attendance(id(1))).items[0].completion;
  assert.equal(view.status, 'NOT_CREDITED');
  assert.deepEqual(Object.keys(view).sort(), ['evaluatedAt', 'status']);
});
test('counterfactual replay skips inactive credits and all correction deltas while preserving later completion intent', () => {
  const now = end,
    events = [
      { reason: 'NORMAL_COMPLETION', delta: -1, simulatedAt: now, completion: { active: false } },
      { reason: 'PENALTY', delta: 2, simulatedAt: now },
      { reason: 'COMPLETION_CORRECTED', delta: 1, simulatedAt: now },
      { reason: 'NORMAL_COMPLETION', delta: 0, simulatedAt: now, completion: { active: true } }
    ];
  assert.equal(replayActivityStanding({ points: 1, decayAt: null }, events, now).points, 2);
});
