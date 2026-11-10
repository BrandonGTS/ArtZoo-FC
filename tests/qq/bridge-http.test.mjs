import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const headersUrl = new URL('file://' + require.resolve('next/headers')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/server')
      return { url: new URL('./server.js', headersUrl).href, shortCircuit: true };
    if (specifier === 'next/headers') return { url: headersUrl, shortCircuit: true };
    return next(specifier, context);
  }
});
const { handleQqBridge } = await import('../../apps/web/server/qq-official/http.ts');
const synthetic = {
  ARTZOO_QQ_MODE: 'simulation',
  NODE_ENV: 'test',
  ARTZOO_QQ_TARGET_KIND: 'TEST',
  ARTZOO_QQ_TEST_GROUP_APPROVED: '1',
  ARTZOO_QQ_APP_ID: 'mock_app',
  ARTZOO_QQ_BOT_ID: 'mock_bot',
  ARTZOO_QQ_GROUP_OPENID: 'mock_group',
  ARTZOO_QQ_ENABLED_AT: '2030-06-01T09:00:00Z',
  ARTZOO_QQ_BRIDGE_SECRET: 'synthetic-http-test-secret-only-000000'
};
async function withConfig(env, fn) {
  const saved = {};
  for (const key of Object.keys(synthetic)) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    await fn();
  } finally {
    for (const key of Object.keys(synthetic)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}
const request = (url = 'http://isolated.invalid/api/qq-official/bridge/commands', options = {}) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    ...options
  });
async function denied(req) {
  const response = await handleQqBridge(req, 'commands');
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.error.code, 'FORBIDDEN');
}
test('HTTP bridge defaults disabled and denies before any database initialization', () =>
  withConfig({}, async () => {
    await denied(request());
  }));
test('HTTP bridge rejects missing HMAC, query string, content type and wrong method without database access', () =>
  withConfig(synthetic, async () => {
    await denied(request());
    await denied(request('http://isolated.invalid/api/qq-official/bridge/commands?x=1'));
    await denied(request(undefined, { headers: { 'content-type': 'text/plain' } }));
    await denied(request(undefined, { method: 'GET', body: undefined }));
  }));
test('HTTP bridge limits declared and streamed request size before authentication', () =>
  withConfig(synthetic, async () => {
    for (const req of [
      request(undefined, { headers: { 'content-type': 'application/json', 'content-length': '9000' } }),
      request(undefined, { body: 'x'.repeat(8193) })
    ]) {
      const response = await handleQqBridge(req, 'commands');
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
    }
  }));
