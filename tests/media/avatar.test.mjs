import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm, readdir, symlink, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { processAvatar, avatarCrop, withAvatarUploadSlot } from '../../apps/web/server/media/processor.ts';
import { LocalAvatarStorage } from '../../apps/web/server/media/storage.ts';
const crop = { x: 0, y: 0, size: 1 };
const image = (format = 'png', width = 640, height = 480) =>
  sharp({ create: { width, height, channels: 4, background: { r: 200, g: 30, b: 80, alpha: 0.4 } } })
    [format]()
    .toBuffer();
const invalid = (action) => assert.rejects(action, (e) => e.code === 'VALIDATION_ERROR');
for (const format of ['jpeg', 'png', 'webp'])
  test('static ' + format + ' becomes bounded WebP variants without enlargement', async () => {
    const out = await processAvatar(await image(format), crop);
    for (const [key, size] of [
      ['full', 480],
      ['small', 128]
    ]) {
      const m = await sharp(out[key]).metadata();
      assert.equal(m.format, 'webp');
      assert.equal(m.width, size);
      assert.equal(m.height, size);
      assert.equal(m.exif, undefined);
      assert.equal(m.icc, undefined);
    }
    assert.equal(out.width, 480);
  });
test('large input crop outputs 512 and 128 square', async () => {
  const o = await processAvatar(await image('png', 800, 600), crop);
  assert.equal(o.width, 512);
  assert.equal((await sharp(o.small).metadata()).width, 128);
});
for (const format of ['png', 'webp'])
  test('transparent ' + format + ' retains alpha', async () => {
    const o = await processAvatar(await image(format, 32, 32), crop);
    const { data, info } = await sharp(o.full).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4);
    assert.ok(data[3] > 95 && data[3] < 110);
  });
test('EXIF orientation is applied before coordinate crop; metadata stripped', async () => {
  const width = 80,
    height = 40,
    raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = x < 40 ? 255 : 0;
      raw[i + 2] = x < 40 ? 0 : 255;
    }
  const jpg = await sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const o = await processAvatar(jpg, { x: 0, y: 0.5, size: 1 });
  const m = await sharp(o.full).metadata();
  assert.equal(m.exif, undefined);
  assert.equal(m.orientation, undefined);
  const stats = await sharp(o.full).stats();
  assert.ok(stats.channels[2].mean > 200);
  assert.ok(stats.channels[0].mean < 30);
});
test('crop x uses width, y uses height and size uses minimum side', async () => {
  const o = await processAvatar(await image('png', 200, 100), { x: 0.5, y: 0, size: 0.5 });
  assert.equal(o.width, 50);
  await invalid(() => processAvatar(imageBuffer, { x: 1, y: 0, size: 1 }));
});
const imageBuffer = await image('png', 200, 100);
for (const value of [
  null,
  {},
  [],
  { x: 0, y: 0, size: 0 },
  { x: -1, y: 0, size: 1 },
  { x: 0, y: Infinity, size: 1 },
  { x: 0, y: 0, size: 1, extra: 1 }
])
  test('invalid crop ' + JSON.stringify(value), () =>
    assert.throws(
      () => avatarCrop(value),
      (e) => e.code === 'VALIDATION_ERROR'
    )
  );
test('empty, corrupt, wrong format and oversized rejected', async () => {
  for (const b of [
    Buffer.alloc(0),
    Buffer.from([255, 216, 255, 0]),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    Buffer.alloc(10_000_001),
    await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
      .tiff()
      .toBuffer()
  ])
    await invalid(() => processAvatar(b, crop));
});
test('PNG animation chunks rejected even before decoding', async () => {
  const png = await image('png', 8, 8),
    chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8);
  chunk.write('acTL', 4);
  chunk.writeUInt32BE(2, 8);
  await invalid(() => processAvatar(Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]), crop));
});
test('animated WebP with two actual frames rejected', async () => {
  const raw = Buffer.alloc(8 * 16 * 4, 140);
  raw.fill(255, 8 * 8 * 4);
  const webp = await sharp(raw, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } })
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
  assert.equal((await sharp(webp, { animated: true }).metadata()).pages, 2);
  await invalid(() => processAvatar(webp, crop));
});
test('PNG decoded pixel and dimension caps reject compression bombs', async () => {
  for (const [w, h] of [
    [8193, 1],
    [5000, 5000]
  ])
    await invalid(() => image('png', w, h).then((b) => processAvatar(b, crop)));
});
test('upload concurrency admits two and releases slot on errors', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const a = withAvatarUploadSlot(() => gate),
    b = withAvatarUploadSlot(() => gate);
  await assert.rejects(
    () => withAvatarUploadSlot(async () => {}),
    (e) => e.code === 'SERVICE_UNAVAILABLE'
  );
  release();
  await Promise.all([a, b]);
  await assert.rejects(() =>
    withAvatarUploadSlot(async () => {
      throw Error('test');
    })
  );
  await withAvatarUploadSlot(async () => {});
});
const output = {
  full: Buffer.from('derived-full'),
  small: Buffer.from('derived-small'),
  width: 10,
  height: 10
};
test('local storage persists across adapter reconstruction with only two derived files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artzoo-avatar-test-')),
    id = randomUUID();
  try {
    await new LocalAvatarStorage(dir).put(id, output);
    assert.deepEqual((await readdir(dir)).sort(), [id + '.full.webp', id + '.small.webp']);
    assert.deepEqual(await new LocalAvatarStorage(dir).read(id, 'full'), output.full);
    await new LocalAvatarStorage(dir).delete(id);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('storage refuses traversal, invalid variants and symlink objects/directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artzoo-avatar-test-')),
    id = randomUUID();
  try {
    const store = new LocalAvatarStorage(dir);
    await assert.rejects(() => store.put('../escape', output));
    await assert.rejects(() => store.read(id, '../../escape'));
    const target = join(dir, 'target');
    await writeFile(target, 'unchanged');
    await symlink(target, join(dir, id + '.full.webp'));
    await assert.rejects(() => store.read(id, 'full'));
    await assert.rejects(() => store.delete(id));
    await symlink(dir, join(dir, 'alias'));
    await assert.rejects(() => new LocalAvatarStorage(join(dir, 'alias')).put(randomUUID(), output));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('collision on second variant cleans partial publication and temporary files without overwriting existing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artzoo-avatar-test-')),
    id = randomUUID();
  try {
    await writeFile(join(dir, id + '.small.webp'), 'original');
    const store = new LocalAvatarStorage(dir);
    await assert.rejects(() => store.put(id, output));
    assert.deepEqual(await readdir(dir), [id + '.small.webp']);
    assert.equal((await store.read(id, 'small')).toString(), 'original');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('hard linked storage object is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artzoo-avatar-test-')),
    id = randomUUID();
  try {
    await writeFile(join(dir, 'source'), 'data');
    await link(join(dir, 'source'), join(dir, id + '.full.webp'));
    await assert.rejects(() => new LocalAvatarStorage(dir).read(id, 'full'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real avatar processor uses the selected offset region for both full and small derivatives', async () => {
  // Non-square source has four distinct quadrants. Select an interior lower-right
  // square so resizing the original, ignoring offsets, or using width for y all fail.
  const width = 1000,
    height = 800,
    raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3,
        color =
          y < 400 ? (x < 500 ? [230, 20, 20] : [20, 230, 20]) : x < 500 ? [230, 230, 20] : [20, 20, 230];
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
    }
  const source = await sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  const output = await processAvatar(source, { x: 0.55, y: 0.55, size: 0.4 });
  assert.equal(output.width, 320);
  assert.equal(output.height, 320);
  for (const [variant, size] of [
    ['full', 320],
    ['small', 128]
  ]) {
    assert.notDeepEqual(output[variant], source);
    const metadata = await sharp(output[variant]).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
    const stats = await sharp(output[variant]).stats();
    assert.ok(stats.channels[2].mean > 210);
    assert.ok(stats.channels[0].mean < 35);
    assert.ok(stats.channels[1].mean < 35);
  }
});
