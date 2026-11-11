import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  validatePenaltyAppeal,
  validatePenaltyAppealDecision,
  penaltyAppealWindowOpen
} from '../../packages/domain/src/index.ts';
import {
  addActivityPenaltyPoints,
  reverseAttendancePenalty
} from '../../packages/db/src/activity-standing.ts';
import { fixture, submission, decision } from './support/penalty-appeal-fixture.mjs';
import { id } from './support/activity-input.mjs';
const owner = '7',
  admin = '8',
  url = (page) => new URL('http://local/api/me/activity-penalties?page=' + page),
  code = (c) => (e) => e.code === c;
const points = (f) => f.state.accounts[id(7)].activityPoints;
const send = (f, body = submission(), token = owner) => f.service.appeal(f.penaltyId, body, token);
const decide = (f, a, body = decision(), token = admin) => f.service.decide(a.id, body, token);
function privateDTO(value) {
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    assert.doesNotMatch(
      k,
      /^(phone|passwordHash|submissionKey|submissionFingerprint|decisionKey|decisionFingerprint|sequence|accountId)$/
    );
    privateDTO(v);
  }
}
test('submission window is exact continuous seven days and validators reject forged fields/reasons', () => {
  const start = new Date('2030-06-01T12:00:00Z'),
    end = new Date(+start + 7 * 86400000);
  assert.equal(penaltyAppealWindowOpen(start, new Date(+start - 1)), false);
  assert.equal(penaltyAppealWindowOpen(start, start), true);
  assert.equal(penaltyAppealWindowOpen(start, new Date(+end - 1)), true);
  assert.equal(penaltyAppealWindowOpen(start, end), false);
  for (const x of [
    submission({ accountId: id(9) }),
    submission({ expectedLatestAppealId: undefined }),
    submission({ reason: ' ' }),
    submission({ reason: 'x'.repeat(1001) }),
    submission({ reason: 'x\u200b' })
  ])
    assert.throws(() => validatePenaltyAppeal(x));
  for (const x of [
    decision({ expectedAppealRevision: -1 }),
    decision({ decision: 'APPROVED' }),
    decision({ reason: '' }),
    decision({ penaltyPoints: 0 })
  ])
    assert.throws(() => validatePenaltyAppealDecision(x));
  assert.equal(
    validatePenaltyAppeal(submission({ reason: '  Supplemental reason  ' })).reason,
    'Supplemental reason'
  );
});
test('first submit changes no penalty or points; exact retry works after expiry without duplicate audit', async () => {
  const f = await fixture(),
    body = submission();
  f.time('2030-06-08T11:59:59.999Z');
  const a = await send(f, body);
  assert.equal(a.replayed, false);
  assert.equal(points(f), 1);
  assert.equal(f.state.scores.length, 1);
  assert.equal(f.state.events.length, 0);
  f.time('2030-06-08T12:00:00Z');
  assert.equal((await send(f, body)).replayed, true);
  assert.equal(f.state.penaltyAppeals.length, 1);
  assert.equal(f.state.audits.length, 1);
  await assert.rejects(() => send(f, submission({ reason: 'Other' })), code('FORBIDDEN'));
  privateDTO(a);
});
test('locked cutoff is checked after activity wait and future penalty cannot be appealed', async () => {
  const f = await fixture();
  f.atActivityLock(() => f.time('2030-06-08T12:00:00Z'));
  await assert.rejects(() => send(f), code('FORBIDDEN'));
  assert.equal(f.state.penaltyAppeals.length, 0);
  const future = await fixture();
  future.time('2030-06-01T11:59:59.999Z');
  await assert.rejects(() => send(future), code('FORBIDDEN'));
});
test('NO_SHOW penalties cannot use this flow', async () => {
  const a = await fixture({ reason: 'NO_SHOW', points: 2 });
  await assert.rejects(() => send(a), code('FORBIDDEN'));
  assert.equal((await a.service.minePenalties(url(1), owner)).items.length, 0);
});
test('anonymous, other member and non-admin cannot enumerate, submit or decide', async () => {
  const f = await fixture();
  await assert.rejects(() => f.service.appeal(f.penaltyId, submission()), code('UNAUTHENTICATED'));
  await assert.rejects(() => send(f, submission(), '6'), code('NOT_FOUND'));
  await assert.rejects(() => f.service.minePenalties(url(1)), code('UNAUTHENTICATED'));
  await assert.rejects(() => f.service.appeals(url(1), owner), code('FORBIDDEN'));
  const a = (await send(f)).appeal;
  await assert.rejects(() => decide(f, a, decision(), owner), code('FORBIDDEN'));
  assert.equal(points(f), 1);
});
test('concurrent different-key requests leave exactly one pending; same-key requests replay', async () => {
  const f = await fixture(),
    body = submission();
  const same = await Promise.all([send(f, body), send(f, body)]);
  assert.equal(same.filter((x) => x.replayed).length, 1);
  assert.equal(f.state.penaltyAppeals.length, 1);
  const g = await fixture();
  const results = await Promise.allSettled([
    send(g),
    send(g, submission({ reason: 'Additional circumstances' }))
  ]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(results.find((x) => x.status === 'rejected').reason.code, 'CONFLICT');
  assert.equal(g.state.penaltyAppeals.length, 1);
});
test('rejection retains original penalty; supplemental reapplication has its own record and original deadline', async () => {
  const f = await fixture(),
    a = (await send(f)).appeal;
  const body = decision({ decision: 'REJECT' });
  await decide(f, a, body);
  assert.equal((await decide(f, a, body)).replayed, true);
  assert.equal(points(f), 1);
  assert.equal(f.state.penalties[0].reversedAt, null);
  assert.equal(f.state.events.length, 1);
  await assert.rejects(
    () =>
      send(
        f,
        submission({ expectedLatestAppealId: a.id, reason: '  Please review the documented circumstances  ' })
      ),
    code('VALIDATION_ERROR')
  );
  const b = (
    await send(
      f,
      submission({ expectedLatestAppealId: a.id, reason: 'Please also review the supplemental evidence' })
    )
  ).appeal;
  assert.notEqual(b.id, a.id);
  assert.equal(f.state.penaltyAppeals.length, 2);
  const list = await f.service.minePenalties(url(1), owner);
  assert.equal(list.items[0].latestAppeal.id, b.id);
  assert.equal(list.items[0].expiresAt, '2030-06-08T12:00:00.000Z');
  assert.equal(list.items[0].canAppeal, false);
  await decide(f, b, decision({ decision: 'REJECT' }));
  f.time('2030-06-08T12:00:00Z');
  await assert.rejects(
    () => send(f, submission({ expectedLatestAppealId: b.id, reason: 'More evidence after deadline' })),
    code('FORBIDDEN')
  );
});
test('pending can be approved after deadline; approval and retry are atomic and final', async () => {
  const f = await fixture({ reason: 'LATE_CANCELLATION', points: 2, base: 1 }),
    a = (await send(f)).appeal;
  f.state.activity.cancelledAt = new Date('2030-06-01T12:00:00Z');
  f.state.reg.status = 'CANCELLED';
  f.time('2030-06-09T12:00:00Z');
  const body = decision();
  await decide(f, a, body);
  assert.equal(points(f), 1);
  assert.equal(f.state.accounts[id(7)].activityDecayAt, null);
  assert.equal(f.latest().status, 'APPROVED');
  assert.ok(f.state.penalties[0].reversedAt);
  assert.equal((await decide(f, a, body)).replayed, true);
  await assert.rejects(() => decide(f, a, decision()), code('CONFLICT'));
  await assert.rejects(() => decide(f, a, { ...body, reason: 'Changed' }), code('CONFLICT'));
  assert.equal(f.state.events.length, 1);
  assert.equal(f.state.events[0].registrationId, undefined);
  assert.equal(f.state.events[0].channel, 'IN_APP');
  assert.equal(f.state.events[0].recipientId, id(7));
  assert.equal(f.state.events[0].payload.points, 1);
  assert.equal(f.state.commands.length, 0);
  assert.equal(f.state.audits.length, 2);
  assert.equal(f.state.reg.status, 'CANCELLED');
  assert.equal(f.state.completions.length, 0);
});
test('approval does not restore withdrawn registration or erase the history', async () => {
  const f = await fixture();
  f.state.reg.status = 'WITHDRAWN';
  const a = (await send(f)).appeal;
  await decide(f, a);
  assert.equal(points(f), 0);
  assert.equal(f.state.reg.status, 'WITHDRAWN');
  assert.equal(f.state.penalties.length, 1);
  assert.equal(f.state.scores.filter((x) => x.reason === 'PENALTY_REVERSED').length, 1);
  await assert.rejects(
    () => send(f, submission({ expectedLatestAppealId: a.id, reason: 'Another' })),
    code('CONFLICT')
  );
});
test('permission and immutable target ownership are rechecked under shared locks', async () => {
  const f = await fixture(),
    a = (await send(f)).appeal;
  f.atActivityLock(() => (f.state.accounts[id(8)].adminRole = 'NONE'));
  await assert.rejects(() => decide(f, a), code('FORBIDDEN'));
  assert.equal(f.latest().status, 'PENDING');
  assert.equal(f.state.events.length, 0);
  const g = await fixture();
  g.atActivityLock(() => (g.state.penalties[0].accountId = id(6)));
  await assert.rejects(() => send(g), code('NOT_FOUND'));
});
test('all account locks precede activity in sorted order, with session and permission revalidation', async () => {
  const f = await fixture(),
    a = (await send(f)).appeal;
  f.locks.length = 0;
  await decide(f, a);
  const activity = f.locks.findIndex((x) => String(x.values[0]).startsWith('activity:'));
  const accounts = f.locks.filter(
    (x) => x.query.includes('FROM "Account"') && x.query.includes('FOR NO KEY UPDATE')
  );
  assert.deepEqual(
    accounts.slice(0, 2).map((x) => x.values[0]),
    [id(7), id(8)]
  );
  for (const account of accounts.slice(0, 2)) assert.ok(f.locks.indexOf(account) < activity);
  assert.ok(f.locks.some((x) => x.query.includes('AccountSession') && x.query.includes('FOR UPDATE')));
});
test('result notification failure rolls back reversal, decision and audit; retry changes once', async () => {
  const f = await fixture(),
    a = (await send(f)).appeal,
    body = decision();
  f.fault(true);
  await assert.rejects(() => decide(f, a, body), /Synthetic result fault/);
  assert.equal(f.latest().status, 'PENDING');
  assert.equal(f.state.penalties[0].reversedAt, null);
  assert.equal(points(f), 1);
  assert.equal(f.state.scores.length, 1);
  assert.equal(f.state.audits.length, 1);
  f.fault(false);
  await decide(f, a, body);
  assert.equal(points(f), 0);
  assert.equal(f.state.events.length, 1);
});
test('floor-zero completion credit is replayed nominally; unrelated absence stays', async () => {
  const f = await fixture(),
    a = (await send(f)).appeal;
  f.state.completions.push({ id: id(90), active: true });
  f.state.scores.push({
    accountId: id(7),
    reason: 'NORMAL_COMPLETION',
    completionId: id(90),
    delta: -1,
    pointsBefore: 1,
    pointsAfter: 0,
    decayBefore: null,
    decayAfter: null,
    simulatedAt: new Date('2030-06-01T13:00:00Z'),
    sequence: ++f.state.sequence
  });
  f.state.accounts[id(7)].activityPoints = 0;
  await f.tx.activityPenalty.create({
    data: {
      id: id(91),
      eventKey: 'absence',
      accountId: id(7),
      activityId: id(1),
      registrationId: id(2),
      reason: 'NO_SHOW',
      points: 2,
      createdAt: new Date('2030-06-01T14:00:00Z')
    }
  });
  await addActivityPenaltyPoints(f.tx, id(7), 2, new Date('2030-06-01T14:00:00Z'), 'absence', id(91));
  f.time('2030-06-02T12:00:00Z');
  await decide(f, a);
  assert.equal(points(f), 2);
  assert.equal(f.state.penalties.find((x) => x.id === id(91)).reversedAt, null);
  assert.equal(f.state.scores.at(-1).delta, 0);
});
test('later attendance reversal starts before previously reversed management grant and cannot revive it', async () => {
  const f = await fixture(),
    a = (await send(f)).appeal;
  const p = await f.tx.activityPenalty.create({
    data: {
      eventKey: 'absence-two',
      accountId: id(7),
      activityId: id(1),
      reason: 'NO_SHOW',
      points: 2,
      createdAt: new Date('2030-06-01T14:00:00Z')
    }
  });
  await addActivityPenaltyPoints(f.tx, id(7), 2, new Date('2030-06-01T14:00:00Z'), 'absence-two', p.id);
  f.time('2030-06-02T12:00:00Z');
  await decide(f, a);
  assert.equal(points(f), 2);
  await reverseAttendancePenalty(f.tx, id(7), p.id, new Date('2030-06-02T13:00:00Z'), 'VERIFIED');
  assert.equal(points(f), 0);
});
test('mine and admin list snapshots are private, paginated and have no scoring side effects', async () => {
  const f = await fixture({ base: 3 }),
    before = structuredClone(f.state),
    list = await f.service.minePenalties(url(99), owner);
  assert.equal(list.page, 1);
  privateDTO(list);
  assert.equal(list.points, 4);
  assert.equal(list.restricted, true);
  assert.deepEqual(f.state, before);
  await send(f);
  const adminList = await f.service.appeals(url(1), admin);
  privateDTO(adminList);
  assert.equal(adminList.items.length, 1);
  assert.equal((await f.service.minePenalties(url(1), '6')).items.length, 0);
  await assert.rejects(() => f.service.minePenalties(url('0'), owner), code('VALIDATION_ERROR'));
  await assert.rejects(
    () => f.service.appeals(new URL('http://local/?scope=all'), admin),
    code('VALIDATION_ERROR')
  );
});

test('late rejection settles due natural decay before reporting points/restriction and retry does not duplicate', async () => {
  const f = await fixture({ reason: 'LATE_CANCELLATION', points: 2, base: 1 }),
    a = (await send(f)).appeal,
    body = decision({ decision: 'REJECT' });
  f.time('2030-06-09T12:00:00Z');
  await decide(f, a, body);
  assert.equal(points(f), 2);
  assert.equal(f.state.penalties[0].reversedAt, null);
  assert.equal(f.state.events[0].payload.points, 2);
  assert.equal(f.state.events[0].payload.restricted, false);
  assert.equal(f.state.scores.filter((x) => x.reason === 'NATURAL_DECAY').length, 1);
  await decide(f, a, body);
  assert.equal(f.state.events.length, 1);
  assert.equal(f.state.scores.filter((x) => x.reason === 'NATURAL_DECAY').length, 1);
});
