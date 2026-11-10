import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCreateActivity,
  validateActivityRegistration,
  validateSeatRequirement,
  parseBeijingActivityTime,
  jobMeetsSeat,
  activityStatus,
  ACTIVITY_JOBS
} from '../../packages/domain/src/activity-contract.ts';
import { input, id } from './support/activity-input.mjs';
const invalid = (fn) => assert.throws(fn, (e) => e.code === 'VALIDATION_ERROR');
test('Beijing explicit offset converts to the intended UTC instant', () =>
  assert.equal(
    parseBeijingActivityTime('2030-06-01T20:00:00+08:00', 'startsAt').toISOString(),
    '2030-06-01T12:00:00.000Z'
  ));
for (const value of [
  '2030-06-01T20:00:00',
  '2030-06-01T12:00:00Z',
  '2030-06-01T20:00:00+09:00',
  '2030-02-30T20:00:00+08:00',
  '2030-06-01T24:00:00+08:00',
  null
])
  test('reject invalid Beijing time ' + String(value), () =>
    invalid(() => parseBeijingActivityTime(value, 'startsAt'))
  );
test('create normalizes display text and retains mixed seat requirements', () => {
  const out = validateCreateActivity(input({ title: '  activity  ' }));
  assert.equal(out.title, 'activity');
  assert.deepEqual(out.seats, [
    { kind: 'ANY' },
    { kind: 'ROLE', role: 'TANK' },
    { kind: 'JOB', job: '白魔法师' }
  ]);
});
for (const [name, extra] of [
  ['end before start', { endsAt: '2030-06-01T19:59:59+08:00' }],
  ['equal times', { endsAt: '2030-06-01T20:00:00+08:00' }],
  ['unknown field', { organizerId: id(99) }],
  ['unknown category', { category: 'RAID' }],
  ['empty seats', { seats: [] }],
  ['seat cap', { seats: Array.from({ length: 201 }, () => ({ kind: 'ANY' })) }],
  ['empty title', { title: '  ' }],
  ['title bound', { title: 'a'.repeat(101) }],
  ['description bound', { description: 'a'.repeat(2001) }],
  ['invalid key', { idempotencyKey: 'not-uuid' }],
  ['control character', { title: 'bad\u0000' }]
])
  test('create rejects ' + name, () => invalid(() => validateCreateActivity(input(extra))));
test('custom party composition and cap are accepted without hardcoded 8-player rule', () => {
  assert.equal(
    validateCreateActivity(input({ seats: Array.from({ length: 200 }, () => ({ kind: 'ANY' })) })).seats
      .length,
    200
  );
});
test('social activity accepts only unlimited seats', () => {
  assert.equal(
    validateCreateActivity(input({ category: 'SOCIAL', seats: [{ kind: 'ANY' }] })).category,
    'SOCIAL'
  );
  invalid(() => validateCreateActivity(input({ category: 'SOCIAL' })));
});
for (const seat of [
  { kind: 'ANY', role: 'TANK' },
  { kind: 'ROLE', role: 'MAGE' },
  { kind: 'JOB', job: '青魔法师' },
  { kind: 'JOB', job: '白魔法师', extra: true },
  null,
  []
])
  test('reject malformed requirement ' + JSON.stringify(seat), () =>
    invalid(() => validateSeatRequirement(seat))
  );
test('all official jobs obey role, exact job and unlimited requirements', () => {
  assert.equal(ACTIVITY_JOBS.length, 21);
  for (const job of ACTIVITY_JOBS) {
    assert.equal(jobMeetsSeat({ kind: 'ANY' }, job.name), true);
    for (const role of ['TANK', 'HEALER', 'DAMAGE'])
      assert.equal(jobMeetsSeat({ kind: 'ROLE', role }, job.name), job.role === role);
    assert.equal(jobMeetsSeat({ kind: 'JOB', job: '白魔法师' }, job.name), job.name === '白魔法师');
  }
  assert.equal(jobMeetsSeat({ kind: 'ANY' }, '青魔法师'), false);
});
test('registration DTO is strict and supports social null job', () => {
  assert.deepEqual(validateActivityRegistration({ seatId: id(1), job: null }), { seatId: id(1), job: null });
  for (const body of [
    { seatId: id(1), job: '青魔法师' },
    { seatId: id(1), job: '骑士', accountId: id(3) },
    { seatId: 'bad', job: '骑士' },
    { seatId: id(1) }
  ])
    invalid(() => validateActivityRegistration(body));
});
const start = new Date('2030-06-01T12:00:00Z'),
  end = new Date('2030-06-01T14:00:00Z');
for (const [delta, full, expected] of [
  [-1800001, false, 'OPEN'],
  [-1800001, true, 'FULL'],
  [-1800000, false, 'REGISTRATION_CLOSED'],
  [-1800000, true, 'REGISTRATION_CLOSED'],
  [-1, false, 'REGISTRATION_CLOSED'],
  [0, false, 'IN_PROGRESS'],
  [7199999, true, 'IN_PROGRESS'],
  [7200000, false, 'TIME_ENDED'],
  [7200001, true, 'TIME_ENDED']
])
  test('status exact boundary ' + delta + '/' + full, () =>
    assert.equal(activityStatus(start, end, new Date(start.getTime() + delta), full), expected)
  );
