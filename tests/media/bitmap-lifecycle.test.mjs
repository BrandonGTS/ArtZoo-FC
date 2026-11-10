import test from 'node:test';
import assert from 'node:assert/strict';
import { bitmap } from '../../packages/media/src/bitmap-runtime.ts';
const input = Buffer.from('synthetic-only');
for (const scenario of ['constructor', 'error', 'exit', 'bad-message', 'hang'])
  test(`worker ${scenario} rejects safely and frees capacity`, async () => {
    globalThis.bmpWorkerScenario = scenario;
    await assert.rejects(
      bitmap(input, 1),
      (error) => error.code === 'VALIDATION_ERROR' && error.message === '图片解码失败或暂不支持此编码'
    );
    assert.equal(globalThis.artzooBitmapWorkers, 0);
    const last = globalThis.bmpFakeWorkers.at(-1);
    if (scenario !== 'constructor') assert.ok(last.terminated);
    globalThis.bmpWorkerScenario = 'success';
    assert.deepEqual(await bitmap(input, 1), Buffer.from([1, 2, 3]));
  });
test('slot and promise retained until terminate resolves, including competing exit/message events', async () => {
  globalThis.bmpWorkerScenario = 'slow-terminate';
  let resolved = false;
  const pending = bitmap(input, 1).then(() => {
    resolved = true;
  });
  await new Promise(setImmediate);
  const worker = globalThis.bmpFakeWorkers.at(-1);
  assert.ok(worker.terminated);
  assert.equal(globalThis.artzooBitmapWorkers, 1);
  assert.equal(resolved, false);
  worker.emit('exit', 1);
  worker.emit('error', Error('late error'));
  worker.emit('message', { ok: true, output: new Uint8Array([4]) });
  assert.equal(globalThis.artzooBitmapWorkers, 1);
  worker.releaseTermination();
  await pending;
  assert.equal(globalThis.artzooBitmapWorkers, 0);
  assert.equal(worker.listenerCount('message'), 0);
  assert.equal(worker.listenerCount('error'), 0);
  assert.equal(worker.listenerCount('exit'), 0);
});

test('failed termination keeps a live worker counted and observed until its exit', async () => {
  globalThis.bmpWorkerScenario = 'terminate-error';
  await assert.rejects(bitmap(input, 1), (error) => error.code === 'VALIDATION_ERROR');
  const worker = globalThis.bmpFakeWorkers.at(-1);
  assert.equal(globalThis.artzooBitmapWorkers, 1);
  worker.emit('error', Error('late synthetic error'));
  assert.equal(globalThis.artzooBitmapWorkers, 1);
  worker.emit('exit', 1);
  assert.equal(globalThis.artzooBitmapWorkers, 0);
  assert.equal(worker.listenerCount('error'), 0);
});
