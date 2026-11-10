import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  TEAM_CYCLE_TIME_ZONE,
  teamCycleWindow,
  teamSessionInCycle
} from '../../packages/domain/src/team-cycle.ts';

function windowIso(now, shift) {
  const window = teamCycleWindow(new Date(now), shift);
  return [window.startsAt.toISOString(), window.endsAt.toISOString()];
}

test('team CD time zone and full current window are explicit', () => {
  assert.equal(TEAM_CYCLE_TIME_ZONE, 'Asia/Shanghai');
  assert.deepEqual(windowIso('2026-10-19T23:59:00+08:00'), [
    '2026-10-13T08:00:00.000Z',
    '2026-10-20T08:00:00.000Z'
  ]);
});

test('Tuesday 15:59 remains in the previous cycle and 16:00 opens the next cycle', () => {
  for (const now of ['2026-10-20T00:00:00+08:00', '2026-10-20T15:59:00+08:00']) {
    assert.deepEqual(windowIso(now), ['2026-10-13T08:00:00.000Z', '2026-10-20T08:00:00.000Z']);
  }
  assert.deepEqual(windowIso('2026-10-20T16:00:00+08:00'), [
    '2026-10-20T08:00:00.000Z',
    '2026-10-27T08:00:00.000Z'
  ]);
  assert.deepEqual(windowIso('2026-10-21T12:00:00+08:00'), [
    '2026-10-20T08:00:00.000Z',
    '2026-10-27T08:00:00.000Z'
  ]);
});

test('one millisecond on either side of the reset is assigned precisely', () => {
  assert.deepEqual(windowIso('2026-10-20T07:59:59.999Z'), [
    '2026-10-13T08:00:00.000Z',
    '2026-10-20T08:00:00.000Z'
  ]);
  for (const now of ['2026-10-20T08:00:00.000Z', '2026-10-20T08:00:00.001Z']) {
    assert.deepEqual(windowIso(now), ['2026-10-20T08:00:00.000Z', '2026-10-27T08:00:00.000Z']);
  }
});

test('next and previous cycles are whole adjacent windows, including their final Tuesday', () => {
  const now = new Date('2026-10-19T12:00:00+08:00');
  const current = teamCycleWindow(now);
  const next = teamCycleWindow(now, 1);
  const previous = teamCycleWindow(now, -1);
  assert.equal(next.startsAt.getTime(), current.endsAt.getTime());
  assert.equal(previous.endsAt.getTime(), current.startsAt.getTime());
  assert.deepEqual(windowIso(now, 1), ['2026-10-20T08:00:00.000Z', '2026-10-27T08:00:00.000Z']);
  assert.equal(teamSessionInCycle(new Date('2026-10-27T15:59:59.999+08:00'), next), true);
  assert.equal(teamSessionInCycle(new Date('2026-10-27T16:00:00+08:00'), next), false);
  assert.deepEqual(windowIso(now, 2), ['2026-10-27T08:00:00.000Z', '2026-11-03T08:00:00.000Z']);
});

test('windows cross year and leap-day boundaries without date truncation', () => {
  assert.deepEqual(windowIso('2027-01-01T12:00:00+08:00'), [
    '2026-12-29T08:00:00.000Z',
    '2027-01-05T08:00:00.000Z'
  ]);
  assert.deepEqual(windowIso('2024-02-29T12:00:00+08:00'), [
    '2024-02-27T08:00:00.000Z',
    '2024-03-05T08:00:00.000Z'
  ]);
  assert.deepEqual(windowIso('2024-03-05T15:59:00+08:00'), [
    '2024-02-27T08:00:00.000Z',
    '2024-03-05T08:00:00.000Z'
  ]);
});

test('UTC and Beijing representations of the same instant produce the same window', () => {
  assert.deepEqual(windowIso('2026-10-20T16:00:00+08:00'), windowIso('2026-10-20T08:00:00Z'));
});

test('session membership is start-based, left-inclusive and right-exclusive', () => {
  const window = teamCycleWindow(new Date('2026-10-21T12:00:00+08:00'));
  const start = window.startsAt.getTime();
  const end = window.endsAt.getTime();
  for (const [timestamp, expected] of [
    [start - 1, false],
    [start, true],
    [start + 1, true],
    [end - 1, true],
    [end, false],
    [end + 1, false]
  ]) {
    assert.equal(teamSessionInCycle(new Date(timestamp), window), expected);
  }
  // A session starting just before reset belongs here even if it finishes afterward.
  const session = {
    startsAt: new Date('2026-10-27T15:59:00+08:00'),
    endsAt: new Date('2026-10-27T18:00:00+08:00')
  };
  assert.equal(teamSessionInCycle(session.startsAt, window), true);
  assert.equal(session.endsAt.toISOString(), '2026-10-27T10:00:00.000Z');
});

test('functions return fresh dates and preserve their inputs', () => {
  const now = new Date('2026-10-21T12:00:00+08:00');
  const before = now.getTime();
  const window = teamCycleWindow(now);
  const originalWindow = [window.startsAt.getTime(), window.endsAt.getTime()];
  const session = new Date(window.startsAt);
  teamSessionInCycle(session, window);
  assert.equal(now.getTime(), before);
  assert.equal(session.getTime(), originalWindow[0]);
  assert.deepEqual([window.startsAt.getTime(), window.endsAt.getTime()], originalWindow);
  window.startsAt.setTime(0);
  assert.equal(teamCycleWindow(now).startsAt.getTime(), originalWindow[0]);
});

test('invalid dates, noninteger shifts and out-of-range windows are rejected', () => {
  const valid = new Date('2026-10-21T12:00:00+08:00');
  for (const value of [new Date(NaN), new Date(Infinity)]) {
    assert.throws(() => teamCycleWindow(value), RangeError);
    assert.throws(() => teamSessionInCycle(value, teamCycleWindow(valid)), RangeError);
    assert.throws(() => teamSessionInCycle(valid, { startsAt: value, endsAt: valid }), RangeError);
    assert.throws(() => teamSessionInCycle(valid, { startsAt: valid, endsAt: value }), RangeError);
  }
  for (const shift of [NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    assert.throws(() => teamCycleWindow(valid, shift), RangeError);
  }
  assert.throws(() => teamCycleWindow(valid, Number.MAX_SAFE_INTEGER), RangeError);
  assert.throws(() => teamCycleWindow('2026-10-21'), TypeError);
  assert.throws(() => teamSessionInCycle('2026-10-21', teamCycleWindow(valid)), TypeError);
  for (const endsAt of [valid, new Date(valid.getTime() - 1)]) {
    assert.throws(() => teamSessionInCycle(valid, { startsAt: valid, endsAt }), RangeError);
  }
});

test('results do not depend on the host TZ setting', () => {
  const moduleUrl = new URL('../../packages/domain/src/team-cycle.ts', import.meta.url).href;
  const script = `import {teamCycleWindow} from ${JSON.stringify(moduleUrl)};
const window=teamCycleWindow(new Date('2026-10-20T07:59:59.999Z'),1);
console.log(JSON.stringify([window.startsAt.toISOString(),window.endsAt.toISOString()]));`;
  const results = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'].map((TZ) => {
    const result = spawnSync(
      process.execPath,
      ['--import', './tests/_shared/loader.mjs', '--input-type=module', '-e', script],
      { cwd: new URL('../.././', import.meta.url), env: { ...process.env, TZ }, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  assert.deepEqual(results, Array(3).fill(['2026-10-20T08:00:00.000Z', '2026-10-27T08:00:00.000Z']));
});
