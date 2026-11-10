import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOriginal } from '../../packages/media/src/photo-original.ts';
const source = { input: Buffer.from('synthetic-only'), format: 'tiff', mime: 'image/tiff', animated: false };
test('final output hard limit refuses oversized codec result before it can be returned for storage', async () => {
  globalThis.syntheticOriginalBytes = 30 * 1024 * 1024 + 1;
  try {
    await assert.rejects(
      sanitizeOriginal(source.input, source, { timeoutSeconds: 20 }),
      (e) => e.code === 'VALIDATION_ERROR' && e.message.includes('30MiB')
    );
  } finally {
    delete globalThis.syntheticOriginalBytes;
  }
});
test('late codec result cannot pass the total deadline gate', async () => {
  globalThis.syntheticOriginalDelay = 1050;
  try {
    await assert.rejects(
      sanitizeOriginal(source.input, source, { timeoutSeconds: 1 }),
      (e) => e.code === 'VALIDATION_ERROR' && e.message.includes('超时')
    );
  } finally {
    delete globalThis.syntheticOriginalDelay;
  }
});
