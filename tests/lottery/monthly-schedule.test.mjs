import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  validateLottery,
  monthlyLotteryWindow,
  earliestMonthlyDrawAt,
  monthBounds
} from '../../packages/domain/dist/lottery-contract.js';
const body = (extra = {}) => ({
  idempotencyKey: randomUUID(),
  title: 'Synthetic monthly',
  kind: 'MONTHLY',
  mode: 'AUTO',
  audience: 'MEMBER',
  month: '2026-11',
  minDays: 2,
  prizes: [{ name: 'Synthetic token', quantity: 1 }],
  drawAt: '2026-11-03T00:00:00+08:00',
  ...extra
});
const date = (s) => new Date(s + '+08:00');
test('Nov1 / N2 allows Nov3 midnight and rejects one minute before', () => {
  const now = date('2026-11-01T21:00:00');
  assert.equal(validateLottery(body(), now).minDays, 2);
  assert.throws(
    () => validateLottery(body({ drawAt: '2026-11-02T23:59:00+08:00' }), now),
    (e) => Boolean(e.fieldErrors?.drawAt)
  );
});
test('Nov15 includes today: N16 allowed, N17 rejected, earliest Dec1', () => {
  const now = date('2026-11-15T18:01:00');
  assert.equal(monthlyLotteryWindow('2026-11', now).maxDays, 16);
  assert.equal(earliestMonthlyDrawAt('2026-11', 16, now).toISOString(), '2026-11-30T16:00:00.000Z');
  assert.equal(validateLottery(body({ minDays: 16, drawAt: '2026-12-01T00:00:00+08:00' }), now).minDays, 16);
  assert.throws(
    () => validateLottery(body({ minDays: 17, drawAt: '2026-12-02T00:00:00+08:00' }), now),
    (e) => Boolean(e.fieldErrors?.minDays)
  );
});
test('last day N1 ends next midnight; current-day immediate draw rejected', () => {
  const now = date('2026-11-30T23:58:30');
  assert.equal(monthlyLotteryWindow('2026-11', now).maxDays, 1);
  validateLottery(body({ minDays: 1, drawAt: '2026-12-01T00:00:00+08:00' }), now);
  assert.throws(
    () => validateLottery(body({ minDays: 1, drawAt: '2026-11-30T23:59:00+08:00' }), now),
    (e) => Boolean(e.fieldErrors?.drawAt)
  );
});
test('past month rejected only as new publication; future month keeps whole month', () => {
  const now = date('2026-11-15T12:00:00');
  assert.equal(monthlyLotteryWindow('2026-10', now).maxDays, 0);
  assert.throws(
    () => validateLottery(body({ month: '2026-10', drawAt: '2026-12-01T00:00:00+08:00' }), now),
    (e) => Boolean(e.fieldErrors?.month)
  );
  assert.equal(monthlyLotteryWindow('2026-12', now).maxDays, 31);
  validateLottery(body({ month: '2026-12', minDays: 31, drawAt: '2027-01-01T00:00:00+08:00' }), now);
});
test('future month counts from its first day, not creation day', () => {
  const now = date('2026-11-15T12:00:00');
  assert.equal(earliestMonthlyDrawAt('2026-12', 2, now).toISOString(), '2026-12-02T16:00:00.000Z');
  assert.throws(
    () => validateLottery(body({ month: '2026-12', drawAt: '2026-12-02T23:59:00+08:00' }), now),
    (e) => Boolean(e.fieldErrors?.drawAt)
  );
  validateLottery(body({ month: '2026-12', drawAt: '2026-12-03T00:00:00+08:00' }), now);
});
test('Beijing midnight updates month and remaining dates, independent of UTC date', () => {
  assert.equal(monthlyLotteryWindow('2026-11', new Date('2026-11-14T15:59:59Z')).maxDays, 17);
  assert.equal(monthlyLotteryWindow('2026-11', new Date('2026-11-14T16:00:00Z')).maxDays, 16);
  assert.equal(monthlyLotteryWindow('2026-11', new Date('2026-11-30T16:00:00Z')).maxDays, 0);
  assert.equal(monthlyLotteryWindow('2026-12', new Date('2026-11-30T16:00:00Z')).maxDays, 31);
});
test('normal and leap February, 30/31-day and year boundaries share exact equality', () => {
  for (const month of ['2024-02', '2026-02', '2028-02', '2030-02', '2026-04', '2026-12']) {
    const { days, end } = monthBounds(month);
    const now = date(month + '-01T12:00:00');
    assert.equal(monthlyLotteryWindow(month, now).maxDays, days);
    assert.equal(earliestMonthlyDrawAt(month, days, now).getTime(), end.getTime());
    const drawAt = new Date(end.getTime() + 8 * 3600000).toISOString().slice(0, 16) + ':00+08:00';
    validateLottery(body({ month, minDays: days, drawAt }), now);
  }
});
test('historical body replay parsing is not tightened after days/month pass', () => {
  const old = body({ minDays: 30, drawAt: '2026-12-02T00:00:00+08:00' });
  assert.equal(validateLottery(old, date('2026-11-15T12:00:00'), false).minDays, 30);
  assert.equal(validateLottery(old, date('2027-01-01T12:00:00'), false).drawAt, old.drawAt);
  assert.throws(
    () => validateLottery(old, date('2026-11-15T12:00:00')),
    (e) => Boolean(e.fieldErrors?.minDays)
  );
});
test('structural replay still rejects invalid month, fractional/zero/overflow thresholds', () => {
  for (const minDays of [0, -1, 1.5, 31])
    assert.throws(
      () => validateLottery(body({ minDays }), date('2026-11-01T00:00:00'), false),
      (e) => Boolean(e.fieldErrors?.minDays)
    );
  for (const month of ['2026-00', '2026-13', '2019-11'])
    assert.throws(() => validateLottery(body({ month }), new Date(), false));
});
test('ordinary MANUAL, historical pairing replay and prize rules stay unchanged', () => {
  const now = date('2026-11-01T12:00:00');
  validateLottery(
    body({
      kind: 'ORDINARY',
      mode: 'MANUAL',
      month: null,
      minDays: null,
      drawAt: '2026-11-01T12:01:00+08:00'
    }),
    now
  );
  assert.throws(
    () => validateLottery(body({ mode: 'MANUAL' }), now),
    (e) => Boolean(e.fieldErrors?.mode)
  );
  assert.equal(validateLottery(body({ mode: 'MANUAL' }), now, false).mode, 'MANUAL');
  assert.throws(() => validateLottery(body({ prizes: [{ name: 'token', quantity: 0 }] }), now));
});
