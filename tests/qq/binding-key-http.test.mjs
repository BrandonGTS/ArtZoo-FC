import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const nextServer = new URL('./server.js', 'file://' + webRequire.resolve('next/headers')).href;
const runtime =
  'data:text/javascript,' +
  encodeURIComponent('export function getAccountService(){return globalThis.__bindingHttp.auth}');
const headers =
  'data:text/javascript,' +
  encodeURIComponent('export async function cookies(){return {get(){return {value:"synthetic-cookie"}}}}');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/server') return { url: nextServer, shortCircuit: true };
    if (specifier === 'next/headers') return { url: headers, shortCircuit: true };
    if (
      specifier.endsWith('/auth/runtime') ||
      specifier.endsWith('/auth/runtime.ts') ||
      (specifier === './runtime' && context.parentURL?.endsWith('/auth/http.ts'))
    )
      return { url: runtime, shortCircuit: true };
    return next(specifier, context);
  }
});
const { handleQqBinding } = await import('../../apps/web/server/qq-official/http.ts');
const { QqBindingService } = await import('../../apps/web/server/qq-official/binding.ts');
const { AccountError } = await import('@artzoo/domain');
process.env.NODE_ENV = 'test';
delete process.env.ARTZOO_DEPLOYMENT_ENV;
delete process.env.ARTZOO_PUBLIC_ORIGIN;
for (const key of Object.keys(process.env)) if (key.startsWith('ARTZOO_QQ_')) delete process.env[key];
const origin = 'http://isolated.invalid';
function setup() {
  const state = {
    quota: 0,
    calls: [],
    auth: {
      async limitWriteSource() {
        state.quota++;
      }
    }
  };
  globalThis.__bindingHttp = state;
  return state;
}
function req(action, method = 'GET', body, patch = {}) {
  return new Request(`${origin}/api/me/qq-binding/${action}`, {
    method,
    headers: { origin, 'x-artzoo-request': '1', 'content-type': 'application/json', ...patch },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}
async function mock(method, fn, run) {
  const original = QqBindingService.prototype[method];
  QqBindingService.prototype[method] = fn;
  try {
    await run();
  } finally {
    QqBindingService.prototype[method] = original;
  }
}
test('GET progress delegates authenticated request id without consuming shared write quota', async () => {
  const state = setup();
  await mock(
    'progress',
    async (body, token) => {
      state.calls.push({ body, token });
      return { state: 'PENDING', expiresAt: '2030-01-01T00:00:00.000Z' };
    },
    async () => {
      const response = await handleQqBinding(
        new Request(`${origin}/api/me/qq-binding/progress?requestId=synthetic-request&group=synthetic-group`),
        'progress'
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.deepEqual(state.calls, [
        { body: { requestId: 'synthetic-request' }, token: 'synthetic-cookie' }
      ]);
      assert.equal(state.quota, 0);
    }
  );
});
test('wrong binding HTTP methods reject before runtime quota or business call', async () => {
  const state = setup();
  for (const [action, method, body] of [
    ['progress', 'POST', {}],
    ['status', 'POST', {}],
    ['initiate', 'GET', undefined],
    ['cancel', 'GET', undefined]
  ]) {
    const response = await handleQqBinding(req(action, method, body), action);
    assert.equal(response.status, 400);
  }
  assert.equal(state.quota, 0);
});
test('write routes reject wrong origin missing marker and invalid bodies before quota', async () => {
  const state = setup();
  for (const request of [
    req('cancel', 'POST', {}, { origin: 'http://attacker.invalid' }),
    req('cancel', 'POST', {}, { 'x-artzoo-request': '' }),
    req('cancel', 'POST', {}, { 'sec-fetch-site': 'cross-site' }),
    req('cancel', 'POST', [], {}),
    req('cancel', 'POST', {}, { 'content-type': 'text/plain' })
  ]) {
    const response = await handleQqBinding(request, 'cancel');
    assert.ok([400, 403].includes(response.status));
  }
  assert.equal(state.quota, 0);
});
test('explicit cancel is same-origin POST and consumes one write quota', async () => {
  const state = setup();
  await mock(
    'cancel',
    async (body, token) => {
      state.calls.push({ body, token });
      return { cancelled: true };
    },
    async () => {
      const response = await handleQqBinding(
        req('cancel', 'POST', { requestId: 'synthetic-request' }),
        'cancel'
      );
      assert.equal(response.status, 200);
      assert.equal(state.quota, 1);
      assert.deepEqual(state.calls, [
        { body: { requestId: 'synthetic-request' }, token: 'synthetic-cookie' }
      ]);
      assert.deepEqual((await response.json()).data, { cancelled: true });
    }
  );
});
test('unknown internal failures cannot serialize a bearer key or database error', async () => {
  setup();
  const key = 'K'.repeat(43);
  await mock(
    'progress',
    async () => {
      throw new Error(key);
    },
    async () => {
      const response = await handleQqBinding(req('progress'), 'progress');
      assert.equal(response.status, 503);
      assert.ok(!(await response.text()).includes(key));
    }
  );
});
test('expired authentication propagates 401 without pretending pending or bound', async () => {
  setup();
  await mock(
    'progress',
    async () => {
      throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
    },
    async () => {
      const response = await handleQqBinding(req('progress'), 'progress');
      assert.equal(response.status, 401);
      assert.equal((await response.json()).ok, false);
    }
  );
});
