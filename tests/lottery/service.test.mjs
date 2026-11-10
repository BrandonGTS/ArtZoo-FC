import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validateLottery, monthBounds } from '../../packages/domain/src/lottery-contract.ts';
import {
  savePublicationAttempt,
  readPublicationAttempt
} from '../../apps/web/components/lottery/publication-recovery.ts';
const now = new Date('2030-01-10T00:00:00Z');
const ordinary = {
  idempotencyKey: randomUUID(),
  title: 'Synthetic title',
  kind: 'ORDINARY',
  mode: 'MANUAL',
  audience: 'MEMBER',
  month: null,
  minDays: null,
  prizes: [{ name: 'Synthetic prize', quantity: 1 }],
  drawAt: '2030-02-01T00:00:00+08:00'
};
const monthly = (month, minDays, drawAt) => ({
  ...ordinary,
  kind: 'MONTHLY',
  mode: 'AUTO',
  month,
  minDays,
  drawAt
});
test('new kind/mode pair is fixed; legacy recovery parser preserves both historical mismatches', () => {
  assert.equal(validateLottery(ordinary, now).mode, 'MANUAL');
  const month = monthly('2030-02', 28, '2030-03-01T00:00:00+08:00');
  assert.equal(validateLottery(month, now).mode, 'AUTO');
  for (const legacy of [
    { ...ordinary, mode: 'AUTO' },
    { ...month, mode: 'MANUAL' }
  ]) {
    assert.throws(
      () => validateLottery(legacy, now),
      (e) => Boolean(e.fieldErrors?.mode)
    );
    assert.deepEqual(validateLottery(legacy, new Date('2040-01-01'), false), legacy);
    let saved;
    globalThis.sessionStorage = {
      setItem: (_, value) => {
        saved = value;
      },
      getItem: () => saved,
      removeItem: () => assert.fail('legacy pending request must not be discarded')
    };
    savePublicationAttempt({ owner: 'synthetic-owner', body: legacy, uncertain: true });
    assert.deepEqual(readPublicationAttempt('synthetic-owner').body, legacy);
  }
});
test('N follows selected month including February/leap year, 30/31 days and has no default', () => {
  for (const [month, max, next] of [
    ['2030-02', 28, '2030-03'],
    ['2032-02', 29, '2032-03'],
    ['2030-04', 30, '2030-05'],
    ['2030-05', 31, '2030-06']
  ]) {
    const b = monthly(month, max, next + '-01T00:00:00+08:00');
    assert.equal(monthBounds(month).days, max);
    assert.equal(validateLottery(b, now).minDays, max);
    for (const minDays of [0, max + 1, 1.5, null, undefined])
      assert.throws(
        () => validateLottery({ ...b, minDays }, now),
        (e) => Boolean(e.fieldErrors?.minDays)
      );
  }
});
test('current and future Beijing months pass, while past months and unavailable sign-in days fail', () => {
  const b = monthly('2030-02', 1, '2030-03-02T00:00:00+08:00');
  for (const time of ['2030-01-31T15:59:59.999Z', '2030-01-31T16:00:00Z', '2030-02-15T00:00:00Z'])
    assert.doesNotThrow(() => validateLottery(b, new Date(time)));
  assert.throws(
    () => validateLottery(b, new Date('2030-03-01T00:00:00Z')),
    (e) => Boolean(e.fieldErrors?.month)
  );
  assert.throws(
    () => validateLottery({ ...b, minDays: 2 }, new Date('2030-02-28T00:00:00Z')),
    (e) => Boolean(e.fieldErrors?.minDays)
  );
});
