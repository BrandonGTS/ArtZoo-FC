import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from './support/write-order-stubs.mjs';
import { handleAlbums } from '../../apps/web/server/albums/http.ts';
import { handleDaily } from '../../apps/web/server/daily/http.ts';
import { handleWishes } from '../../apps/web/server/wishes/http.ts';
import { handleKnowledgeImage } from '../../apps/web/server/knowledge/image-http.ts';
import { uploadLotteryImage } from '../../apps/web/server/lottery/media-http.ts';
import { handleAttendance } from '../../apps/web/server/activities/attendance-http.ts';
import { handlePenaltyAppeals } from '../../apps/web/server/activities/penalty-appeals-http.ts';
const id = '10000000-0000-4000-8000-000000000001';
const reset = () => {
  state.quota = 0;
  state.rate = 0;
  state.accounts = 0;
};
const invalidOrigin = () =>
  new Request('http://localhost:3100/api/synthetic', {
    method: 'POST',
    headers: { origin: 'https://attacker.invalid', 'content-type': 'multipart/form-data' },
    body: 'synthetic'
  });
for (const [name, run] of [
  ['albums upload', (r) => handleAlbums(r, 'upload', id)],
  ['album comment upload', (r) => handleAlbums(r, 'comment-upload', id)],
  ['daily upload', (r) => handleDaily(r, 'upload')],
  ['wishes upload', (r) => handleWishes(r, 'upload')],
  ['knowledge images upload', (r) => handleKnowledgeImage(r)],
  ['lottery upload', (r) => uploadLotteryImage(r)]
])
  test(name + ': invalid Origin does not consume shared quota (SEC-01 regression)', async () => {
    reset();
    const response = await run(invalidOrigin());
    assert.equal(response.status, 403);
    assert.equal(state.quota, 0);
    assert.equal((await response.json()).error.code, 'FORBIDDEN');
  });
const malformed = () =>
  new Request('http://localhost:3100/api/synthetic', {
    method: 'POST',
    headers: { origin: 'http://localhost:3100', 'x-artzoo-request': '1', 'content-type': 'application/json' },
    body: '{'
  });
for (const [name, run] of [
  ['attendance record', (r) => handleAttendance(r, 'record', id)],
  ['penalty appeal', (r) => handlePenaltyAppeals(r, 'submit', id)],
  ['daily create', (r) => handleDaily(r, 'list')],
  ['album create', (r) => handleAlbums(r, 'list')]
])
  test(name + ': malformed JSON does not consume shared quota (SEC-01 regression)', async () => {
    reset();
    const response = await run(malformed());
    assert.equal(response.status, 400);
    assert.equal(state.quota, 0);
    assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
  });
