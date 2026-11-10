import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { processPhoto } from '../../apps/web/server/media/photo-processor.ts';
import { LocalPhotoStorage } from '../../apps/web/server/media/photo-storage.ts';
import { PHOTO_RULES as ALBUM_RULES } from '../../apps/web/server/media/photo-contract.ts';
import { mentionLabel as mentionText, containsMention } from '../../apps/web/server/daily/contract.ts';
const sharp = createRequire(new URL('../../apps/web/package.json', import.meta.url))('sharp');
const source = sharp({ create: { width: 40, height: 24, channels: 4, background: '#456735' } });

const metadataSecret = 'SYNTHETIC-PRIVATE-CAMERA-GPS-SERIAL';
function gifWithPrivateComment(input) {
  assert.equal(input.at(-1), 0x3b);
  const bytes = Buffer.from(metadataSecret);
  return Buffer.concat([
    input.subarray(0, -1),
    Buffer.from([0x21, 0xfe, bytes.length]),
    bytes,
    Buffer.from([0, 0x3b])
  ]);
}

function onlyOrientation(exif, orientation) {
  if (!exif) {
    assert.ok(orientation === undefined || orientation === 1);
    return;
  }
  const tiff = exif.subarray(exif.subarray(0, 6).equals(Buffer.from('Exif\0\0')) ? 6 : 0);
  assert.equal(tiff.length, 26, 'Exif has no unreferenced private payload');
  const le = tiff.toString('latin1', 0, 2) === 'II';
  assert.ok(le || tiff.toString('latin1', 0, 2) === 'MM');
  const u16 = (at) => (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at) => (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  assert.equal(u16(2), 42);
  assert.equal(u32(4), 8);
  assert.equal(u16(8), 1);
  assert.equal(u16(10), 0x112);
  assert.equal(u16(12), 3);
  assert.equal(u32(14), 1);
  assert.equal(u16(18), orientation);
  assert.equal(u16(20), 0);
  assert.equal(u32(22), 0);
}
async function equalDecoded(a, b, orient = false, animated = false) {
  const decode = async (input) => {
    let image = sharp(input, { animated });
    if (orient) image = image.autoOrient();
    return image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  };
  const before = await decode(a),
    after = await decode(b);
  assert.equal(after.info.width, before.info.width);
  assert.equal(after.info.height, before.info.height);
  assert.equal(after.info.channels, before.info.channels);
  assert.deepEqual(after.data, before.data);
}
async function sanitizedOriginal(input, output, format, animated = false) {
  const mime = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    tiff: 'image/tiff',
    avif: 'image/avif'
  };
  const before = await sharp(input, { animated }).metadata(),
    after = await sharp(output.original, { animated }).metadata();
  assert.equal(after.format, before.format);
  assert.equal(output.mime, mime[format]);
  assert.deepEqual(after.icc, before.icc);
  assert.equal(after.xmp, undefined);
  assert.equal(after.iptc, undefined);
  assert.ok(!output.original.includes(Buffer.from(metadataSecret)));
  if (format === 'tiff' || format === 'avif') {
    assert.equal(after.exif, undefined);
    await equalDecoded(input, output.original, true);
  } else {
    onlyOrientation(after.exif, before.orientation);
    await equalDecoded(input, output.original, false, animated);
    await equalDecoded(input, output.original, true, animated);
  }
  assert.equal(after.pages ?? 1, before.pages ?? 1);
  assert.deepEqual(after.delay, before.delay);
  assert.equal(after.loop, before.loop);
}
function bitmapRgb(input) {
  const width = input.readInt32LE(18),
    signedHeight = input.readInt32LE(22),
    height = Math.abs(signedHeight),
    bits = input.readUInt16LE(28),
    offset = input.readUInt32LE(10),
    stride = Math.ceil((width * bits) / 32) * 4,
    pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = offset + (signedHeight > 0 ? height - 1 - y : y) * stride + (x * bits) / 8;
      pixels.set([input[p + 2], input[p + 1], input[p]], (y * width + x) * 3);
    }
  return pixels;
}
function mpoFrames(input) {
  let at = 2,
    base;
  while (at + 4 <= input.length && input[at] === 255) {
    const marker = input[at + 1],
      size = input.readUInt16BE(at + 2);
    if (marker === 0xda) break;
    if (marker === 0xe2 && input.toString('latin1', at + 4, at + 8) === 'MPF\0') {
      base = at + 8;
      break;
    }
    at += 2 + size;
  }
  assert.notEqual(base, undefined);
  const le = input.toString('latin1', base, base + 2) === 'II';
  const u16 = (at) => (le ? input.readUInt16LE(at) : input.readUInt16BE(at)),
    u32 = (at) => (le ? input.readUInt32LE(at) : input.readUInt32BE(at));
  const ifd = base + u32(base + 4),
    n = u16(ifd);
  let count, entries, bytes;
  for (let i = 0; i < n; i++) {
    const at = ifd + 2 + i * 12,
      tag = u16(at);
    if (tag === 0xb001) count = u32(at + 8);
    if (tag === 0xb002) {
      bytes = u32(at + 4);
      entries = base + u32(at + 8);
    }
  }
  assert.equal(count, 2);
  assert.equal(bytes, count * 16);
  assert.ok(entries + bytes <= input.length);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const at = entries + i * 16,
      size = u32(at + 4),
      start = i === 0 ? 0 : base + u32(at + 8);
    assert.ok(start + size <= input.length);
    const frame = input.subarray(start, start + size);
    assert.equal(frame.readUInt16BE(0), 0xffd8);
    assert.equal(frame.readUInt16BE(frame.length - 2), 0xffd9);
    frames.push(frame);
  }
  return frames;
}

for (const format of ['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif'])
  test(`accept ${format}, preserve decoded original fidelity while cleaning metadata`, async () => {
    const encoded = await source
        .clone()
        .withMetadata()
        .withExifMerge({ IFD0: { Make: metadataSecret, Model: metadataSecret } })
        .toFormat(format)
        .toBuffer(),
      input = format === 'gif' ? gifWithPrivateComment(encoded) : encoded,
      out = await processPhoto(input, 'synthetic.' + format);
    await sanitizedOriginal(input, out, format);
    assert.equal(out.width, 40);
    assert.equal(out.height, 24);
    assert.equal((await sharp(out.preview).metadata()).format, 'webp');
    assert.equal(out.frames, 1);
  });
test('BMP 24-bit BGR decoding preserves pixels while sanitizing the original container', async () => {
  const b = Buffer.alloc(54 + 16);
  b.write('BM');
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(2, 18);
  b.writeInt32LE(2, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.set([255, 0, 0, 255, 0, 0], 54);
  b.set([0, 0, 255, 0, 0, 255], 62);
  const out = await processPhoto(b, 'fixture.bmp');
  assert.deepEqual(bitmapRgb(out.original), bitmapRgb(b));
  assert.equal(out.mime, 'image/bmp');
  assert.equal(out.original.readUInt32LE(2), out.original.length);
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  const pixel = await sharp(out.preview).raw().toBuffer();
  assert.ok(pixel[0] > pixel[2]);
});

test('BMP 32-bit top-down and bottom-up pixels keep the existing alpha-ignore semantics after cleaning', async () => {
  for (const topDown of [false, true]) {
    const width = 3,
      height = 2,
      stride = width * 4,
      input = Buffer.alloc(54 + stride * height + metadataSecret.length);
    input.write('BM');
    input.writeUInt32LE(input.length, 2);
    input.write('GPS!', 6);
    input.writeUInt32LE(54, 10);
    input.writeUInt32LE(40, 14);
    input.writeInt32LE(width, 18);
    input.writeInt32LE(topDown ? -height : height, 22);
    input.writeUInt16LE(1, 26);
    input.writeUInt16LE(32, 28);
    input.writeUInt32LE(12345, 38);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const at = 54 + (topDown ? y : height - 1 - y) * stride + x * 4;
        input.set(y === 0 ? [0, 0, 255, 0] : [255, 0, 0, 255], at);
      }
    input.write(metadataSecret, 54 + stride * height);
    const output = await processPhoto(input, 'synthetic-alpha.bmp');
    assert.equal(output.mime, 'image/bmp');
    assert.equal(output.width, width);
    assert.equal(output.height, height);
    assert.equal(output.frames, 1);
    assert.deepEqual(bitmapRgb(output.original), bitmapRgb(input));
    assert.equal(output.original.length, 54 + stride * height);
    assert.equal(output.original.readUInt32LE(6), 0);
    assert.equal(output.original.readUInt32LE(38), 0);
    assert.ok(!output.original.includes(Buffer.from(metadataSecret)));
    for (const derived of [output.preview, output.thumbnail]) {
      const meta = await sharp(derived).metadata();
      assert.equal(meta.hasAlpha, false);
      const pixels = await sharp(derived).raw().toBuffer();
      assert.ok(pixels[0] > pixels[2]);
    }
  }
});

for (const format of ['gif', 'webp'])
  test(`animated ${format} retains every frame, delay and loop`, async () => {
    const pixels = Buffer.alloc(20 * 10 * 4 * 2);
    pixels.fill(80, 0, 20 * 10 * 4);
    pixels.fill(220, 20 * 10 * 4);
    const encoded = await sharp(pixels, { raw: { width: 20, height: 20, channels: 4, pageHeight: 10 } })
      .toFormat(format, { loop: 3, delay: [100, 200] })
      .toBuffer();
    const input = format === 'gif' ? gifWithPrivateComment(encoded) : encoded;
    const out = await processPhoto(input, 'animation.' + format);
    await sanitizedOriginal(input, out, format, true);
    assert.equal(out.frames, 2);
    for (const b of [out.preview, out.thumbnail]) {
      const meta = await sharp(b, { animated: true }).metadata();
      assert.equal(meta.pages, 2);
      assert.deepEqual(meta.delay, [100, 200]);
      assert.equal(meta.loop, 3);
    }
  });
test('orientation applied to derivatives while cleaned original retains only orientation EXIF', async () => {
  const input = await source.clone().jpeg().withMetadata({ orientation: 6 }).toBuffer(),
    out = await processPhoto(input, 'orientation.jpg');
  assert.equal(out.width, 24);
  assert.equal(out.height, 40);
  assert.equal((await sharp(out.preview).metadata()).orientation, undefined);
  await sanitizedOriginal(input, out, 'jpeg');
  assert.equal((await sharp(out.original).metadata()).orientation, 6);
});
test('multi-page TIFF rejected', async () => {
  const b = await sharp(Buffer.alloc(10 * 10 * 3 * 2, 100), {
    raw: { width: 10, height: 20, channels: 3, pageHeight: 10 }
  })
    .tiff()
    .toBuffer();
  assert.equal((await sharp(b, { pages: -1 }).metadata()).pages, 2);
  await assert.rejects(processPhoto(b, 'multi.tiff'), /多页/);
});
test('APNG rejected before a decoder can silently flatten', async () => {
  const b = await source.clone().png().toBuffer(),
    chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8, 0);
  chunk.write('acTL', 4);
  const apng = Buffer.concat([b.subarray(0, 33), chunk, b.subarray(33)]);
  await assert.rejects(processPhoto(apng, 'motion.png'), /动态PNG/);
});
test('HEIC/SVG/video/AVIF sequence and oversize rejected', async () => {
  for (const n of ['image.heic', 'image.heif', 'image.svg', 'video.mp4'])
    await assert.rejects(processPhoto(Buffer.from('<svg/>'), n));
  const b = Buffer.alloc(24);
  b.writeUInt32BE(24);
  b.write('ftypavif', 4);
  b.write('avis', 16);
  await assert.rejects(processPhoto(b, 'motion.avif'), /静态AVIF/);
  await assert.rejects(processPhoto(Buffer.alloc(ALBUM_RULES.maxBytes + 1), 'huge.png'), /30MiB/);
});
test('pixel resource bound rejected', async () => {
  const b = await sharp({ create: { width: 10000, height: 5000, channels: 3, background: 'black' } })
    .png()
    .toBuffer();
  await assert.rejects(processPhoto(b, 'large.png'), /尺寸/);
});
test('MPO rejects renamed JPEG without verified camera primary index', async () => {
  const b = await source.clone().jpeg().toBuffer();
  await assert.rejects(processPhoto(b, 'fake.mpo'), /主图索引/);
});
test('indexed MPO keeps every frame and valid rebuilt index while cleaning metadata', async () => {
  const jpeg = await source.clone().jpeg().toBuffer(),
    tiff = Buffer.alloc(8 + 2 + 12 * 2 + 4 + 32);
  tiff.write('II');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0xb001, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(2, 18);
  tiff.writeUInt16LE(0xb002, 22);
  tiff.writeUInt16LE(7, 24);
  tiff.writeUInt32LE(32, 26);
  tiff.writeUInt32LE(38, 30);
  const app = Buffer.alloc(8 + tiff.length);
  app.writeUInt16BE(0xffe2);
  app.writeUInt16BE(app.length - 2, 2);
  app.write('MPF\0', 4);
  const primarySize = jpeg.length + app.length;
  tiff.writeUInt32LE(0x20030000, 38);
  tiff.writeUInt32LE(primarySize, 42);
  tiff.writeUInt32LE(0, 46);
  tiff.writeUInt32LE(jpeg.length, 58);
  tiff.writeUInt32LE(primarySize - 10, 62);
  tiff.copy(app, 8);
  const b = Buffer.concat([jpeg.subarray(0, 2), app, jpeg.subarray(2), jpeg]),
    out = await processPhoto(b, 'camera.mpo');
  assert.equal(out.width, 40);
  assert.equal(out.mime, 'image/mpo');
  assert.equal(out.frames, 1);
  const beforeFrames = mpoFrames(b),
    afterFrames = mpoFrames(out.original);
  assert.equal(afterFrames.length, beforeFrames.length);
  for (let index = 0; index < beforeFrames.length; index++) {
    await equalDecoded(beforeFrames[index], afterFrames[index]);
    await equalDecoded(beforeFrames[index], afterFrames[index], true);
    const beforeMeta = await sharp(beforeFrames[index]).metadata(),
      afterMeta = await sharp(afterFrames[index]).metadata();
    assert.deepEqual(afterMeta.icc, beforeMeta.icc);
    onlyOrientation(afterMeta.exif, beforeMeta.orientation);
    assert.equal(afterMeta.xmp, undefined);
    assert.equal(afterMeta.iptc, undefined);
  }
  const invalid = Buffer.from(b);
  invalid.writeUInt32LE(999999, 10 + 62);
  await assert.rejects(processPhoto(invalid, 'bad.mpo'), /索引/);
});
test('storage survives fresh adapter, refuses overwrite/traversal and symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'artzoo-album-owned-')),
    original = join(directory, 'original'),
    derived = join(directory, 'derived'),
    store = new LocalPhotoStorage(original, derived),
    id = randomUUID(),
    output = await processPhoto(await source.clone().png().toBuffer(), 'fixture.png');
  await store.put(id, output);
  assert.deepEqual(await new LocalPhotoStorage(original, derived).read(id, 'original'), output.original);
  await assert.rejects(store.put(id, output));
  assert.deepEqual(await store.read(id, 'original'), output.original);
  await assert.rejects(store.read('../../passwd', 'original'));
  const linkId = randomUUID();
  await symlink(join(original, id + '.original'), join(original, linkId + '.original'));
  await assert.rejects(store.read(linkId, 'original'));
  assert.ok((await readFile(join(original, id + '.original'))).length);
});

test('measure original / 2048 preview / 480 thumbnail on synthetic 12MP image', async () => {
  const width = 4096,
    height = 2730,
    raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = (x + y) % 256;
      raw[i + 1] = (x * 3 + y) % 256;
      raw[i + 2] = (x + y * 2) % 256;
    }
  const input = await sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer(),
    start = performance.now(),
    out = await processPhoto(input, 'synthetic-12mp.jpg'),
    ms = performance.now() - start;
  const preview = await sharp(out.preview).metadata(),
    thumbnail = await sharp(out.thumbnail).metadata();
  assert.equal(preview.width, 2048);
  assert.equal(thumbnail.width, 480);
  await sanitizedOriginal(input, out, 'jpeg');
  console.log(
    JSON.stringify({
      benchmark: 'synthetic-12MP',
      original: input.length,
      preview: out.preview.length,
      thumbnail: out.thumbnail.length,
      decodeAndDeriveMs: Math.round(ms)
    })
  );
});

test('mention identities distinguish duplicate names and do not match name prefixes', () => {
  const a = mentionText({ id: 'a', displayName: '同名', gameServer: '甲区' }, true),
    b = mentionText({ id: 'b', displayName: '同名', gameServer: '乙区' }, true);
  assert.notEqual(a, b);
  assert.ok(containsMention('@' + b + ' ', b));
  assert.equal(containsMention('@' + b + ' ', a), false);
  assert.equal(containsMention('@云朵咕 ', '云'), false);
});
