import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateActivityCancellation,
  validateActivityWithdrawal,
  validateActivityEdit,
  assertActivitySeatEditPreservesRegistrations as preserve
} from '../../packages/domain/src/activity-management-contract.ts';
import { input, id } from './support/activity-input.mjs';

const operation = () => ({ idempotencyKey: id(90), expectedRevision: 0 });
const edit = (extra) => ({
  ...input(),
  ...operation(),
  seats: [
    { id: id(1), requirement: { kind: 'ANY' } },
    { id: id(2), requirement: { kind: 'ROLE', role: 'TANK' } },
    { id: null, requirement: { kind: 'JOB', job: '白魔法师' } }
  ],
  ...extra
});
const invalid = (fn) => assert.throws(fn, (error) => error.code === 'VALIDATION_ERROR');
const conflict = (fn) => assert.throws(fn, (error) => error.code === 'CONFLICT' && error.status === 409);

test('management commands retain operation identity and optimistic revision', () => {
  assert.deepEqual(validateActivityCancellation({ ...operation(), expectedPenaltyPoints: 0 }), {
    ...operation(),
    expectedPenaltyPoints: 0
  });
  assert.deepEqual(
    validateActivityWithdrawal({ ...operation(), expectedRegistrationId: id(3), expectedPenaltyPoints: 0 }),
    { ...operation(), expectedRegistrationId: id(3), expectedPenaltyPoints: 0 }
  );
});
for (const value of [undefined, null, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
  test('management rejects invalid revision ' + String(value), () => {
    for (const validate of [validateActivityCancellation, validateActivityWithdrawal]) {
      invalid(() =>
        validate({
          ...operation(),
          expectedRevision: value,
          expectedPenaltyPoints: 0,
          ...(validate === validateActivityWithdrawal
            ? { expectedRegistrationId: id(3), expectedPenaltyPoints: 0 }
            : {})
        })
      );
    }
    invalid(() => validateActivityEdit(edit({ expectedRevision: value })));
  });
}
test('management command rejects forged actors, penalties, cancellation reasons and malformed identity', () => {
  for (const extra of [
    { actorId: id(9) },
    { points: 0 },
    { reason: 'NOT_FULL' },
    { idempotencyKey: 'bad' }
  ]) {
    invalid(() => validateActivityCancellation({ ...operation(), expectedPenaltyPoints: 0, ...extra }));
    invalid(() =>
      validateActivityWithdrawal({
        ...operation(),
        expectedRegistrationId: id(3),
        expectedPenaltyPoints: 0,
        ...extra
      })
    );
  }
  invalid(() => validateActivityWithdrawal(operation()));
});
test('edit keeps stable existing seat identities and explicitly marks a new seat', () => {
  const result = validateActivityEdit(edit({ title: '  修改后的活动  ' }));
  assert.equal(result.title, '修改后的活动');
  assert.deepEqual(
    result.seats.map((seat) => seat.id),
    [id(1), id(2), null]
  );
  assert.equal(result.expectedRevision, 0);
});
test('edit rejects duplicate normalized seat identities and unknown seat fields', () => {
  invalid(() =>
    validateActivityEdit(
      edit({
        seats: [
          { id: id(1), requirement: { kind: 'ANY' } },
          { id: id(1).toUpperCase(), requirement: { kind: 'ANY' } }
        ]
      })
    )
  );
  for (const seat of [
    { requirement: { kind: 'ANY' } },
    { id: 'bad', requirement: { kind: 'ANY' } },
    { id: id(1), requirement: { kind: 'ANY' }, accountId: id(3) },
    null,
    []
  ]) {
    invalid(() => validateActivityEdit(edit({ seats: [seat] })));
  }
});
test('edit reuses accepted title, date, size, category and composition bounds', () => {
  for (const extra of [
    { title: '' },
    { endsAt: '2030-06-01T20:00:00+08:00' },
    { startsAt: '2030-06-01T12:00:00Z' },
    { seats: [] },
    { organizerId: id(7) },
    { seats: Array.from({ length: 201 }, () => ({ id: null, requirement: { kind: 'ANY' } })) },
    { category: 'SOCIAL', dutySelection: null },
    { dutySelection: { type: 'OTHER', name: '四人', partyComposition: 'LIGHT' } }
  ]) {
    invalid(() => validateActivityEdit(edit(extra)));
  }
});
test('edit permits the existing 200-seat custom capacity and social null duty', () => {
  assert.equal(
    validateActivityEdit(
      edit({ seats: Array.from({ length: 200 }, () => ({ id: null, requirement: { kind: 'ANY' } })) })
    ).seats.length,
    200
  );
  assert.equal(
    validateActivityEdit(
      edit({ category: 'SOCIAL', dutySelection: null, seats: [{ id: id(1), requirement: { kind: 'ANY' } }] })
    ).category,
    'SOCIAL'
  );
});
const occupied = [
  { id: id(1), registration: { job: '骑士' } },
  { id: id(2), registration: null },
  { id: id(3), registration: { job: '白魔法师' } }
];
const retained = [
  { id: id(1), requirement: { kind: 'ROLE', role: 'TANK' } },
  { id: id(3), requirement: { kind: 'JOB', job: '白魔法师' } }
];
test('seat edit allows safe shrinking and additions while preserving all active registrations', () => {
  const before = structuredClone(occupied);
  preserve(occupied, retained, 'DUNGEON');
  preserve(occupied, [...retained, { id: null, requirement: { kind: 'ANY' } }], 'DUNGEON');
  assert.deepEqual(occupied, before);
});
test('shrinking by count cannot silently remove an occupied tail seat', () => {
  conflict(() => preserve(occupied, retained.slice(0, 1), 'DUNGEON'));
});
test('changing an occupied requirement must accept the member chosen job', () => {
  for (const requirement of [
    { kind: 'ROLE', role: 'HEALER' },
    { kind: 'JOB', job: '战士' }
  ]) {
    conflict(() => preserve(occupied, [{ id: id(1), requirement }, retained[1]], 'DUNGEON'));
  }
  preserve(
    occupied,
    retained.map((seat) => ({ ...seat, requirement: { kind: 'ANY' } })),
    'DUNGEON'
  );
});
test('category changes cannot silently rewrite or erase existing registration jobs', () => {
  conflict(() => preserve(occupied, retained, 'SOCIAL'));
  const social = [{ id: id(1), registration: { job: null } }];
  preserve(social, [{ id: id(1), requirement: { kind: 'ANY' } }], 'SOCIAL');
  conflict(() => preserve(social, [{ id: id(1), requirement: { kind: 'ANY' } }], 'DUNGEON'));
});
test('seat reconciliation rejects foreign and duplicate identities before changes', () => {
  invalid(() => preserve(occupied, [...retained, { id: id(99), requirement: { kind: 'ANY' } }], 'DUNGEON'));
  invalid(() => preserve(occupied, [...retained, retained[0]], 'DUNGEON'));
});

test('penalty confirmations accept only exact operation points and reject absent or forged expectations', () => {
  for (const points of [undefined, null, 1, 3, '0'])
    invalid(() => validateActivityCancellation({ ...operation(), expectedPenaltyPoints: points }));
  for (const points of [undefined, null, 2, 3, '0'])
    invalid(() =>
      validateActivityWithdrawal({
        ...operation(),
        expectedRegistrationId: id(3),
        expectedPenaltyPoints: points
      })
    );
  assert.equal(
    validateActivityCancellation({ ...operation(), expectedPenaltyPoints: 2 }).expectedPenaltyPoints,
    2
  );
  assert.equal(
    validateActivityWithdrawal({ ...operation(), expectedRegistrationId: id(3), expectedPenaltyPoints: 1 })
      .expectedPenaltyPoints,
    1
  );
});
