import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sanitizeOriginal } from '../../packages/media/src/photo-original.ts';
import { sanitizeMpo } from '../../packages/media/src/photo-original-mpo.ts';
const require = createRequire(new URL('../../packages/media/package.json', import.meta.url)),
  sharp = require('sharp');
async function jpeg(orientation) {
  return sharp({ create: { width: 3, height: 2, channels: 3, background: { r: 30, g: 70, b: 110 } } })
    .withIccProfile('srgb')
    .withExif({
      IFD0: { Orientation: String(orientation), ImageDescription: 'synthetic-private-' + orientation },
      IFD2: { UserComment: 'synthetic-comment' }
    })
    .withMetadata({ orientation })
    .jpeg()
    .toBuffer();
}
function mpo(frames, little = false, version = true) {
  const count = version ? 3 : 2,
    table = 14 + count * 12,
    t = Buffer.alloc(table + frames.length * 16);
  t.write(little ? 'II' : 'MM');
  const w16 = (v, p) => (little ? t.writeUInt16LE(v, p) : t.writeUInt16BE(v, p)),
    w32 = (v, p) => (little ? t.writeUInt32LE(v, p) : t.writeUInt32BE(v, p));
  w16(42, 2);
  w32(8, 4);
  w16(count, 8);
  const tags = [
    ...(version ? [[0xb000, 7, 4, 0x30313030]] : []),
    [0xb001, 4, 1, frames.length],
    [0xb002, 7, frames.length * 16, table]
  ];
  tags.forEach(([id, type, n, value], i) => {
    const p = 10 + i * 12;
    w16(id, p);
    w16(type, p + 2);
    w32(n, p + 4);
    w32(value, p + 8);
  });
  if (version) t.write('0100', 18);
  const app = Buffer.alloc(8 + t.length);
  app.writeUInt16BE(0xffe2);
  app.writeUInt16BE(app.length - 2, 2);
  app.write('MPF\0', 4);
  let cursor = 0;
  for (let i = 0; i < frames.length; i++) {
    const p = table + i * 16;
    w32(i === 0 ? 0x20030000 : 0, p);
    w32(frames[i].length + (i ? 0 : app.length), p + 4);
    w32(i ? cursor - 10 : 0, p + 8);
    cursor += frames[i].length + (i ? 0 : app.length);
  }
  t.copy(app, 8);
  return Buffer.concat([frames[0].subarray(0, 2), app, frames[0].subarray(2), ...frames.slice(1)]);
}
function split(output) {
  assert.equal(output.toString('ascii', 10, 12), 'MM');
  const n = output.readUInt32BE(40),
    frames = [];
  for (let i = 0; i < n; i++) {
    const p = 60 + i * 16,
      length = output.readUInt32BE(p + 4),
      start = i ? 10 + output.readUInt32BE(p + 8) : 0;
    frames.push(output.subarray(start, start + length));
    if (i)
      assert.equal(
        start,
        frames.slice(0, i).reduce((n, b) => n + b.length, 0)
      );
  }
  assert.equal(
    frames.reduce((n, b) => n + b.length, 0),
    output.length
  );
  return frames;
}
for (const little of [false, true])
  for (const version of [false, true])
    test(`MPO ${little ? 'LE' : 'BE'} version=${version} retains every frame, each direction/ICC, rewrites offsets and removes secondary EXIF`, async () => {
      const originals = await Promise.all([jpeg(6), jpeg(3), jpeg(8)]),
        input = mpo(originals, little, version),
        output = await sanitizeMpo(input, 6),
        frames = split(output);
      assert.equal(frames.length, 3);
      for (let i = 0; i < 3; i++) {
        const meta = await sharp(frames[i]).metadata(),
          before = await sharp(originals[i]).metadata();
        assert.equal(meta.orientation, before.orientation);
        assert.deepEqual(meta.icc, before.icc);
        assert.ok(!meta.exif.includes(Buffer.from('synthetic-private')));
        assert.equal(meta.exif.length, 32);
        assert.deepEqual(await sharp(frames[i]).raw().toBuffer(), await sharp(originals[i]).raw().toBuffer());
      }
    });
test('wrapper detects MPF inside image/jpeg even if source is primary only', async () => {
  const frames = await Promise.all([jpeg(1), jpeg(6)]),
    input = mpo(frames),
    out = await sanitizeOriginal(
      input,
      { input: frames[0], format: 'jpeg', mime: 'image/jpeg', animated: false },
      { orientation: 1, timeoutSeconds: 20 }
    );
  assert.equal(split(out).length, 2);
});
test('MPO corrupt offsets and overlap fail without returning raw private bytes', async () => {
  const input = mpo(await Promise.all([jpeg(1), jpeg(6)]));
  for (const patch of [
    (b) => b.writeUInt32BE(0xffffff00, 84),
    (b) => b.writeUInt32BE(0, 84),
    (b) => b.writeUInt32BE(100, 36)
  ]) {
    const b = Buffer.from(input);
    patch(b);
    await assert.rejects(() => sanitizeMpo(b));
  }
  await assert.rejects(() => sanitizeMpo(input.subarray(0, -1)));
});
test('wrapper validates size, deadline, unsupported format and BMP raw container branch', async () => {
  const source = {
    input: Buffer.from('decoded-not-original'),
    format: 'png',
    mime: 'image/bmp',
    animated: false
  };
  await assert.rejects(
    sanitizeOriginal(Buffer.alloc(30 * 1024 * 1024 + 1), source, { timeoutSeconds: 20 }),
    (e) => e.code === 'VALIDATION_ERROR'
  );
  await assert.rejects(
    sanitizeOriginal(Buffer.from('x'), source, { timeoutSeconds: 0 }),
    (e) => e.code === 'VALIDATION_ERROR'
  );
  await assert.rejects(
    sanitizeOriginal(
      Buffer.from('x'),
      { ...source, mime: 'unknown', format: 'unknown' },
      { timeoutSeconds: 20 }
    ),
    (e) => e.code === 'VALIDATION_ERROR'
  );
  await assert.rejects(
    sanitizeOriginal(Buffer.from('decoded PNG'), source, { timeoutSeconds: 20 }),
    (e) => e.code === 'VALIDATION_ERROR'
  );
});

test('MPO refuses unknown optional IFD/tags and invalid dependencies', async () => {
  const input = mpo(await Promise.all([jpeg(6), jpeg(3)]));
  for (const patch of [
    (b) => b.writeUInt32BE(8, 56),
    (b) => b.writeUInt32BE(0x07000000, 76),
    (b) => b.writeUInt16BE(3, 88),
    (b) => b.writeUInt16BE(0xb003, 20)
  ]) {
    const b = Buffer.from(input);
    patch(b);
    await assert.rejects(
      () => sanitizeMpo(b),
      (e) => e.code === 'VALIDATION_ERROR'
    );
  }
});

test('MPO preserves bounded structural picture type, representative flags and valid dependency IDs', async () => {
  const input = mpo(await Promise.all([jpeg(6), jpeg(3)]));
  input.writeUInt32BE(0x020002, 76);
  input.writeUInt16BE(1, 88);
  const out = await sanitizeMpo(input, 6);
  assert.equal(out.readUInt32BE(60), 0x20030000);
  assert.equal(out.readUInt32BE(76), 0x020002);
  assert.equal(out.readUInt16BE(88), 1);
  assert.equal(split(out).length, 2);
});

test('MPO full decode rejects corrupt secondary DQT despite valid index and JPEG framing', async () => {
  const primary = await jpeg(6),
    original = await jpeg(3);
  let p = 2,
    from = 0;
  const chunks = [];
  while (p < original.length) {
    if (original[p] !== 255) break;
    const marker = original[p + 1];
    if (marker === 0xda) break;
    const end = p + 2 + original.readUInt16BE(p + 2);
    if (marker === 0xdb) {
      chunks.push(original.subarray(from, p));
      from = end;
    }
    p = end;
  }
  chunks.push(original.subarray(from));
  const broken = Buffer.concat(chunks);
  assert.ok(broken.length < original.length);
  await assert.rejects(sharp(broken, { failOn: 'warning' }).stats());
  const input = mpo([primary, broken], true, false);
  await assert.rejects(
    sanitizeMpo(input, 6),
    (e) => e.code === 'VALIDATION_ERROR' && e.message.includes('解码')
  );
});
test('MPO total validation deadline rejects before returning any original', async () => {
  const input = mpo(await Promise.all([jpeg(6), jpeg(3)]));
  await assert.rejects(
    sanitizeMpo(input, 6, 0),
    (e) => e.code === 'VALIDATION_ERROR' && e.message.includes('超时')
  );
});
