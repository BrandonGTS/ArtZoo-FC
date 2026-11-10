import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  validateCreateTeam,
  teamTimes,
  teamCommand,
  messageId,
  safeAccountReturnTo
} from '../../packages/domain/src/index.ts';
import { body } from './support/teams-fixtures.mjs';
test('creation accepts only eight ordered seat requirements, rejecting all legacy prefill fields', () => {
  const input = body();
  const parsed = validateCreateTeam(input);
  assert.equal(parsed.seats.length, 8);
  assert.ok(parsed.seats.every((s) => Object.keys(s).sort().join(',') === 'position,requirement'));
  for (const alter of [
    (b) => b.seats.pop(),
    (b) => (b.seats[0].position = 1),
    (b) => (b.seats[2].requirement = { kind: 'ANY' }),
    (b) => (b.creatorId = randomUUID()),
    (b) => (b.seats[0].memberId = randomUUID()),
    (b) => (b.seats[0].memberId = null),
    (b) => (b.seats[0].memberJob = '骑士'),
    (b) => (b.seats[0].memberJob = null)
  ]) {
    const b = structuredClone(input);
    alter(b);
    assert.throws(
      () => validateCreateTeam(b),
      (e) => e.code === 'VALIDATION_ERROR'
    );
  }
  assert.throws(
    () => validateCreateTeam(body([randomUUID()])),
    (e) => e.code === 'VALIDATION_ERROR'
  );
});
test('commands reject forged fields, malformed versions and multiline/control data', () => {
  assert.throws(() => teamCommand({ idempotencyKey: randomUUID(), expectedRevision: -1 }));
  assert.throws(() =>
    teamCommand({ idempotencyKey: randomUUID(), expectedRevision: 0, creatorId: randomUUID() })
  );
  assert.throws(() => validateCreateTeam({ ...body(), name: 'x\u0000' }));
  assert.equal(messageId('team:' + randomUUID()).source, 'team');
});
test('explicit Beijing times preserve exact order and reject equal or missing zones', () => {
  assert.equal(
    teamTimes({
      startsAt: '2030-12-30T20:00:00+08:00',
      endsAt: '2030-12-30T21:00:00+08:00'
    }).startsAt.toISOString(),
    '2030-12-30T12:00:00.000Z'
  );
  for (const end of ['2030-12-30T20:00:00+08:00', '2030-12-30T19:00:00+08:00'])
    assert.throws(() => teamTimes({ startsAt: '2030-12-30T20:00:00+08:00', endsAt: end }));
  assert.throws(() => teamTimes({ startsAt: '2030-12-30T20:00:00', endsAt: '2030-12-30T21:00:00+08:00' }));
});

test('fixed-team return paths are exact internal routes, external and malformed paths stay rejected', () => {
  const id = randomUUID();
  for (const route of ['/teams', '/teams/new', '/me/teams', '/teams/' + id])
    assert.equal(safeAccountReturnTo(route), route);
  for (const route of [
    '//evil.invalid',
    '/teams/../admin',
    '/teams/' + id + '/edit',
    '/teams/https://evil.invalid'
  ])
    assert.equal(safeAccountReturnTo(route), '/');
  assert.equal(
    teamTimes({
      startsAt: '2030-12-30T23:00:00+08:00',
      endsAt: '2030-12-31T01:00:00+08:00'
    }).endsAt.toISOString(),
    '2030-12-30T17:00:00.000Z'
  );
});
