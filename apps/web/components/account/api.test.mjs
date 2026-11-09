import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { accountRequest, AccountApiError, errorDetail, safeReturnTo } from './api.ts';

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});
test('return destinations are exact allowlisted local paths', () => {
  for (const path of ['/', '/admin', '/admin/invitations', '/admin/accounts'])
    assert.equal(safeReturnTo(path), path);
  for (const path of [
    'https://example.com',
    '//example.com',
    '/\\example.com',
    '/admin?next=https://example.com',
    '/invite/token',
    'javascript:alert(1)',
    ' /admin',
    '/admin/../outside'
  ])
    assert.equal(safeReturnTo(path), '/');
});
test('write sends same-origin credentials and required anti-CSRF headers without modifying passwords', async () => {
  const body = { phone: '+8613800138000', password: ' abc! ' };
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/auth/login');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['X-ArtZoo-Request'], '1');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), body);
    return Response.json({ ok: true, data: { verified: true } });
  };
  assert.deepEqual(await accountRequest('/api/auth/login', { method: 'POST', body }), { verified: true });
});
test('GET never sends mutation headers or body and accepts anonymous snapshots', async () => {
  globalThis.fetch = async (_, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.equal(options.headers, undefined);
    return Response.json({ ok: true, data: { user: null } });
  };
  assert.deepEqual(await accountRequest('/api/auth/session'), { user: null });
});
test('field errors and unknown business reasons survive the adapter', async () => {
  const error = { code: 'NEW_REASON', message: '手机号地区尚未配置', fieldErrors: { phone: '请核对地区' } };
  globalThis.fetch = async () => Response.json({ ok: false, error }, { status: 400 });
  await assert.rejects(accountRequest('/api/auth/login', { method: 'POST' }), (failure) => {
    assert.ok(failure instanceof AccountApiError);
    assert.deepEqual(failure.detail, { ...error, retryAfterSeconds: undefined });
    return true;
  });
});
test('rate limits use Retry-After when the body does not specify it', async () => {
  globalThis.fetch = async () =>
    Response.json(
      { ok: false, error: { code: 'RATE_LIMITED', message: '发送过于频繁' } },
      { status: 429, headers: { 'Retry-After': '60' } }
    );
  await assert.rejects(
    accountRequest('/api/auth/verification-codes', { method: 'POST' }),
    (failure) => failure.detail.retryAfterSeconds === 60
  );
});
test('explicit server cooldown takes precedence over the HTTP header', async () => {
  globalThis.fetch = async () =>
    Response.json(
      { ok: false, error: { code: 'RATE_LIMITED', message: '稍后再获取', retryAfterSeconds: 120 } },
      { status: 429, headers: { 'Retry-After': '60' } }
    );
  await assert.rejects(
    accountRequest('/api/auth/verification-codes', { method: 'POST' }),
    (failure) => failure.detail.retryAfterSeconds === 120
  );
});
test('failed HTTP status cannot be represented as successful data', async () => {
  globalThis.fetch = async () => Response.json({ ok: true, data: { loggedIn: true } }, { status: 503 });
  await assert.rejects(accountRequest('/api/auth/login'), AccountApiError);
});
test('malformed or non-JSON responses produce a plain service reason', async () => {
  for (const response of [
    new Response('<html>bad gateway</html>', { status: 502 }),
    Response.json({ unexpected: true }),
    Response.json({ ok: false })
  ]) {
    globalThis.fetch = async () => response;
    await assert.rejects(accountRequest('/api/auth/config'), AccountApiError);
  }
});
test('network failures do not leak raw exception contents', async () => {
  globalThis.fetch = async () => {
    throw new Error('internal debug string');
  };
  await assert.rejects(
    accountRequest('/api/auth/config'),
    (failure) => failure instanceof AccountApiError && !failure.message.includes('internal')
  );
  assert.equal(errorDetail(new Error('internal debug string')).code, 'UNKNOWN_ERROR');
});
test('cancelled reads remain cancellation signals', async () => {
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async () => {
    throw controller.signal.reason;
  };
  await assert.rejects(
    accountRequest('/api/auth/config', { signal: controller.signal }),
    (failure) => failure.name === 'AbortError'
  );
});
