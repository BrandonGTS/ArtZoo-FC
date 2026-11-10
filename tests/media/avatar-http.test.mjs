import test from 'node:test';
import assert from 'node:assert/strict';
import { readAvatarBody, validateAvatarOrigin } from '../../apps/web/server/media/http.ts';
const crop = JSON.stringify({ x: 0, y: 0, size: 1 });
function request(mutate = () => {}) {
  const body = new FormData();
  body.set('file', new File([Buffer.from('synthetic bytes')], 'image.png', { type: 'image/png' }));
  body.set('crop', crop);
  body.set('revision', '0');
  mutate(body);
  return new Request('http://localhost:3000/api/me/avatar', { method: 'POST', body });
}
const invalid = (fn) => assert.rejects(fn, (e) => e.code === 'VALIDATION_ERROR');
test('bounded multipart preserves crop and bytes', async () => {
  const out = await readAvatarBody(request());
  assert.equal(out.input.toString(), 'synthetic bytes');
  assert.deepEqual(out.crop, { x: 0, y: 0, size: 1 });
  assert.equal(out.revision, 0);
});
for (const [label, mutate] of [
  ['unknown field', (f) => f.set('accountId', 'attacker')],
  ['duplicate file', (f) => f.append('file', new File(['other'], 'x.png'))],
  ['missing crop', (f) => f.delete('crop')],
  ['file string', (f) => f.set('file', 'text')],
  ['empty file', (f) => f.set('file', new File([], 'x.png'))],
  ['bad crop JSON', (f) => f.set('crop', '{')],
  ['negative revision', (f) => f.set('revision', '-1')],
  ['decimal revision', (f) => f.set('revision', '0.1')]
])
  test('multipart rejects ' + label, async () => invalid(() => readAvatarBody(request(mutate))));
test('stream bound rejects excessive body without relying on content-length', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(10_016_385));
    },
    cancel() {
      cancelled = true;
    }
  });
  const req = new Request('http://localhost:3000/api/me/avatar', {
    method: 'POST',
    body: stream,
    duplex: 'half',
    headers: { 'content-type': 'multipart/form-data; boundary=test' }
  });
  await invalid(() => readAvatarBody(req));
  assert.equal(cancelled, true);
});
test('declared excessive or invalid length rejected before parsing', async () => {
  for (const length of ['10016385', '-1', 'abc']) {
    const req = request();
    req.headers.set('content-length', length);
    await invalid(() => readAvatarBody(req));
  }
});
test('origin requires same origin, request marker, multipart and non-cross-site metadata', () => {
  const headers = {
    origin: 'http://localhost:3000',
    'x-artzoo-request': '1',
    'content-type': 'multipart/form-data; boundary=test'
  };
  assert.doesNotThrow(() =>
    validateAvatarOrigin(new Request('http://localhost:3000/api/me/avatar', { headers }))
  );
  for (const change of [
    { origin: 'http://evil.invalid' },
    { 'x-artzoo-request': '0' },
    { 'content-type': 'application/json' },
    { 'sec-fetch-site': 'cross-site' }
  ])
    assert.throws(
      () =>
        validateAvatarOrigin(
          new Request('http://localhost:3000/api/me/avatar', { headers: { ...headers, ...change } })
        ),
      (e) => e.code === 'FORBIDDEN'
    );
});
