import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { bmp } from './support/bitmap-fixtures.mjs';
const require = createRequire(new URL('../../packages/media/package.json', import.meta.url)),
  sharp = require('sharp');
const folder = process.env.ARTZOO_MEDIA04_MODE === 'dist' ? 'dist' : 'src';
const ext = folder === 'dist' ? 'js' : 'ts';
const { bitmap } = await import(`../../packages/media/${folder}/bitmap-runtime.${ext}`);
const { processPhoto } = await import(`../../packages/media/${folder}/photo-processor.${ext}`);
for (const bits of [24, 32])
  for (const topDown of [false, true])
    test(`BMP ${bits}-bit ${topDown ? 'top-down' : 'bottom-up'} RGB/padding/alpha parity`, async () => {
      const { input, expected } = bmp({ bits, topDown }),
        before = Buffer.from(input),
        png = await bitmap(input, 20);
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.channels, 3);
      assert.equal(info.width, 3);
      assert.equal(info.height, 2);
      assert.deepEqual(data, expected);
      assert.deepEqual(input, before);
    });
test('processPhoto public result preserves decoded BMP while sanitizing its header', async () => {
  const { input } = bmp({ bits: 32 });
  const output = await processPhoto(input, 'synthetic.bmp');
  assert.equal(output.original.toString('ascii', 0, 2), 'BM');
  assert.equal(output.original.readUInt32LE(2), output.original.length);
  assert.equal(output.original.readUInt32LE(10), 54);
  const normalized = await bitmap(output.original, 20);
  assert.deepEqual(await sharp(normalized).raw().toBuffer(), bmp({ bits: 32 }).expected);
  assert.deepEqual(input, bmp({ bits: 32 }).input); // Decoder/sanitizer do not mutate source bytes.
  assert.equal(output.mime, 'image/bmp');
  assert.equal(output.width, 3);
  assert.equal(output.height, 2);
  assert.equal(output.frames, 1);
  for (const derived of [output.preview, output.thumbnail]) {
    const metadata = await sharp(derived).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.hasAlpha, false);
  }
});
test('processPhoto still rejects nonzero ClrUsed rather than loosening BMP color safety', async () => {
  const { input } = bmp({ bits: 32 });
  input.writeUInt32LE(1, 46);
  await assert.rejects(
    processPhoto(input, 'invalid-colors.bmp'),
    (error) => error.code === 'VALIDATION_ERROR' && /BMP颜色配置/.test(error.message)
  );
  assert.equal(globalThis.artzooBitmapWorkers, 0);
});
test('original BMP validation messages preserved for corrupt/unsupported input', async () => {
  const cases = [
    [(input) => input.subarray(0, 30), '暂不支持此 BMP 编码，请使用未压缩24或32位BMP'],
    [
      (input) => {
        input.writeUInt32LE(1, 30);
        return input;
      },
      '暂不支持此 BMP 编码，请使用未压缩24或32位BMP'
    ],
    [
      (input) => {
        input.writeInt32LE(0, 18);
        return input;
      },
      'BMP尺寸或编码无效'
    ],
    [
      (input) => {
        input.writeUInt16LE(16, 28);
        return input;
      },
      'BMP尺寸或编码无效'
    ],
    [
      (input) => {
        input.writeUInt32LE(53, 10);
        return input;
      },
      'BMP尺寸或编码无效'
    ],
    [
      (input) => {
        input.writeInt32LE(40000001, 18);
        return input;
      },
      'BMP尺寸或编码无效'
    ],
    [(input) => input.subarray(0, input.length - 1), 'BMP文件不完整']
  ];
  for (const [mutate, message] of cases)
    await assert.rejects(
      bitmap(mutate(bmp().input), 20),
      (error) => error.code === 'VALIDATION_ERROR' && error.status === 400 && error.message === message
    );
  assert.equal(globalThis.artzooBitmapWorkers, 0);
});
test('two real workers cap concurrent decode; after completion capacity recovers', async () => {
  const first = bitmap(bmp().input, 20),
    second = bitmap(bmp().input, 20);
  await assert.rejects(
    bitmap(bmp().input, 20),
    (error) => error.code === 'SERVICE_UNAVAILABLE' && error.status === 503
  );
  await Promise.all([first, second]);
  assert.equal(globalThis.artzooBitmapWorkers, 0);
  await bitmap(bmp().input, 20);
});
test('real decode leaves main event loop responsive and worker loop absent from parent', async () => {
  const input = bmp({ width: 1600, height: 1600 }).input;
  let ticks = 0;
  const timer = setInterval(() => ticks++, 2);
  try {
    await bitmap(input, 20);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks >= 2, `heartbeat ticks: ${ticks}`);
});
