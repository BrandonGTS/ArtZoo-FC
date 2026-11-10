import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AccountError, safeAccountReturnTo } from '../../packages/domain/src/index.ts';
import { handlePenaltyAppeals } from '../../apps/web/server/activities/penalty-appeals-http.ts';
import { setRuntime } from './support/runtime-stub.mjs';
import { id } from './support/activity-input.mjs';
const origin = 'http://localhost:3000',
  body = () => ({ idempotencyKey: randomUUID(), expectedLatestAppealId: null, reason: 'Review' });
const request = (payload = body(), extra = {}) =>
  new Request(origin + '/api/me/activity-penalties/' + id(20) + '/appeals', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-artzoo-request': '1', ...extra },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload)
  });
test('penalty writes enforce same-origin before runtime or body', async () => {
  setRuntime(undefined);
  for (const extra of [
    { origin: 'http://evil.invalid' },
    { 'x-artzoo-request': '0' },
    { 'content-type': 'text/plain' },
    { 'sec-fetch-site': 'cross-site' }
  ])
    assert.equal((await handlePenaltyAppeals(request(body(), extra), 'submit', id(20))).status, 403);
});
test('penalty HTTP bounds and validates body before service side effects', async () => {
  setRuntime({
    db: {},
    requireAccount: async () => ({ accountId: id(1) }),
    checkWriteSource: async () => {},
    limitWriteParsing: async () => {},
    limitWriteSource: async () => {}
  });
  for (const payload of ['{', '[]', 'x'.repeat(32769), { ...body(), accountId: id(7) }])
    assert.equal((await handlePenaltyAppeals(request(payload), 'submit', id(20))).status, 400);
});
test('member/admin reads and writes require authentication and are no-store', async () => {
  const auth = {
    requireAccount: async () => {
      throw new AccountError('UNAUTHENTICATED', 'Login', 401);
    },
    limitWriteSource: async () => {},
    db: { $transaction: async (fn) => fn({}) }
  };
  setRuntime(auth);
  for (const action of ['mine', 'list']) {
    const response = await handlePenaltyAppeals(new Request(origin + '/api/penalties'), action);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await handlePenaltyAppeals(request(), 'submit', id(20))).status, 401);
  assert.equal(
    (
      await handlePenaltyAppeals(
        request({
          idempotencyKey: randomUUID(),
          expectedAppealRevision: 0,
          decision: 'APPROVE',
          reason: 'Verified'
        }),
        'decide',
        id(50)
      )
    ).status,
    401
  );
});
test('implemented return paths are explicit and external/arbitrary paths remain blocked', () => {
  for (const path of ['/me/activity-penalties', '/admin/penalty-appeals'])
    assert.equal(safeAccountReturnTo(path), path);
  for (const path of ['//evil.invalid', '/admin/unknown', '/me/activity-penalties/other'])
    assert.equal(safeAccountReturnTo(path), '/');
});
