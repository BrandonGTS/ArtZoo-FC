import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AccountError, safeAccountReturnTo } from '../../packages/domain/src/index.ts';
import { handleAttendance } from '../../apps/web/server/activities/attendance-http.ts';
import { setRuntime } from './support/runtime-stub.mjs';
import { id } from './support/activity-input.mjs';
const origin = 'http://localhost:3000';
const body = () => ({
  idempotencyKey: randomUUID(),
  registrationId: id(2),
  expectedAttendanceRevision: 0,
  status: 'PRESENT'
});
const request = (payload = body(), extra = {}) =>
  new Request(origin + '/api/activities/' + id(1) + '/attendance', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-artzoo-request': '1', ...extra },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload)
  });
test('attendance writes enforce same-origin marker before reaching services', async () => {
  setRuntime(undefined);
  for (const headers of [
    { origin: 'http://evil.invalid' },
    { 'x-artzoo-request': '0' },
    { 'content-type': 'text/plain' },
    { 'sec-fetch-site': 'cross-site' }
  ])
    assert.equal((await handleAttendance(request(body(), headers), 'record', id(1))).status, 403);
});
test('attendance HTTP rejects malformed oversized and extra account/status fields', async () => {
  setRuntime({
    db: {},
    requireAccount: async () => ({ accountId: id(1) }),
    checkWriteSource: async () => {},
    limitWriteParsing: async () => {},
    limitWriteSource: async () => {}
  });
  for (const payload of ['{', '[]', 'x'.repeat(32769), { ...body(), accountId: id(7) }])
    assert.equal((await handleAttendance(request(payload), 'record', id(1))).status, 400);
});
test('attendance and admin routes require authentication and remain no-store', async () => {
  const auth = {
    requireAccount: async () => {
      throw new AccountError('UNAUTHENTICATED', 'Login', 401);
    },
    limitWriteSource: async () => {},
    db: { $transaction: async (fn) => fn({}) }
  };
  setRuntime(auth);
  for (const action of ['read', 'list']) {
    const response = await handleAttendance(new Request(origin + '/api/attendance'), action, id(1));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await handleAttendance(request(), 'record', id(1))).status, 401);
  assert.equal(
    (
      await handleAttendance(
        request({
          idempotencyKey: randomUUID(),
          expectedAttendanceRevision: 1,
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
test('new admin return path is explicit while external and arbitrary admin paths stay rejected', () => {
  assert.equal(safeAccountReturnTo('/admin/attendance-appeals'), '/admin/attendance-appeals');
  assert.equal(safeAccountReturnTo('//evil.invalid'), '/');
  assert.equal(safeAccountReturnTo('/admin/unknown'), '/');
});
