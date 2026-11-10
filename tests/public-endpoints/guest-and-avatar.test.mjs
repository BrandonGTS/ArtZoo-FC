import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, reset } from './support/stubs.mjs';
import { POST as uploadAvatar } from '../../apps/web/app/api/me/avatar/route.ts';
import { handleGuestContact } from '../../apps/web/server/guest-contact/http.ts';
const origin = 'http://localhost:3100';
beforeEach(() => {
  reset();
  process.env.NODE_ENV = 'test';
  process.env.ARTZOO_DEPLOYMENT_ENV = 'local';
  process.env.ARTZOO_PUBLIC_ORIGIN = origin;
  process.env.ARTZOO_TRUSTED_PROXY = 'caddy';
});
function inertRequest(bytes, contentType, overrides = {}, method = 'POST') {
  const headers = new Headers({
    origin,
    'x-artzoo-request': '1',
    'content-type': contentType,
    'x-forwarded-for': '198.51.100.55, 203.0.113.7',
    ...overrides
  });
  let sent = false;
  return {
    url: origin + '/api/synthetic',
    method,
    headers,
    signal: new AbortController().signal,
    body: {
      getReader() {
        state.events.push('body-reader');
        return {
          async read() {
            state.events.push('body-read');
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() {
            state.events.push('body-cancel');
          },
          releaseLock() {}
        };
      }
    }
  };
}
function jsonRequest(
  body = { qq: '12345', message: 'synthetic', submissionKey: 'synthetic-key' },
  overrides = {},
  method = 'POST'
) {
  return inertRequest(
    new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
    'application/json',
    overrides,
    method
  );
}
async function avatarRequest(mutate = () => {}, overrides = {}) {
  const form = new FormData();
  form.set('file', new File(['synthetic-image-bytes'], 'synthetic.png', { type: 'image/png' }));
  form.set('crop', JSON.stringify({ x: 0, y: 0, size: 1 }));
  form.set('revision', '2');
  mutate(form);
  const encoded = new Request(origin + '/api/me/avatar', { method: 'POST', body: form });
  return inertRequest(
    new Uint8Array(await encoded.arrayBuffer()),
    encoded.headers.get('content-type'),
    overrides
  );
}
async function limited(response) {
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '37');
  assert.equal((await response.json()).error.code, 'RATE_LIMITED');
}
for (const name of ['guest', 'avatar'])
  test(name + ' rejects cross-origin input before any read, quota or business work', async () => {
    const response =
      name === 'guest'
        ? await handleGuestContact(jsonRequest({}, { origin: 'http://evil.invalid' }), 'submit')
        : await uploadAvatar(await avatarRequest(() => {}, { origin: 'http://evil.invalid' }));
    assert.equal(response.status, 403);
    assert.deepEqual(state.events, []);
  });
for (const body of ['{', '[]', 'null', ''])
  test('guest rejects invalid JSON body without consuming write quota: ' + JSON.stringify(body), async () => {
    const response = await handleGuestContact(jsonRequest(body), 'submit');
    assert.equal(response.status, 400);
    assert.deepEqual(state.consumed, []);
    assert.deepEqual(state.submitted, []);
  });
test('guest submit forwards the rightmost trusted source and session token after valid JSON', async () => {
  const response = await handleGuestContact(jsonRequest(), 'submit');
  assert.equal(response.status, 201);
  assert.deepEqual(state.consumed, [{ source: 'ip:203.0.113.7', token: state.token }]);
  assert.equal(state.submitted.length, 1);
  assert.ok(state.events.indexOf('body-read') < state.events.indexOf('consume'));
  assert.ok(state.events.indexOf('consume') < state.events.indexOf('submit'));
});
test('anonymous guest submit forwards no token and keeps the shared fallback without trusted proxy', async () => {
  state.token = null;
  delete process.env.ARTZOO_TRUSTED_PROXY;
  const response = await handleGuestContact(jsonRequest(), 'submit');
  assert.equal(response.status, 201);
  assert.deepEqual(state.consumed, [{ source: 'untrusted-source', token: undefined }]);
});
test('guest process forwards its account token, while read-only list does not consume', async () => {
  const response = await handleGuestContact(
    jsonRequest({ expectedRevision: 3 }),
    'process',
    'synthetic-message'
  );
  assert.equal(response.status, 200);
  assert.deepEqual(state.processed, [
    { id: 'synthetic-message', body: { expectedRevision: 3 }, token: state.token }
  ]);
  const count = state.consumed.length;
  assert.equal((await handleGuestContact(jsonRequest({}, {}, 'GET'), 'list')).status, 200);
  assert.equal(state.consumed.length, count);
  assert.equal(state.listed[0].token, state.token);
});
test('guest global or account quota rejection returns 429 without submitting or processing', async () => {
  state.failConsume = true;
  await limited(await handleGuestContact(jsonRequest(), 'submit'));
  await limited(await handleGuestContact(jsonRequest(), 'process', 'synthetic-message'));
  assert.deepEqual(state.submitted, []);
  assert.deepEqual(state.processed, []);
});
test('avatar authenticates and reserves parsing budget before reading a valid body; consumes only after parsing', async () => {
  const response = await uploadAvatar(await avatarRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(state.checked, [{ source: 'ip:203.0.113.7', token: state.token }]);
  assert.deepEqual(state.parsing, [{ source: 'ip:203.0.113.7', accountId: state.accountId }]);
  assert.deepEqual(state.consumed, [{ source: 'ip:203.0.113.7', token: state.token }]);
  assert.deepEqual(state.privateRate, { key: 'avatar:synthetic-account', limit: 10, seconds: 900 });
  for (const [before, after] of [
    ['authorize', 'check'],
    ['check', 'parse-budget'],
    ['parse-budget', 'body-reader'],
    ['body-read', 'consume'],
    ['consume', 'upload']
  ]) {
    assert.ok(state.events.indexOf(before) < state.events.indexOf(after), before + ' before ' + after);
  }
  assert.equal(state.uploaded[0][0], state.token);
  assert.equal(state.uploaded[0][1], state.accountId);
  assert.equal(state.uploaded[0][2].toString(), 'synthetic-image-bytes');
  assert.deepEqual(state.uploaded[0][3], { x: 0, y: 0, size: 1 });
  assert.equal(state.uploaded[0][4], 2);
});
test('avatar invalid multipart fields consume only the independent parsing budget', async () => {
  const response = await uploadAvatar(await avatarRequest((form) => form.delete('crop')));
  assert.equal(response.status, 400);
  assert.equal(state.parsing.length, 1);
  assert.deepEqual(state.consumed, []);
  assert.deepEqual(state.uploaded, []);
});
for (const flag of ['failCheck', 'failParsing'])
  test('avatar ' + flag + ' returns 429 before body access', async () => {
    state[flag] = true;
    await limited(await uploadAvatar(await avatarRequest()));
    assert.ok(!state.events.includes('body-reader'));
    assert.deepEqual(state.consumed, []);
    assert.deepEqual(state.uploaded, []);
  });
test('avatar quota failure after valid parsing blocks upload without losing Retry-After', async () => {
  state.failConsume = true;
  await limited(await uploadAvatar(await avatarRequest()));
  assert.ok(state.events.includes('body-read'));
  assert.deepEqual(state.uploaded, []);
});
for (const deny of ['missing-cookie', 'invalid-session'])
  test('avatar ' + deny + ' never acquires a body reader or write budget', async () => {
    if (deny === 'missing-cookie') state.token = null;
    else state.denyAccount = true;
    const response = await uploadAvatar(await avatarRequest());
    assert.equal(response.status, 401);
    assert.ok(!state.events.includes('body-reader'));
    assert.deepEqual(state.checked, []);
    assert.deepEqual(state.parsing, []);
    assert.deepEqual(state.consumed, []);
  });
