import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { id } from './support/activity-input.mjs';
import { harness } from './support/attendance-fixture.mjs';

const record = (status = 'ABSENT', revision = 0) => ({
  idempotencyKey: randomUUID(),
  registrationId: id(2),
  expectedAttendanceRevision: revision,
  status
});
const appeal = (revision = 1, status = 'PRESENT') => ({
  idempotencyKey: randomUUID(),
  registrationId: id(2),
  expectedAttendanceRevision: revision,
  requestedStatus: status,
  reason: 'Please correct my result'
});
const decision = (revision = 1, choice = 'APPROVE') => ({
  idempotencyKey: randomUUID(),
  expectedAttendanceRevision: revision,
  expectedAppealRevision: 0,
  decision: choice,
  reason: 'Verified result'
});
const denies = (fn, code) => assert.rejects(fn, (e) => e.code === code);
for (const [time, allowed] of [
  ['2030-06-01T11:59:59.999Z', false],
  ['2030-06-01T12:00:00Z', true],
  ['2030-06-01T13:59:59.999Z', true],
  ['2030-06-01T14:00:00Z', false]
])
  test('attendance exact window ' + time, async () => {
    const h = harness();
    h.time(time);
    if (allowed) {
      await h.service.record(id(1), record('PRESENT'));
      assert.equal(h.state.reg.attendanceStatus, 'PRESENT');
      assert.equal(h.state.penalties.length, 0);
    } else {
      await denies(() => h.service.record(id(1), record()), 'FORBIDDEN');
      assert.equal(h.state.reg.attendanceStatus, null);
      assert.equal(h.state.penalties.length, 0);
    }
  });
test('only organizer records; canceled withdrawn and pre-adoption historical activities cannot accrue attendance penalties', async () => {
  for (const change of [
    (h) => h.actor(7),
    (h) => h.actor(8),
    (h) => (h.state.activity.cancelledAt = new Date()),
    (h) => (h.state.reg.status = 'WITHDRAWN'),
    (h) => (h.state.activity.attendanceEnabledAt = new Date('2030-06-02'))
  ]) {
    const h = harness();
    change(h);
    await denies(() => h.service.record(id(1), record()), 'FORBIDDEN');
    assert.equal(h.state.penalties.length, 0);
  }
});
test('absence adds exactly two once; success retry after deadline remains a replay and changed body conflicts', async () => {
  const h = harness(),
    body = record();
  await h.service.record(id(1), body);
  assert.equal(h.state.accounts[id(7)].activityPoints, 2);
  assert.equal(h.state.reg.attendanceRevision, 1);
  assert.equal(h.state.penalties.length, 1);
  assert.equal(h.state.commands.length, 1);
  h.time('2030-06-01T14:00:00Z');
  assert.equal((await h.service.record(id(1), body)).replayed, true);
  assert.equal(h.state.penalties.length, 1);
  await denies(() => h.service.record(id(1), { ...body, status: 'PRESENT' }), 'CONFLICT');
});
test('organizer corrections reverse only absence and a later absence creates a fresh grant without resurrecting reversed points', async () => {
  const h = harness();
  h.state.accounts[id(7)].activityPoints = 1;
  await h.service.record(id(1), record());
  const original = h.state.penalties[0].id;
  await h.service.record(id(1), record('PRESENT', 1));
  assert.equal(h.state.accounts[id(7)].activityPoints, 1);
  assert.ok(h.state.penalties[0].reversedAt);
  assert.equal(h.state.reg.attendancePenaltyId, null);
  await h.service.record(id(1), record('ABSENT', 2));
  await h.service.record(id(1), record('PRESENT', 3));
  assert.equal(h.state.accounts[id(7)].activityPoints, 1);
  assert.equal(h.state.penalties.length, 2);
  assert.ok(h.state.penalties.every((p) => p.reversedAt));
  assert.equal(h.state.scores.filter((s) => s.eventKey === 'reverse:' + original).length, 1);
});
test('stale revision and a lock wait crossing deadline reject without score or record mutation', async () => {
  const h = harness();
  await denies(() => h.service.record(id(1), record('ABSENT', 99)), 'CONFLICT');
  h.atActivityLock(() => h.time('2030-06-01T14:00:00Z'));
  await denies(() => h.service.record(id(1), record()), 'FORBIDDEN');
  assert.equal(h.state.penalties.length, 0);
  assert.equal(h.state.reg.attendanceStatus, null);
});
test('recipient and actor accounts lock in sorted order before the shared activity lock', async () => {
  const h = harness();
  await h.service.record(id(1), record());
  const activityIndex = h.locks.findIndex((x) => x.values[0] === 'activity:' + id(1));
  const accountLocks = h.locks
    .slice(0, activityIndex)
    .filter((x) => x.query.includes('FOR NO KEY UPDATE'))
    .map((x) => x.values[0]);
  assert.deepEqual(accountLocks, [id(7), id(9)]);
});
test('own appeal is post-deadline only, pending duplicates are rejected, and other members cannot see the reason', async () => {
  const h = harness();
  await h.service.record(id(1), record());
  h.actor(7);
  await denies(() => h.service.appeal(id(1), appeal()), 'FORBIDDEN');
  h.time('2030-06-01T14:00:00Z');
  const body = appeal();
  await h.service.appeal(id(1), body);
  assert.equal(h.state.appeals.length, 1);
  assert.equal((await h.service.appeal(id(1), body)).replayed, true);
  await denies(() => h.service.appeal(id(1), appeal()), 'CONFLICT');
  assert.equal((await h.service.attendance(id(1))).items[0].appeal.reason, body.reason);
  h.actor(9);
  assert.equal((await h.service.attendance(id(1))).items[0].appeal, null);
  await denies(() => h.service.appeal(id(1), appeal()), 'FORBIDDEN');
});
test('deadline-unfilled stays pending and neither a member nor administrator can use appeal as late insertion', async () => {
  const h = harness();
  h.actor(7);
  h.time('2030-06-01T14:00:00Z');
  await denies(() => h.service.appeal(id(1), appeal(0)), 'FORBIDDEN');
  h.state.appeals.push({
    id: id(50),
    registrationId: id(2),
    accountId: id(7),
    attendanceRevision: 0,
    requestedStatus: 'PRESENT',
    status: 'PENDING',
    revision: 0
  });
  h.actor(8);
  await denies(() => h.service.decide(id(50), decision(0)), 'FORBIDDEN');
  assert.equal(h.state.reg.attendanceStatus, null);
  assert.equal(h.state.penalties.length, 0);
});
test('admin approval corrects an existing absence after natural decay and retains the unrelated point', async () => {
  const h = harness();
  h.state.accounts[id(7)].activityPoints = 1;
  await h.service.record(id(1), record());
  h.time('2030-06-09T12:00:00Z');
  h.actor(7);
  await h.service.appeal(id(1), appeal());
  const a = h.state.appeals[0];
  h.actor(9);
  await denies(() => h.service.decide(a.id, decision()), 'FORBIDDEN');
  h.actor(8);
  const body = decision();
  await h.service.decide(a.id, body);
  assert.equal(h.state.reg.attendanceStatus, 'PRESENT');
  assert.equal(h.state.accounts[id(7)].activityPoints, 1);
  assert.equal(h.state.accounts[id(7)].activityDecayAt, null);
  assert.equal(h.state.appeals[0].status, 'APPROVED');
  assert.ok(h.state.scores.some((s) => s.reason === 'NATURAL_DECAY'));
  assert.ok(h.state.penalties[0].reversedAt);
  assert.equal((await h.service.decide(a.id, body)).replayed, true);
  assert.equal(h.state.events.filter((e) => e.kind === 'ATTENDANCE_APPEAL_RESULT').length, 1);
  assert.ok(h.state.events.every((e) => e.channel === 'IN_APP' && e.recipientId === id(7)));
});
test('rejected appeal preserves result and score; a new appeal is allowed without changing an already decided appeal', async () => {
  const h = harness();
  await h.service.record(id(1), record());
  h.time('2030-06-01T14:00:00Z');
  h.actor(7);
  await h.service.appeal(id(1), appeal());
  h.actor(8);
  await h.service.decide(h.state.appeals[0].id, decision(1, 'REJECT'));
  assert.equal(h.state.reg.attendanceStatus, 'ABSENT');
  assert.equal(h.state.accounts[id(7)].activityPoints, 2);
  h.actor(7);
  await h.service.appeal(id(1), appeal());
  assert.equal(h.state.appeals.length, 2);
});
test('notification failure rolls back attendance, penalty, score, and audit together', async () => {
  const h = harness();
  h.fail();
  const before = structuredClone(h.state);
  await assert.rejects(() => h.service.record(id(1), record()), /Synthetic/);
  assert.deepEqual(h.state, before);
});
test('unauthenticated access and non-admin appeal queue requests are rejected', async () => {
  const h = harness();
  await denies(() => h.service.appeals(new URL('http://local')), 'FORBIDDEN');
  h.deny();
  await denies(() => h.service.attendance(id(1)), 'UNAUTHENTICATED');
  await denies(() => h.service.record(id(1), record()), 'UNAUTHENTICATED');
});
