import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sanitizeGif } from '../../packages/media/src/photo-original-gif.ts';
import { sanitizeBmp } from '../../packages/media/src/photo-original-bmp.ts';
import { reencodeOriginal } from '../../packages/media/src/photo-original-reencode.ts';
const require = createRequire(new URL('../../packages/media/package.json', import.meta.url)),
  sharp = require('sharp');
const raw = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255]);
const image = () => sharp(raw, { raw: { width: 2, height: 3, channels: 3 } });
const pixels = async (b) => sharp(b).autoOrient().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
function bmp(bits = 24, top = false) {
  const stride = Math.ceil((3 * bits) / 32) * 4,
    buf = Buffer.alloc(54 + stride * 2 + 12, 0x77);
  buf.fill(0, 0, 54);
  buf.write('BM');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(3, 18);
  buf.writeInt32LE(top ? -2 : 2, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(bits, 28);
  buf.writeUInt32LE(stride * 2, 34);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 3; x++) {
      const p = 54 + y * stride + (x * bits) / 8;
      buf[p] = x;
      buf[p + 1] = y;
      buf[p + 2] = 7;
      if (bits === 32) buf[p + 3] = x * 50;
    }
  return buf;
}
for (const bits of [24, 32])
  for (const top of [false, true])
    test(`BMP ${bits} orientation ${top} container and pixels preserved, padding/tail removed`, () => {
      const input = bmp(bits, top),
        out = sanitizeBmp(input),
        stride = Math.ceil((3 * bits) / 32) * 4;
      assert.equal(out.toString('ascii', 0, 2), 'BM');
      assert.equal(out.length, 54 + stride * 2);
      assert.equal(out.readInt32LE(22), input.readInt32LE(22));
      for (let y = 0; y < 2; y++) {
        assert.deepEqual(
          out.subarray(54 + y * stride, 54 + y * stride + (3 * bits) / 8),
          input.subarray(54 + y * stride, 54 + y * stride + (3 * bits) / 8)
        );
        assert.ok(
          out.subarray(54 + y * stride + (3 * bits) / 8, 54 + (y + 1) * stride).every((b) => b === 0)
        );
      }
    });
test('BMP rejects V5/profile and corrupt/unsupported variants', () => {
  for (const mutate of [
    (b) => b.writeUInt32LE(124, 14),
    (b) => b.writeUInt32LE(1, 30),
    (b) => b.writeUInt16LE(16, 28),
    (b) => b.writeUInt32LE(5000, 10)
  ]) {
    const b = bmp();
    mutate(b);
    assert.throws(
      () => sanitizeBmp(b),
      (e) => e.code === 'VALIDATION_ERROR'
    );
  }
});
const gifFrame = Buffer.from('21f90404050000002c0000000001000100000202440100', 'hex');
const app = (name, body) =>
  Buffer.concat([
    Buffer.from([0x21, 0xff, 11]),
    Buffer.from(name),
    Buffer.from([body.length]),
    body,
    Buffer.from([0])
  ]);
test('GIF strips comments/XMP/private app retaining loop/ICC and all animation bytes', async () => {
  const header = Buffer.from('47494638396101000100800000000000ffffff', 'hex'),
    loop = app('NETSCAPE2.0', Buffer.from([1, 0, 0])),
    icc = app('ICCRGBG1012', Buffer.from([1, 1, 0])),
    comment = Buffer.from([0x21, 0xfe, 3, 65, 66, 67, 0]),
    xmp = app('XMP DataXMP', Buffer.from('synthetic-private')),
    privateApp = app('PRIVATE0001', Buffer.from('secret'));
  const input = Buffer.concat([
      header,
      loop,
      icc,
      comment,
      xmp,
      gifFrame,
      privateApp,
      gifFrame,
      Buffer.from([0x3b])
    ]),
    expected = Buffer.concat([header, loop, icc, gifFrame, gifFrame, Buffer.from([0x3b])]);
  assert.deepEqual(sanitizeGif(input), expected);
  assert.equal((await sharp(expected, { animated: true }).metadata()).pages, 2);
  assert.throws(() => sanitizeGif(input.subarray(0, -1)));
});
for (const format of ['tiff', 'avif'])
  test(`${format} explicit lossless 8bit encode preserves oriented pixels and removes private metadata`, async () => {
    const source = await image()
      .withExif({ IFD0: { Orientation: '6', ImageDescription: 'synthetic-private' } })
      .withMetadata({ orientation: 6 })
      [format](format === 'tiff' ? { compression: 'lzw' } : { lossless: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
    const originalMeta = await sharp(source).metadata();
    if (format === 'tiff') assert.equal(originalMeta.orientation, 6);
    else {
      assert.equal(originalMeta.width, 3);
      assert.equal(originalMeta.height, 2);
    }
    const out = await reencodeOriginal(source, format, 20),
      a = await pixels(source),
      b = await pixels(out),
      meta = await sharp(out).metadata();
    assert.deepEqual(b.data, a.data);
    assert.equal(b.info.width, a.info.width);
    assert.equal(meta.exif, undefined);
    assert.equal(meta.xmp, undefined);
    assert.equal(meta.format, format === 'avif' ? 'heif' : 'tiff');
  });
for (const format of ['tiff', 'avif'])
  test(`${format} preserves synthetic embedded ICC exactly or rejects unsafe fidelity`, async () => {
    const source = await image()
      .withIccProfile('srgb')
      [format](format === 'tiff' ? { compression: 'lzw' } : { lossless: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
    const out = await reencodeOriginal(source, format, 20);
    assert.deepEqual((await sharp(out).metadata()).icc, (await sharp(source).metadata()).icc);
  });
test('TIFF rejects high-depth and non-RGB precision before unsafe conversion', async () => {
  const gray = await sharp(Buffer.from([5, 9]), { raw: { width: 2, height: 1, channels: 1 } })
    .toColourspace('b-w')
    .tiff({ compression: 'lzw' })
    .toBuffer();
  await assert.rejects(reencodeOriginal(gray, 'tiff', 20), (e) => e.code === 'VALIDATION_ERROR');
  const mono = await image().toColourspace('b-w').tiff({ bitdepth: 1, compression: 'none' }).toBuffer();
  await assert.rejects(reencodeOriginal(mono, 'tiff', 20), (e) => e.code === 'VALIDATION_ERROR');
});
test('reencoder rejects malformed input and expired budget', async () => {
  await assert.rejects(reencodeOriginal(Buffer.from('synthetic'), 'avif', 1));
  const input = await image().tiff().toBuffer();
  await assert.rejects(reencodeOriginal(input, 'tiff', 0), (e) => e.code === 'VALIDATION_ERROR');
});

test('AVIF rejects 10-bit precision rather than silently encode 8-bit', async () => {
  const source = await image().avif({ lossless: true, bitdepth: 10, chromaSubsampling: '4:4:4' }).toBuffer();
  assert.equal((await sharp(source).metadata()).bitsPerSample, 10);
  await assert.rejects(reencodeOriginal(source, 'avif', 20), (e) => e.code === 'VALIDATION_ERROR');
});

test('TIFF rejects actual unsigned 16-bit RGB source without precision loss fallback', async () => {
  const tags = [
      [256, 4, 1, 2],
      [257, 4, 1, 1],
      [258, 3, 3, 134],
      [259, 3, 1, 1],
      [262, 3, 1, 2],
      [273, 4, 1, 140],
      [277, 3, 1, 3],
      [278, 4, 1, 1],
      [279, 4, 1, 12],
      [284, 3, 1, 1]
    ],
    input = Buffer.alloc(152);
  input.write('II');
  input.writeUInt16LE(42, 2);
  input.writeUInt32LE(8, 4);
  input.writeUInt16LE(tags.length, 8);
  for (let i = 0; i < tags.length; i++) {
    const [id, type, count, value] = tags[i],
      p = 10 + i * 12;
    input.writeUInt16LE(id, p);
    input.writeUInt16LE(type, p + 2);
    input.writeUInt32LE(count, p + 4);
    input.writeUInt32LE(value, p + 8);
  }
  for (let i = 0; i < 3; i++) input.writeUInt16LE(16, 134 + i * 2);
  for (let i = 0; i < 6; i++) input.writeUInt16LE(1000 + i, 140 + i * 2);
  assert.equal((await sharp(input).metadata()).depth, 'ushort');
  await assert.rejects(reencodeOriginal(input, 'tiff', 20), (e) => e.code === 'VALIDATION_ERROR');
});

test('GIF refuses 17000 retained short blocks before unbounded Buffer views', () => {
  const header = Buffer.from('47494638396101000100800000000000ffffff', 'hex'),
    gce = Buffer.from('21f9040405000000', 'hex'),
    input = Buffer.concat([header, ...Array(17000).fill(gce), gifFrame, Buffer.from([0x3b])]);
  assert.ok(input.length < 400000);
  assert.throws(
    () => sanitizeGif(input),
    (e) => e.code === 'VALIDATION_ERROR' && e.message.includes('分段')
  );
});
test('GIF large linear subblocks do not consume the retained-object budget', () => {
  const header = Buffer.from('47494638396101000100800000000000ffffff', 'hex'),
    data = Buffer.alloc(256, 7);
  data[0] = 255;
  const input = Buffer.concat([
    header,
    Buffer.from([0x21, 0xfe]),
    ...Array(17000).fill(data),
    Buffer.from([0]),
    gifFrame,
    Buffer.from([0x3b])
  ]);
  assert.deepEqual(sanitizeGif(input), Buffer.concat([header, gifFrame, Buffer.from([0x3b])]));
});
test('TIFF refuses over 4MP verification allocation before raw decode', async () => {
  const source = await sharp({ create: { width: 2001, height: 2000, channels: 3, background: 'red' } })
    .tiff({ compression: 'lzw' })
    .toBuffer();
  await assert.rejects(
    reencodeOriginal(source, 'tiff', 20),
    (e) => e.code === 'VALIDATION_ERROR' && e.message.includes('400万')
  );
});
for (const format of ['tiff', 'avif'])
  test(`${format} wide-gamut native samples and ICC stay equal or explicitly reject`, async () => {
    const source = await image()
      .withIccProfile('p3')
      [format](format === 'tiff' ? { compression: 'lzw' } : { lossless: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
    const native = await sharp(source, { ignoreIcc: true }).autoOrient().ensureAlpha().raw().toBuffer(),
      managed = await sharp(source).autoOrient().ensureAlpha().raw().toBuffer();
    assert.ok(!native.equals(managed), 'fixture must exercise ICC conversion');
    try {
      const out = await reencodeOriginal(source, format, 20);
      assert.deepEqual((await sharp(out).metadata()).icc, (await sharp(source).metadata()).icc);
      assert.deepEqual(
        await sharp(out, { ignoreIcc: true }).autoOrient().ensureAlpha().raw().toBuffer(),
        native
      );
    } catch (e) {
      assert.equal(e.code, 'VALIDATION_ERROR');
    }
  });
