import test from 'node:test';
import assert from 'node:assert/strict';
import { teamBatchTimes, teamCycleWindow, teamTimes } from '../../packages/domain/src/index.ts';
const window = teamCycleWindow(new Date('2026-10-24T00:00:00Z'), 1);
const slot = (startsAt, endsAt = '2026-11-04T00:00:00+08:00') => ({ startsAt, endsAt });
const rejects = (sessions, field) =>
  assert.throws(
    () => teamBatchTimes({ sessions }, window),
    (e) => e.code === 'VALIDATION_ERROR' && (!field || field in e.fieldErrors)
  );
test('weekly batch permits one through eight Beijing dates including both Tuesdays, with full end timestamps', () => {
  const sessions = Array.from({ length: 8 }, (_, day) =>
    slot(
      `2026-${day < 5 ? '10' : '11'}-${String(day < 5 ? 27 + day : day - 4).padStart(2, '0')}T${day === 7 ? '15:59:59.999' : '16:00:00'}+08:00`
    )
  );
  const parsed = teamBatchTimes({ sessions }, window);
  assert.equal(parsed.length, 8);
  assert.equal(parsed[0].startsAt.toISOString(), window.startsAt.toISOString());
  assert.equal(parsed[7].startsAt.toISOString(), '2026-11-03T07:59:59.999Z');
  assert.equal(parsed[7].endsAt.toISOString(), '2026-11-03T16:00:00.000Z');
  assert.equal(teamBatchTimes({ sessions: [sessions[0]] }, window).length, 1);
  assert.ok(+parsed[0].endsAt - +parsed[0].startsAt > 86400000, 'no new duration maximum');
});
test('weekly batch rejects missing/zero selections, malformed values and nested forged fields', () => {
  for (const sessions of [undefined, null, {}, []]) rejects(sessions, 'sessions');
  for (const value of [null, [], 42, { ...slot('2026-10-27T16:00:00+08:00'), state: 'CONFIRMED' }])
    rejects([value], 'sessions.0');
  rejects([slot('2026-02-30T16:00:00+08:00')], 'sessions.0.startsAt');
  rejects([slot('2026-10-27T08:00:00Z')], 'sessions.0.startsAt');
});
test('weekly start window is half open, while end may cross next reset', () => {
  rejects([slot('2026-10-27T15:59:59.999+08:00')], 'sessions.0.startsAt');
  rejects([slot('2026-11-03T16:00:00+08:00')], 'sessions.0.startsAt');
  assert.equal(teamBatchTimes({ sessions: [slot('2026-11-03T15:59:59.999+08:00')] }, window).length, 1);
  for (const end of ['2026-10-27T15:00:00+08:00', '2026-10-27T16:00:00+08:00'])
    rejects([slot('2026-10-27T16:00:00+08:00', end)], 'sessions.0.endsAt');
});
test('weekly batch accepts multiple same-day sessions and more than eight total scenes', () => {
  const sessions = Array.from({ length: 12 }, (_, i) =>
    slot(
      `2026-10-28T${String(8 + i).padStart(2, '0')}:00:00+08:00`,
      `2026-10-28T${String(10 + i).padStart(2, '0')}:00:00+08:00`
    )
  );
  const parsed = teamBatchTimes({ sessions }, window);
  assert.equal(parsed.length, 12);
  assert.equal(parsed[1].startsAt.toISOString(), '2026-10-28T01:00:00.000Z');
  assert.ok(parsed[0].endsAt > parsed[1].startsAt, 'overlap remains allowed');
  const acrossDays = sessions.map((s, i) =>
    i < 6
      ? s
      : { ...s, startsAt: s.startsAt.replace('10-28', '10-29'), endsAt: s.endsAt.replace('10-28', '10-29') }
  );
  assert.equal(teamBatchTimes({ sessions: acrossDays }, window).length, 12);
});
test('weekly batch rejects only exact start/end pair duplicates with indexed error', () => {
  const first = slot('2026-10-28T16:00:00+08:00', '2026-10-28T18:00:00+08:00');
  rejects([first, first], 'sessions.1.startsAt');
  for (const second of [
    slot('2026-10-28T16:00:00+08:00', '2026-10-28T19:00:00+08:00'),
    slot('2026-10-28T17:00:00+08:00', '2026-10-28T18:00:00+08:00')
  ])
    assert.equal(teamBatchTimes({ sessions: [first, second] }, window).length, 2);
  assert.equal(
    teamTimes(slot('2026-10-28T23:00:00+08:00', '2026-10-29T01:00:00+08:00')).endsAt.toISOString(),
    '2026-10-28T17:00:00.000Z'
  );
});
