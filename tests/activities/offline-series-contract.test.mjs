import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCreateActivity,
  validateSeriesInput,
  generateSeriesPeriods
} from '../../packages/domain/src/index.ts';
import { offlineInput, seriesInput } from './support/series-fixture.mjs';
const invalid = (fn) => assert.throws(fn, (e) => e.code === 'VALIDATION_ERROR');
const generate = (end) =>
  generateSeriesPeriods(
    new Date('2030-12-30T15:30:00Z'),
    validateSeriesInput({ weekdays: [1, 3], durationMinutes: 120, end })
  );
for (const count of [2, 10])
  test('COUNT bounded ' + count, () => {
    const p = generate({ kind: 'COUNT', count });
    assert.equal(p.length, count);
    assert.equal(p[1].startsAt.toISOString(), '2031-01-01T15:30:00.000Z');
    assert.ok(p.every((p) => p.endsAt - p.startsAt === 7200000));
  });
for (const count of [0, 1, 11, 2.5, '2'])
  test('COUNT rejects ' + count, () => invalid(() => generate({ kind: 'COUNT', count })));
for (const [date, length] of [
  ['2031-01-01', 2],
  ['2031-01-29', 10]
])
  test('DATE Beijing inclusive ' + date, () => {
    const p = generate({ kind: 'DATE', date });
    assert.equal(p.length, length);
    assert.equal(p[0].endsAt.toISOString(), '2030-12-30T17:30:00.000Z');
  });
for (const date of ['2030-12-29', '2030-12-30', '2031-02-05'])
  test('DATE cannot bypass 2–10 ' + date, () => invalid(() => generate({ kind: 'DATE', date })));
for (const patch of [
  { weekdays: [] },
  { weekdays: [1, 1] },
  { weekdays: [0] },
  { weekdays: [8] },
  { durationMinutes: 0 },
  { durationMinutes: 1.5 },
  { end: { kind: 'DATE', date: '2031-02-29' } },
  { end: { kind: 'DATE', date: '2031-01-01', count: 2 } }
])
  test('strict series ' + JSON.stringify(patch), () =>
    invalid(() => validateSeriesInput({ ...seriesInput().series, ...patch }))
  );
test('first Beijing weekday and explicit end match duration', () => {
  const body = seriesInput();
  invalid(() => validateCreateActivity({ ...body, series: { ...body.series, weekdays: [2] } }));
  invalid(() => validateCreateActivity({ ...body, endsAt: '2030-12-31T01:31:00+08:00' }));
});
for (const capacity of [1, 200, null])
  test('offline capacity ' + capacity, () => {
    const result = validateCreateActivity(offlineInput({ capacity }));
    assert.equal(result.seats.length, capacity ?? 0);
    assert.equal(result.offline.capacity, capacity);
  });
for (const capacity of [0, 201, 1.5, '1', undefined])
  test('offline rejects capacity ' + capacity, () =>
    invalid(() => validateCreateActivity(offlineInput({ capacity })))
  );
test('offline cutoff equal start and cross-date end', () => {
  const body = offlineInput({ registrationClosesAt: '2030-12-30T23:30:00+08:00' });
  assert.equal(validateCreateActivity(body).offline.registrationClosesAt, body.startsAt);
});
for (const patch of [
  { endsAt: '2030-12-30T23:30:00+08:00' },
  { seats: [{ kind: 'ANY' }] },
  { mode: 'SERIES' },
  { category: 'DUNGEON' },
  { offline: { ...offlineInput().offline, registrationClosesAt: '2030-12-30T23:31:00+08:00' } }
])
  test('offline rejects incompatible ' + JSON.stringify(patch), () =>
    invalid(() => validateCreateActivity({ ...offlineInput(), ...patch }))
  );
