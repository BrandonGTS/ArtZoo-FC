import assert from 'node:assert/strict';
import test from 'node:test';
import {
  publicationStorageKey,
  savePublicationAttempt,
  readPublicationAttempt,
  clearPublicationAttempt,
  publicationRemainsUnknown
} from '../../apps/web/components/lottery/publication-recovery.ts';
const rows = new Map();
globalThis.sessionStorage = {
  getItem: (k) => rows.get(k) ?? null,
  setItem: (k, v) => rows.set(k, String(v)),
  removeItem: (k) => rows.delete(k)
};
const owner = 'synthetic-owner',
  body = {
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
    title: 'Frozen title',
    kind: 'MONTHLY',
    mode: 'AUTO',
    audience: 'MEMBER',
    month: '2025-11',
    minDays: 2,
    prizes: [
      { name: 'One', quantity: 2 },
      { name: 'Two', quantity: 3 }
    ],
    drawAt: '2025-12-01T20:00:00+08:00'
  };
test('reload restores the original key, payload and monthly quantities even after its deadline', () => {
  rows.clear();
  savePublicationAttempt({ owner, body, uncertain: false });
  const restored = readPublicationAttempt(owner);
  assert.equal(restored.uncertain, true);
  assert.deepEqual(restored.body, body);
  assert.equal(
    restored.body.prizes.reduce((sum, p) => sum + p.quantity, 0),
    5
  );
  assert.equal(readPublicationAttempt('different-owner'), null);
  assert.ok(rows.has(publicationStorageKey(owner)));
  clearPublicationAttempt(owner);
  assert.equal(readPublicationAttempt(owner), null);
});
test('an auth/rate/ordinary rejection on retry never proves an earlier unknown commit absent', () => {
  for (const code of ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE', 'UNKNOWN_ERROR'])
    assert.equal(publicationRemainsUnknown(false, code), true);
  for (const code of ['RATE_LIMITED', 'UNAUTHENTICATED', 'FORBIDDEN', 'CONFLICT', 'VALIDATION_ERROR'])
    assert.equal(publicationRemainsUnknown(true, code), true);
  assert.equal(publicationRemainsUnknown(false, 'VALIDATION_ERROR'), false);
  assert.equal(publicationRemainsUnknown(false, 'FORBIDDEN'), false);
});
test('only locked replay absence followed by an expired schedule can resolve an unknown request negatively', () => {
  assert.equal(publicationRemainsUnknown(true, 'VALIDATION_ERROR', { drawAt: 'expired' }), false);
  assert.equal(publicationRemainsUnknown(true, 'VALIDATION_ERROR', { month: 'started' }), false);
  assert.equal(publicationRemainsUnknown(true, 'VALIDATION_ERROR', { title: 'invalid' }), true);
});
