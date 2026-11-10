import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountError } from '../../packages/domain/src/index.ts';
import { handleActivities, readActivityBody } from '../../apps/web/server/activities/http.ts';
import { setRuntime } from './support/runtime-stub.mjs';
import { input, id } from './support/activity-input.mjs';
const origin = 'http://localhost:3000';
function request(body = input(), extra = {}) {
  return new Request(origin + '/api/activities', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-artzoo-request': '1', ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}
for (const [name, headers] of [
  ['cross origin', { origin: 'http://evil.invalid' }],
  ['missing marker', { 'x-artzoo-request': '0' }],
  ['wrong type', { 'content-type': 'text/plain' }],
  ['cross site', { 'sec-fetch-site': 'cross-site' }]
])
  test('activity HTTP rejects ' + name + ' before service', async () => {
    setRuntime(undefined);
    assert.equal((await handleActivities(request(input(), headers), 'list')).status, 403);
  });
for (const [name, body] of [
  ['malformed JSON', '{'],
  ['array JSON', '[]'],
  ['oversize', 'x'.repeat(32769)]
])
  test('activity HTTP bounded body ' + name, async () => {
    setRuntime(undefined);
    assert.equal((await handleActivities(request(body), 'list')).status, 400);
  });
test('activity HTTP anonymous read/write routes produce no-store 401', async () => {
  let limits = 0;
  const auth = {
    requireAccount: async () => {
      throw new AccountError('UNAUTHENTICATED', '请先登录', 401);
    },
    limitWriteSource: async () => {
      limits++;
    },
    transaction: async (fn) => fn({}),
    db: { $transaction: async (fn) => fn({}) }
  };
  setRuntime(auth);
  for (const [action, req] of [
    ['list', new Request(origin + '/api/activities')],
    ['mine', new Request(origin + '/api/me/activities')],
    ['detail', new Request(origin + '/api/activities/' + id(2))],
    ['list', request()],
    ['register', request({ seatId: id(3), job: '骑士' })]
  ]) {
    const response = await handleActivities(req, action, id(2));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).error.code, 'UNAUTHENTICATED');
  }
  assert.equal(limits, 2);
});
test('activity HTTP unknown registration/create fields are rejected by actual service', async () => {
  setRuntime({ limitWriteSource: async () => {} });
  for (const [action, body] of [
    ['list', input({ accountId: id(3) })],
    ['register', { seatId: id(3), job: '骑士', accountId: id(3) }]
  ])
    assert.equal((await handleActivities(request(body), action, id(2))).status, 400);
});
test('activity HTTP hides internal service errors and raw input', async () => {
  setRuntime({
    transaction: async () => {
      throw Error('private database connection detail');
    }
  });
  const response = await handleActivities(new Request(origin + '/api/me/activities'), 'mine');
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(text.includes('private database'), false);
  assert.equal(JSON.parse(text).error.code, 'SERVICE_UNAVAILABLE');
});

test('activity parser accepts 200 job seats plus 2000 Chinese characters', async () => {
  const body = input({
    seats: Array.from({ length: 200 }, () => ({ kind: 'JOB', job: '暗黑骑士' })),
    description: '中'.repeat(2000)
  });
  assert.deepEqual(await readActivityBody(request(body)), body);
});
test('activity parser cancels oversized streamed body without content-length', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(32769));
    },
    cancel() {
      cancelled = true;
    }
  });
  await assert.rejects(
    () => readActivityBody(new Request(origin, { method: 'POST', duplex: 'half', body: stream })),
    (e) => e.code === 'VALIDATION_ERROR'
  );
  assert.equal(cancelled, true);
});

test('move HTTP PATCH enforces origin marker body and anonymous boundaries', async () => {
  const patch = (body, extra = {}) =>
    new Request(origin + '/api/activities/' + id(2) + '/registrations', {
      method: 'PATCH',
      headers: { origin, 'content-type': 'application/json', 'x-artzoo-request': '1', ...extra },
      body: JSON.stringify(body)
    });
  const body = { expectedSeatId: id(4), seatId: id(3), job: '骑士' };
  setRuntime(undefined);
  for (const extra of [
    { origin: 'http://evil.invalid' },
    { 'x-artzoo-request': '0' },
    { 'content-type': 'text/plain' }
  ])
    assert.equal((await handleActivities(patch(body, extra), 'move', id(2))).status, 403);
  let limited = 0;
  setRuntime({
    limitWriteSource: async () => limited++,
    requireAccount: async () => {
      throw new AccountError('UNAUTHENTICATED', 'Login', 401);
    }
  });
  const denied = await handleActivities(patch(body), 'move', id(2));
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('cache-control'), 'no-store');
  assert.equal(limited, 1);
  assert.equal((await handleActivities(patch({ ...body, accountId: id(9) }), 'move', id(2))).status, 400);
});
