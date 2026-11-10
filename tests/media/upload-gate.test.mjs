import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { withUploadSlot } from '../../apps/web/server/media/upload-gate.ts';
import { readBoundedMultipart } from '../../apps/web/server/media/multipart.ts';
import { state, reset, auth, QuickLinkService } from './support/http-stubs.mjs';
import { handleAlbums } from '../../apps/web/server/albums/http.ts';
import { handleDaily, readPhotoBody } from '../../apps/web/server/daily/http.ts';
import { handleWishes } from '../../apps/web/server/wishes/http.ts';
import { handleActivityShares } from '../../apps/web/server/activity-shares/http.ts';
import { handleKnowledgeImage } from '../../apps/web/server/knowledge/image-http.ts';
import { uploadLotteryImage } from '../../apps/web/server/lottery/media-http.ts';
import { submitQuickIconUpload } from '../../apps/web/server/quick-links/upload-http.ts';
import { failure } from '../../apps/web/server/auth/http.ts';
import { withAvatarUploadSlot } from '../../apps/web/server/media/processor.ts';
const origin = 'http://localhost:3100',
  id = '10000000-0000-4000-8000-000000000001';
const command = {
  action: 'update',
  expectedRevision: 0,
  idempotencyKey: 'synthetic-key-0001',
  id,
  revision: 0,
  name: 'synthetic',
  url: 'https://example.invalid'
};
const routes = [
  ['album', (r) => handleAlbums(r, 'upload', id)],
  ['album-comment', (r) => handleAlbums(r, 'comment-upload', id)],
  ['daily', (r) => handleDaily(r, 'upload')],
  ['wish', (r) => handleWishes(r, 'upload')],
  ['share', (r) => handleActivityShares(r, 'upload', id)],
  ['knowledge', (r) => handleKnowledgeImage(r)],
  ['lottery', (r) => uploadLotteryImage(r)],
  [
    'quick',
    async (r) => {
      try {
        return Response.json(await submitQuickIconUpload(r, new QuickLinkService(auth), 'synthetic-cookie'), {
          status: 201
        });
      } catch (error) {
        return failure(error);
      }
    }
  ]
];
async function payload(name, duplicate = false) {
  const form = new FormData();
  form.append('file', new File(['synthetic-image'], 'synthetic.png', { type: 'image/png' }));
  if (name === 'quick') form.append('command', JSON.stringify(command));
  else {
    form.append('batchId', id);
    form.append('batchIndex', '0');
  }
  if (duplicate) form.append('file', new File(['duplicate'], 'duplicate.png'));
  const encoded = new Request(origin, { method: 'POST', body: form });
  return {
    bytes: new Uint8Array(await encoded.arrayBuffer()),
    contentType: encoded.headers.get('content-type')
  };
}
function request(data, held, declared, signal) {
  const probe = { reads: 0, cancelled: 0 };
  let sent = false;
  const stream = new ReadableStream(
    {
      async pull(controller) {
        probe.reads++;
        if (held) await held;
        if (sent) controller.close();
        else {
          sent = true;
          controller.enqueue(data.bytes);
        }
      },
      cancel() {
        probe.cancelled++;
      }
    },
    { highWaterMark: 0 }
  );
  const value = new Request(origin + '/synthetic', {
    method: 'POST',
    body: stream,
    duplex: 'half',
    signal,
    headers: {
      origin,
      'x-artzoo-request': '1',
      'content-type': data.contentType,
      ...(declared === undefined ? {} : { 'content-length': declared })
    }
  });
  return { value, probe };
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(setImmediate);
  }
  assert.fail('operation did not reach expected state');
}
for (const [name, run] of routes) {
  test(name + ' real Request preserves valid multipart, duplicate denial and 429 ordering', async () => {
    reset();
    const good = request(await payload(name));
    assert.equal((await run(good.value)).status, 201);
    assert.equal(state.quota, 1);
    reset();
    assert.equal((await run(request(await payload(name, true)).value)).status, 400);
    assert.equal(state.quota, 0);
    reset();
    state.parseExhausted = true;
    const denied = request(await payload(name));
    assert.equal((await run(denied.value)).status, 429);
    assert.equal(denied.probe.reads, 0);
  });
}
test('all eight route families share two full-lifetime slots before reading bodies', async () => {
  reset();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const a = request(await payload('album'), held),
    b = request(await payload('daily'), held);
  const first = routes[0][1](a.value),
    second = routes[2][1](b.value);
  try {
    await until(() => a.probe.reads === 1 && b.probe.reads === 1);
    await assert.rejects(
      () => withAvatarUploadSlot(async () => {}),
      (error) => error.status === 503
    );
    for (const [name, run] of routes) {
      const extra = request(await payload(name));
      assert.equal((await run(extra.value)).status, 503, name);
      assert.equal(extra.probe.reads, 0, name);
    }
  } finally {
    release();
  }
  assert.equal((await first).status, 201);
  assert.equal((await second).status, 201);
  assert.equal(globalThis.artzooUploadRequests, 0);
  assert.equal((await routes[4][1](request(await payload('share')).value)).status, 201);
});
test('configured limit one and invalid configuration defaults to two', async () => {
  const old = process.env.ARTZOO_UPLOAD_CONCURRENCY;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  try {
    process.env.ARTZOO_UPLOAD_CONCURRENCY = '1';
    const first = withUploadSlot(() => held);
    await assert.rejects(
      () => withUploadSlot(async () => {}),
      (error) => error.status === 503
    );
    release();
    await first;
    for (const invalid of ['0', '9', '-1', 'x', '2.5']) {
      process.env.ARTZOO_UPLOAD_CONCURRENCY = invalid;
      let done;
      const pending = new Promise((resolve) => {
        done = resolve;
      });
      const a = withUploadSlot(() => pending),
        b = withUploadSlot(() => pending);
      try {
        await assert.rejects(
          () => withUploadSlot(async () => {}),
          (error) => error.status === 503
        );
      } finally {
        done();
        await Promise.all([a, b]);
      }
    }
  } finally {
    release();
    if (old === undefined) delete process.env.ARTZOO_UPLOAD_CONCURRENCY;
    else process.env.ARTZOO_UPLOAD_CONCURRENCY = old;
  }
});
const limits = {
  maxBytes: 1024,
  timeoutMs: 10,
  emptyMessage: 'empty',
  oversizeMessage: 'large',
  timeoutMessage: 'timeout'
};
test('bounded stream accepts exact bytes and rejects excess despite absent or dishonest lengths', async () => {
  const data = await payload('daily');
  for (const declared of [undefined, '1']) {
    const exact = request(data, undefined, declared);
    assert.equal(
      (
        await readBoundedMultipart(exact.value, { ...limits, maxBytes: data.bytes.length, timeoutMs: 1000 })
      ).getAll('file').length,
      1
    );
    const excess = request(data, undefined, declared);
    await assert.rejects(
      () => readBoundedMultipart(excess.value, { ...limits, maxBytes: data.bytes.length - 1 }),
      (error) => error.status === 400 && error.message === 'large'
    );
    assert.equal(excess.probe.cancelled, 1);
  }
  const declaredTooLarge = request(data, undefined, String(30 * 1024 * 1024 + 16385));
  await assert.rejects(
    () => readPhotoBody(declaredTooLarge.value),
    (error) => error.status === 400
  );
  assert.equal(declaredTooLarge.probe.reads, 0);
});
test('malformed multipart and missing boundaries use runtime parser rejection without retaining a slot', async () => {
  for (const contentType of ['multipart/form-data', 'multipart/form-data; boundary=x']) {
    const data = { bytes: Buffer.from('not multipart'), contentType };
    await assert.rejects(
      () => withUploadSlot(() => readBoundedMultipart(request(data).value, limits)),
      (error) => error.status === 400
    );
    assert.equal(globalThis.artzooUploadRequests, 0);
  }
});
test('timeout cancels even a stalled cancellation promise and releases the upload gate', async () => {
  let cancelled = 0;
  const body = new ReadableStream(
    {
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled++;
        return new Promise(() => {});
      }
    },
    { highWaterMark: 0 }
  );
  const value = new Request(origin, {
    method: 'POST',
    body,
    duplex: 'half',
    headers: { 'content-type': 'multipart/form-data; boundary=x' }
  });
  await assert.rejects(
    () => withUploadSlot(() => readBoundedMultipart(value, limits)),
    (error) => error.status === 400 && error.message === 'timeout'
  );
  assert.equal(cancelled, 1);
  assert.equal(globalThis.artzooUploadRequests, 0);
});
test('caller abort cancels source and releases the gate', async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const body = new ReadableStream(
    {
      cancel() {
        cancelled++;
      }
    },
    { highWaterMark: 0 }
  );
  const value = new Request(origin, {
    method: 'POST',
    body,
    duplex: 'half',
    signal: controller.signal,
    headers: { 'content-type': 'multipart/form-data; boundary=x' }
  });
  const pending = withUploadSlot(() => readBoundedMultipart(value, { ...limits, timeoutMs: 1000 }));
  controller.abort();
  await assert.rejects(
    () => pending,
    (error) => error.status === 400 && error.message.includes('取消')
  );
  assert.equal(cancelled, 1);
  assert.equal(globalThis.artzooUploadRequests, 0);
});

test('runtime multipart compatibility preserves quoted boundaries, Unicode filenames and byte-split framing', async () => {
  const boundary = 'synthetic boundary with spaces';
  const bytes = Buffer.from(
    '--' +
      boundary +
      '\r\nContent-Disposition: form-data; name="file"; filename="合成;image.png"\r\nContent-Type: image/png\r\n\r\nsynthetic\r\n--' +
      boundary +
      '\r\nContent-Disposition: form-data; name="batchId"\r\n\r\n' +
      id +
      '\r\n--' +
      boundary +
      '--\r\n'
  );
  const contentType = 'multipart/form-data; boundary="' + boundary + '"';
  const expected = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
  let offset = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.subarray(offset, ++offset));
      }
    },
    { highWaterMark: 0 }
  );
  const value = new Request(origin, {
    method: 'POST',
    body,
    duplex: 'half',
    headers: { 'content-type': contentType }
  });
  const actual = await readBoundedMultipart(value, { ...limits, timeoutMs: 1000 });
  assert.equal(actual.get('batchId'), expected.get('batchId'));
  assert.equal(actual.get('file').name, expected.get('file').name);
  assert.equal(actual.get('file').type, expected.get('file').type);
  assert.deepEqual(await actual.get('file').arrayBuffer(), await expected.get('file').arrayBuffer());
  assert.equal(value.body.locked, false);
});
test('source failure releases body lock and global slot without changing the original failure', async () => {
  const error = new TypeError('synthetic stream failure');
  const body = new ReadableStream(
    {
      pull(controller) {
        controller.error(error);
      }
    },
    { highWaterMark: 0 }
  );
  const value = new Request(origin, {
    method: 'POST',
    body,
    duplex: 'half',
    headers: { 'content-type': 'multipart/form-data; boundary=x' }
  });
  await assert.rejects(
    () => withUploadSlot(() => readBoundedMultipart(value, limits)),
    (actual) => actual === error
  );
  assert.equal(value.body.locked, false);
  assert.equal(globalThis.artzooUploadRequests, 0);
});

test('slow album and share body uploads do not occupy image decoder slots', async () => {
  reset();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const album = request(await payload('album'), held),
    share = request(await payload('share'), held);
  const before = globalThis.artzooPhotoUploads ?? 0;
  const first = handleAlbums(album.value, 'upload', id),
    second = handleActivityShares(share.value, 'upload', id);
  try {
    await until(() => album.probe.reads === 1 && share.probe.reads === 1);
    assert.equal(globalThis.artzooPhotoUploads ?? 0, before);
  } finally {
    release();
  }
  assert.equal((await first).status, 201);
  assert.equal((await second).status, 201);
  assert.equal(globalThis.artzooUploadRequests, 0);
});
