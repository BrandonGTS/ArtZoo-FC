import test from 'node:test';
import assert from 'node:assert/strict';
import { state, reset, auth, QuickLinkService } from './support/stubs.mjs';
import { handleAlbums } from '../../apps/web/server/albums/http.ts';
import { handleDaily } from '../../apps/web/server/daily/http.ts';
import { handleWishes } from '../../apps/web/server/wishes/http.ts';
import { handleActivityShares } from '../../apps/web/server/activity-shares/http.ts';
import { handleKnowledgeImage } from '../../apps/web/server/knowledge/image-http.ts';
import { uploadLotteryImage } from '../../apps/web/server/lottery/media-http.ts';
import { submitQuickIconUpload } from '../../apps/web/server/quick-links/upload-http.ts';
import { handleAttendance } from '../../apps/web/server/activities/attendance-http.ts';
import { handlePenaltyAppeals } from '../../apps/web/server/activities/penalty-appeals-http.ts';
import { failure } from '../../apps/web/server/auth/http.ts';
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
const quick = async (r) => {
  try {
    return Response.json(
      { ok: true, data: await submitQuickIconUpload(r, new QuickLinkService(auth), 'synthetic-cookie') },
      { status: 201 }
    );
  } catch (e) {
    return failure(e);
  }
};
const uploads = [
  ['album', (r) => handleAlbums(r, 'upload', id)],
  ['album-comment', (r) => handleAlbums(r, 'comment-upload', id)],
  ['daily', (r) => handleDaily(r, 'upload')],
  ['wish', (r) => handleWishes(r, 'upload')],
  ['share', (r) => handleActivityShares(r, 'upload', id)],
  ['knowledge', (r) => handleKnowledgeImage(r)],
  ['lottery', (r) => uploadLotteryImage(r)],
  ['quick-icon', quick]
];
const jsonRoutes = [
  ['attendance', (r) => handleAttendance(r, 'record', id), 32768],
  ['penalty', (r) => handlePenaltyAppeals(r, 'submit', id), 32768],
  ['daily', (r) => handleDaily(r, 'list'), 32768],
  ['album', (r) => handleAlbums(r, 'list'), 8192],
  ['album-photos', (r) => handleAlbums(r, 'photos', id), 1024 * 1024]
];
// This inert request port counts reader acquisition/read/cancel without eager
// ReadableStream pulls, a network socket, fixture DB, decoder or storage.
function request(bytes, contentType, extra = {}, gate) {
  const headers = new Headers({ origin, 'x-artzoo-request': '1', 'content-type': contentType, ...extra });
  const probe = { acquired: 0, read: 0, cancelled: 0, released: 0 };
  let sent = false,
    finish;
  const cancelled = new Promise((r) => (finish = r));
  return {
    url: origin + '/api/synthetic',
    method: 'POST',
    headers,
    signal: new AbortController().signal,
    probe,
    body: {
      getReader() {
        probe.acquired++;
        state.events.push('reader');
        return {
          async read() {
            probe.read++;
            if (gate) await Promise.race([gate, cancelled]);
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() {
            probe.cancelled++;
            sent = true;
            finish();
          },
          releaseLock() {
            probe.released++;
          }
        };
      }
    }
  };
}
async function multipart(name, kind = 'valid', extra = {}, gate) {
  const form = new FormData(),
    icon = name === 'quick-icon';
  form.append(
    'file',
    new File([kind === 'empty-file' ? '' : 'synthetic-image'], 'synthetic.png', { type: 'image/png' })
  );
  if (icon) form.append('command', kind === 'bad-command' ? '[]' : JSON.stringify(command));
  else {
    form.append('batchId', id);
    form.append('batchIndex', kind === 'bad-index' ? '10' : '0');
  }
  if (kind === 'duplicate') form.append('file', new File(['duplicate'], 'duplicate.png'));
  if (kind === 'unknown') form.append('unexpected', 'x');
  if (kind === 'missing') form.delete(icon ? 'command' : 'batchIndex');
  if (kind === 'period') form.append('periodActivityId', id);
  const real = new Request(origin, { method: 'POST', body: form });
  return request(new Uint8Array(await real.arrayBuffer()), real.headers.get('content-type'), extra, gate);
}
function assertNoWork(r) {
  assert.equal(r.probe.acquired, 0);
  assert.equal(state.quota, 0);
  assert.equal(state.business, 0);
  assert.equal(state.decoded, 0);
  assert.equal(state.stored, 0);
}
for (const [name, run] of uploads) {
  for (const [label, headers] of [
    ['foreign-origin', { origin: 'https://attacker.invalid' }],
    ['missing-marker', { 'x-artzoo-request': '' }],
    ['cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['wrong-type', { 'content-type': 'text/plain' }]
  ])
    test(name + ' rejects ' + label + ' before auth/body/quota', async () => {
      reset();
      const r = await multipart(name, 'valid', headers),
        response = await run(r);
      assert.equal(response.status, 403);
      assertNoWork(r);
      assert.deepEqual(state.events, []);
    });
  for (const kind of [
    'malformed',
    'empty-file',
    'duplicate',
    'unknown',
    'missing',
    'bad-index',
    ...(name === 'quick-icon' ? ['bad-command'] : [])
  ]) {
    if (name === 'quick-icon' && kind === 'bad-index') continue;
    test(name + ' rejects ' + kind + ' without consuming write quota', async () => {
      reset();
      const r =
        kind === 'malformed'
          ? request(new TextEncoder().encode('invalid'), 'multipart/form-data; boundary=synthetic')
          : await multipart(name, kind);
      const response = await run(r);
      assert.equal(response.status, 400);
      assert.equal(state.quota, 0);
      assert.equal(state.parsing, 1);
      assert.equal(state.business, 0);
      assert.equal(state.decoded, 0);
      assert.equal(state.stored, 0);
      assert.ok(state.events.some((x) => x === 'auth' || x === 'admin'));
      assert.ok(state.events.indexOf('parseBudget') < state.events.indexOf('reader'));
    });
  }
  for (const length of ['-1', 'not-a-size', String((name === 'quick-icon' ? 2 : 30) * 1024 * 1024 + 16385)])
    test(name + ' declared length ' + length + ' rejects without auth/body/quota', async () => {
      reset();
      const r = await multipart(name, 'valid', { 'content-length': length }),
        response = await run(r);
      assert.equal(response.status, 400);
      assertNoWork(r);
      assert.deepEqual(state.events, []);
    });
  test(name + ' missing body fails without legitimate quota', async () => {
    reset();
    const r = await multipart(name);
    r.body = null;
    assert.equal((await run(r)).status, 400);
    assert.equal(state.quota, 0);
    assert.equal(state.business, 0);
    assert.equal(state.parsing, 1);
  });
  test(name + ' authentication failure never reads body or reserves parser/write quota', async () => {
    reset();
    state.denied = true;
    const r = await multipart(name);
    assert.equal((await run(r)).status, 401);
    assertNoWork(r);
    assert.equal(state.parsing, 0);
    assert.equal(state.checks, 0);
  });
  for (const [flag, event] of [
    ['exhausted', 'check'],
    ['parseExhausted', 'parseBudget']
  ])
    test(name + ' ' + flag + ' 429 stops before body', async () => {
      reset();
      state[flag] = true;
      const r = await multipart(name),
        response = await run(r);
      assert.equal(response.status, 429);
      assert.equal(response.headers.get('retry-after'), '900');
      assertNoWork(r);
      assert.ok(state.events.includes(event));
    });
  test(name + ' valid input consumes one write quota before service/decoder', async () => {
    reset();
    const r = await multipart(name),
      response = await run(r);
    assert.equal(response.status, 201);
    assert.equal(state.quota, 1);
    assert.equal(state.parsing, 1);
    assert.ok(state.events.indexOf('check') < state.events.indexOf('reader'));
    assert.ok(state.events.indexOf('parseBudget') < state.events.indexOf('reader'));
    const work = state.events.indexOf(name === 'lottery' ? 'decode' : 'business');
    assert.ok(state.events.indexOf('consume') < work);
    if (name === 'share') assert.equal(state.events[0], 'admin');
    assert.equal(state.rate, name === 'knowledge' || name === 'lottery' ? 1 : 0);
  });
  test(name + ' atomic consume still rejects race after parse without service/decoder', async () => {
    reset();
    state.denyConsume = true;
    const r = await multipart(name),
      response = await run(r);
    assert.equal(response.status, 429);
    assert.ok(r.probe.acquired > 0);
    assert.equal(state.quota, 1);
    assert.equal(state.business, 0);
    assert.equal(state.decoded, 0);
    assert.equal(state.rate, 0);
  });
  test(name + ' stream byte cap cancels body without legitimate quota', async () => {
    reset();
    const max = name === 'quick-icon' ? 2 * 1024 * 1024 : 30 * 1024 * 1024,
      r = request(new Uint8Array(max + 16385), 'multipart/form-data; boundary=synthetic');
    assert.equal((await run(r)).status, 400);
    assert.equal(r.probe.cancelled, 1);
    assert.equal(r.probe.released, 1);
    assert.equal(state.quota, 0);
    assert.equal(state.business, 0);
    assert.equal(state.decoded, 0);
  });
  test(name + ' full-body concurrency admits two, rejects third, releases slot', async () => {
    reset();
    let release;
    const gate = new Promise((r) => (release = r)),
      a = await multipart(name, 'valid', {}, gate);
    const malformed = () =>
      request(new TextEncoder().encode('invalid'), a.headers.get('content-type'), {}, gate);
    const x = malformed(),
      y = malformed(),
      first = run(x),
      second = run(y);
    for (let i = 0; i < 30 && x.probe.acquired + y.probe.acquired < 2; i++) await new Promise(setImmediate);
    assert.equal(x.probe.acquired + y.probe.acquired, 2);
    const c = await multipart(name);
    assert.equal((await run(c)).status, 503);
    assert.equal(c.probe.acquired, 0);
    assert.equal(state.quota, 0);
    release();
    assert.equal((await first).status, 400);
    assert.equal((await second).status, 400);
    assert.equal((await run(await multipart(name))).status, 201);
  });
  test(name + ' upload deadline cancels stalled reader and releases slot', async (t) => {
    reset();
    let unblock;
    const gate = new Promise((r) => (unblock = r));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const r = await multipart(name, 'valid', {}, gate),
        pending = run(r);
      for (let i = 0; i < 30 && !r.probe.acquired; i++) await new Promise(setImmediate);
      assert.equal(r.probe.acquired, 1);
      t.mock.timers.tick(name === 'quick-icon' ? 15000 : 60000);
      const response = await pending;
      assert.equal(response.status, 400);
      assert.equal(r.probe.cancelled, 1);
      assert.equal(r.probe.released, 1);
      assert.equal(state.quota, 0);
    } finally {
      unblock();
      t.mock.timers.reset();
    }
    assert.equal((await run(await multipart(name))).status, 201);
  });
}
test('share rejects album-only period field without write quota', async () => {
  reset();
  assert.equal((await handleActivityShares(await multipart('share', 'period'), 'upload', id)).status, 400);
  assert.equal(state.quota, 0);
});
for (const [name, run, max] of jsonRoutes) {
  for (const [label, headers] of [
    ['foreign-origin', { origin: 'https://attacker.invalid' }],
    ['marker', { 'x-artzoo-request': '' }],
    ['cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['content-type', { 'content-type': 'text/plain' }]
  ])
    test(name + ' JSON rejects ' + label + ' without acquiring reader', async () => {
      reset();
      const r = request(new TextEncoder().encode('{}'), 'application/json', headers);
      assert.equal((await run(r)).status, 403);
      assertNoWork(r);
    });
  for (const flag of ['denied', 'exhausted', 'parseExhausted'])
    test(name + ' JSON ' + flag + ' stops before reader', async () => {
      reset();
      state[flag] = true;
      const r = request(new TextEncoder().encode('{}'), 'application/json');
      assert.equal((await run(r)).status, flag === 'denied' ? 401 : 429);
      assertNoWork(r);
    });
  if (name === 'attendance' || name === 'penalty')
    test(name + ' unauthenticated malformed JSON is 401 without acquiring reader', async () => {
      reset();
      state.denied = true;
      const r = request(new TextEncoder().encode('{'), 'application/json');
      assert.equal((await run(r)).status, 401);
      assertNoWork(r);
      assert.equal(state.parsing, 0);
    });
  for (const content of ['{', '[]', 'null', '"text"'])
    test(name + ' JSON ' + content + ' does not consume legitimate quota', async () => {
      reset();
      const r = request(new TextEncoder().encode(content), 'application/json'),
        response = await run(r);
      assert.equal(response.status, 400);
      assert.equal(state.quota, 0);
      assert.equal(state.business, 0);
    });
  test(name + ' JSON stream cap retained', async () => {
    reset();
    const r = request(new Uint8Array(max + 1), 'application/json');
    assert.equal((await run(r)).status, 400);
    assert.equal(r.probe.cancelled, 1);
    assert.equal(state.quota, 0);
  });
  test(name + ' valid JSON still consumes exactly once', async () => {
    reset();
    const r = request(new TextEncoder().encode('{}'), 'application/json');
    assert.ok([200, 201].includes((await run(r)).status));
    assert.equal(r.probe.acquired, 1);
    assert.equal(state.quota, 1);
    assert.equal(state.business, 1);
  });
  test(name + ' valid JSON still respects 429', async () => {
    reset();
    state.denyConsume = true;
    const response = await run(request(new TextEncoder().encode('{}'), 'application/json'));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '900');
    assert.equal(state.business, 0);
  });
}
