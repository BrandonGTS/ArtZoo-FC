import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processActivityAutoAbsences } from '../../packages/db/src/activity-auto-absence.ts';
import { processActivityCompletions } from '../../packages/db/src/activity-completion.ts';
import { validAttendanceRecord } from '../../packages/db/src/activity-attendance-policy.ts';
import { harness } from './support/attendance-fixture.mjs';
import { id } from './support/activity-input.mjs';
const end = new Date('2030-06-01T14:00:00Z');
const setup = () => {
  const h = harness();
  return h;
};
const record = () => ({
  idempotencyKey: randomUUID(),
  registrationId: id(2),
  expectedAttendanceRevision: 0,
  status: 'PRESENT'
});
test('exact deadline: absent once, actual later timestamp, exactly one penalty and private notice', async () => {
  const h = setup();
  assert.equal(await processActivityAutoAbsences(h.db, new Date(+end - 1)), 0);
  const processedAt = new Date(+end + 30000);
  const results = await Promise.all([
    processActivityAutoAbsences(h.db, processedAt),
    processActivityAutoAbsences(h.db, processedAt)
  ]);
  assert.equal(
    results.reduce((a, b) => a + b, 0),
    1
  );
  assert.equal(h.state.reg.attendanceStatus, 'ABSENT');
  assert.equal(h.state.reg.attendanceSource, 'AUTO_DEADLINE');
  assert.equal(+h.state.reg.attendanceRecordedAt, +processedAt);
  assert.equal(h.state.reg.attendanceRevision, 1);
  assert.equal(h.state.accounts[id(7)].activityPoints, 2);
  assert.equal(h.state.penalties.length, 1);
  assert.equal(h.state.scores.length, 1);
  assert.equal(h.state.events.length, 1);
  assert.equal(h.state.events[0].channel, 'IN_APP');
  assert.equal(h.state.events[0].recipientId, id(7));
  assert.equal(h.state.commands[0].actorId, null);
  const before = structuredClone(h.state);
  assert.equal(await processActivityAutoAbsences(h.db, processedAt), 0);
  assert.deepEqual(h.state, before);
});
test('cancellation, withdrawn, incomplete, offline and series excluded', async () => {
  for (const mutate of [
    (h) => (h.state.activity.cancelledAt = end),
    (h) => (h.state.reg.status = 'WITHDRAWN'),
    (h) => (h.state.reg.status = 'CANCELLED'),
    (h) => h.state.activity.seats.push({ registration: null }),
    (h) => (h.state.activity.scene = 'OFFLINE'),
    (h) => (h.state.activity.mode = 'SERIES')
  ]) {
    const h = setup();
    mutate(h);
    const before = structuredClone(h.state);
    assert.equal(await processActivityAutoAbsences(h.db, end), 0);
    assert.deepEqual(h.state, before);
  }
});
test('explicit continuation qualifies an opted-in incomplete activity', async () => {
  const h = setup();
  h.state.activity.seats.push({ registration: null });
  h.state.activity.continuedAt = new Date(+end - 3600000);
  assert.equal(await processActivityAutoAbsences(h.db, end), 1);
});
test('lock recheck excludes cancellation, withdrawal or concurrent sign-in', async () => {
  for (const mutate of [
    (h) => (h.state.activity.cancelledAt = end),
    (h) => (h.state.reg.status = 'WITHDRAWN'),
    (h) => {
      h.state.reg.attendanceStatus = 'PRESENT';
      h.state.reg.attendanceSource = 'ORGANIZER';
      h.state.reg.attendanceRecordedAt = new Date(+end - 1);
    }
  ]) {
    const h = setup();
    h.atActivityLock(() => mutate(h));
    assert.equal(await processActivityAutoAbsences(h.db, end), 0);
    assert.equal(h.state.penalties.length, 0);
    assert.equal(h.state.events.length, 0);
  }
});
test('sign-in serialized before deadline settlement wins without absence penalty', async () => {
  const h = setup();
  h.time(new Date(+end - 1));
  let worker;
  h.atActivityLock(() => {
    worker = processActivityAutoAbsences(h.db, end);
  });
  await h.service.record(id(1), record());
  await worker;
  assert.equal(h.state.reg.attendanceStatus, 'PRESENT');
  assert.equal(h.state.penalties.length, 0);
});
test('deadline settlement before a stale sign-in rejects the sign-in and does not duplicate charge', async () => {
  const h = setup();
  h.time(end);
  await processActivityAutoAbsences(h.db, end);
  await assert.rejects(
    () => h.service.record(id(1), record()),
    (e) => e.code === 'CONFLICT' || e.code === 'FORBIDDEN'
  );
  assert.equal(h.state.penalties.length, 1);
});
test('transaction event failure rolls back record, penalty, score, command and activity revision', async () => {
  const h = setup();
  h.fail();
  const before = structuredClone(h.state);
  assert.equal(await processActivityAutoAbsences(h.db, end), 0);
  assert.deepEqual(h.state, before);
});
test('automatic record self appeal, admin approval, penalty reversal and normal completion reconcile atomically', async () => {
  const h = setup();
  h.state.accounts[id(7)].activityPoints = 3;
  await processActivityAutoAbsences(h.db, end);
  await processActivityCompletions(h.db, end);
  assert.equal(h.state.accounts[id(7)].activityPoints, 5);
  h.time(end);
  h.actor(7);
  const view = await h.service.attendance(id(1));
  assert.equal(view.items[0].canAppeal, true);
  assert.equal(view.items[0].source, 'AUTO_DEADLINE');
  await h.service.appeal(id(1), {
    idempotencyKey: randomUUID(),
    registrationId: id(2),
    expectedAttendanceRevision: 1,
    requestedStatus: 'PRESENT',
    reason: 'Public synthetic correction'
  });
  const appeal = h.state.appeals[0],
    body = {
      idempotencyKey: randomUUID(),
      expectedAttendanceRevision: 1,
      expectedAppealRevision: 0,
      decision: 'APPROVE',
      reason: 'Public verified correction'
    };
  h.actor(9);
  await assert.rejects(
    () => h.service.decide(appeal.id, body),
    (e) => e.code === 'FORBIDDEN'
  );
  h.actor(8);
  await h.service.decide(appeal.id, body);
  assert.equal(h.state.reg.attendanceStatus, 'PRESENT');
  assert.equal(h.state.reg.attendanceSource, 'AUTO_DEADLINE');
  assert.equal(+h.state.reg.attendanceRecordedAt, +end);
  assert.equal(h.state.accounts[id(7)].activityPoints, 2);
  assert.ok(h.state.penalties[0].reversedAt);
  assert.equal(h.state.completions.length, 1);
  assert.equal(h.state.completions[0].active, true);
});
test('foreign user cannot appeal automatic record and unopted malformed source does not gain appeal eligibility', async () => {
  const h = setup();
  await processActivityAutoAbsences(h.db, end);
  h.time(end);
  h.actor(6);
  await assert.rejects(
    () =>
      h.service.appeal(id(1), {
        idempotencyKey: randomUUID(),
        registrationId: id(2),
        expectedAttendanceRevision: 1,
        requestedStatus: 'PRESENT',
        reason: 'Not owner'
      }),
    (e) => e.code === 'FORBIDDEN'
  );
  assert.equal(
    validAttendanceRecord(h.state.activity, { ...h.state.reg, attendanceRecordedAt: new Date(+end - 1) }),
    false
  );
});

test('completion sweep credits an attending registration after the activity ends', async () => {
  const h = setup();
  h.time(new Date(+end - 1));
  await h.service.record(id(1), record());
  assert.equal(await processActivityCompletions(h.db, new Date(+end - 3600000)), 0);
  assert.equal(h.state.completions.length, 0);
  assert.equal(await processActivityCompletions(h.db, end), 1);
  assert.equal(h.state.completions.length, 1);
});
