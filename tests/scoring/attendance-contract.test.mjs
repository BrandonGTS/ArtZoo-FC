import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  validateAttendance,
  validateAttendanceAppeal,
  validateAttendanceDecision
} from '../../packages/domain/src/index.ts';
import { replayActivityStanding } from '../../packages/db/src/activity-standing.ts';
import { id } from './support/activity-input.mjs';
const time = (day) => new Date(Date.UTC(2030, 5, 1 + day));
const grant = (day, delta, reversed = false) => ({
  reason: 'PENALTY',
  delta,
  simulatedAt: time(day),
  penalty: { reversedAt: reversed ? time(20) : null }
});
const decay = (day) => ({ reason: 'NATURAL_DECAY', delta: -1, simulatedAt: time(day) });
const complete = (day, delta = -1) => ({ reason: 'NORMAL_COMPLETION', delta, simulatedAt: time(day) });
const base = () => ({ idempotencyKey: randomUUID(), expectedAttendanceRevision: 0 });
test('attendance contract accepts only explicit result and stable expected revision', () => {
  const b = { ...base(), registrationId: id(2), status: 'PRESENT' };
  assert.equal(validateAttendance(b).status, 'PRESENT');
  for (const patch of [
    { status: null },
    { status: 'PENDING' },
    { expectedAttendanceRevision: -1 },
    { points: 0 },
    { accountId: id(9) }
  ])
    assert.throws(
      () => validateAttendance({ ...b, ...patch }),
      (e) => e.code === 'VALIDATION_ERROR'
    );
});
test('appeal and admin decision require bounded reasons, enumerated actions and versions', () => {
  const b = { ...base(), registrationId: id(2), requestedStatus: 'PRESENT', reason: 'Correction' };
  assert.equal(validateAttendanceAppeal(b).reason, 'Correction');
  for (const reason of ['', ' '.repeat(3), 'x'.repeat(1001), 'bad\u0000'])
    assert.throws(() => validateAttendanceAppeal({ ...b, reason }));
  assert.equal(
    validateAttendanceDecision({
      ...base(),
      expectedAppealRevision: 1,
      decision: 'APPROVE',
      reason: 'Verified'
    }).decision,
    'APPROVE'
  );
  assert.throws(() =>
    validateAttendanceDecision({ ...base(), expectedAppealRevision: 1, decision: 'UPSERT', reason: 'x' })
  );
});
test('reversing absence after decay preserves the original point instead of clamping current minus two', () => {
  const result = replayActivityStanding({ points: 1, decayAt: null }, [grant(0, 2, true), decay(7)], time(8));
  assert.equal(result.points, 1);
  assert.equal(result.decayAt, null);
});
test('multiple reversed grants remain excluded from earliest original anchor', () => {
  const events = [
    grant(0, 2, true),
    grant(1, 1),
    { reason: 'PENALTY_REVERSED', delta: -2, simulatedAt: time(2) },
    grant(3, 2, true),
    decay(7)
  ];
  assert.equal(replayActivityStanding({ points: 0, decayAt: null }, events, time(20)).points, 1);
});
test('independent normal completion stays an independent nominal minus one, including original zero delta', () => {
  assert.equal(
    replayActivityStanding({ points: 2, decayAt: null }, [grant(0, 2, true), complete(1)], time(2)).points,
    1
  );
  assert.equal(
    replayActivityStanding({ points: 1, decayAt: null }, [grant(0, 2, true), complete(1, 0)], time(2)).points,
    0
  );
});
test('correction does not erase unrelated later penalties or restart an existing seven-day restriction', () => {
  const result = replayActivityStanding(
    { points: 2, decayAt: null },
    [grant(0, 2, true), grant(1, 2), grant(2, 1)],
    time(3)
  );
  assert.equal(result.points, 5);
  assert.equal(result.decayAt.toISOString(), time(8).toISOString());
});
test('replay settles all accrued cycles to trusted current time and never below zero', () => {
  const result = replayActivityStanding(
    { points: 5, decayAt: time(7) },
    [grant(0, 2, true), decay(7)],
    time(28)
  );
  assert.equal(result.points, 2);
  assert.equal(result.decayAt, null);
  assert.equal(
    replayActivityStanding({ points: 0, decayAt: null }, [complete(1), complete(2)], time(3)).points,
    0
  );
});
test('unknown score reasons fail closed instead of guessing whether a separate completion should be erased', () => {
  assert.throws(
    () =>
      replayActivityStanding(
        { points: 1, decayAt: null },
        [{ reason: 'FUTURE_UNKNOWN', delta: -1, simulatedAt: time(1) }],
        time(2)
      ),
    /Unsupported/
  );
});
