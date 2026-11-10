import test from 'node:test';
import assert from 'node:assert/strict';
import { handleActivities } from '../../apps/web/server/activities/http.ts';
import { setRuntime } from './support/runtime-stub.mjs';
import { harness, id, offlineInput } from './support/series-fixture.mjs';
const origin = 'http://localhost:3000';
const request = (body, extra = {}) =>
  new Request(origin + '/api/activities', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-artzoo-request': '1', ...extra },
    body: JSON.stringify(body)
  });
test('HTTP offline signup is authenticated, recipient-owned and no-store', async () => {
  const h = harness({ points: 3 });
  setRuntime(h.auth, id(10));
  const response = await handleActivities(request({ seatId: null, job: null }), 'register', id(1));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.activity.myRegistration.participant.id, id(10));
  assert.equal(h.state.events[0].recipientId, id(10));
});
test('HTTP series confirmation uses organizer permissions and replay behavior', async () => {
  const h = harness({ series: true, full: true, capacity: 2 }),
    body = { idempotencyKey: id(700), expectedRevision: 0 };
  setRuntime(h.auth, id(91));
  assert.equal((await handleActivities(request(body), 'series-confirm', id(1))).status, 403);
  setRuntime(h.auth, id(90));
  assert.equal((await handleActivities(request(body), 'series-confirm', id(1))).status, 200);
  const response = await handleActivities(request(body), 'series-confirm', id(1));
  assert.equal((await response.json()).data.replayed, true);
  assert.equal(h.state.events.length, 2);
});
for (const [label, headers] of [
  ['cross-origin', { origin: 'http://evil.invalid' }],
  ['missing marker', { 'x-artzoo-request': '0' }],
  ['cross-site', { 'sec-fetch-site': 'cross-site' }]
])
  test('HTTP blocks ' + label + ' before series write', async () => {
    setRuntime(undefined);
    assert.equal(
      (
        await handleActivities(
          request({ idempotencyKey: id(700), expectedRevision: 0 }, headers),
          'series-confirm',
          id(1)
        )
      ).status,
      403
    );
  });
test('HTTP rejects injected series fields and offline actor/capacity overrides', async () => {
  const h = harness();
  setRuntime(h.auth, id(10));
  for (const [action, body] of [
    ['series-confirm', { idempotencyKey: id(700), expectedRevision: 0, accountId: id(90) }],
    ['register', { seatId: null, job: null, capacity: null }],
    ['list', { ...offlineInput(), accountId: id(90) }]
  ])
    assert.equal((await handleActivities(request(body), action, id(1))).status, 400);
  assert.equal(h.state.events.length, 0);
});
