import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { processPhoto } from '../../packages/media/dist/photo-processor.js';
import { SECRET, dirtyJpeg, dirtyPng, dirtyWebp } from './support/metadata-fixtures.mjs';
const sharp = createRequire(new URL('../../apps/web/package.json', import.meta.url))('sharp');
const raw = Buffer.alloc(24 * 12 * 3);
for (let i = 0; i < raw.length; i++) raw[i] = i % 251;
const image = () => sharp(raw, { raw: { width: 24, height: 12, channels: 3 } });
const pixels = (input) =>
  sharp(input, { animated: true }).autoOrient().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
async function equalVisual(before, after) {
  const a = await pixels(before),
    b = await pixels(after);
  assert.equal(b.info.width, a.info.width);
  assert.equal(b.info.height, a.info.height);
  assert.equal(b.info.channels, a.info.channels);
  assert.deepEqual(b.data, a.data);
  return a.info;
}
for (const [format, dirty] of [
  ['jpeg', dirtyJpeg],
  ['png', dirtyPng],
  ['webp', dirtyWebp]
])
  test(
    'complete processPhoto ' +
      format +
      ' strips private metadata while preserving minimal orientation, ICC and pixels',
    async () => {
      const original = await image().withMetadata({ orientation: 6 }).toFormat(format).toBuffer(),
        input = dirty(original, 6),
        out = await processPhoto(input, 'synthetic.' + format);
      assert.equal(input.includes(Buffer.from(SECRET)), true);
      assert.equal(out.original.includes(Buffer.from(SECRET)), false);
      assert.equal(out.mime, 'image/' + (format === 'jpeg' ? 'jpeg' : format));
      const before = await sharp(input).metadata(),
        after = await sharp(out.original).metadata();
      assert.equal(after.orientation, 6);
      assert.ok(after.exif.length <= 40);
      assert.deepEqual(after.icc, before.icc);
      assert.equal(after.xmp, undefined);
      assert.equal(after.iptc, undefined);
      const visual = await equalVisual(input, out.original);
      assert.equal(out.width, visual.width);
      assert.equal(out.height, visual.height);
      assert.equal(out.frames, 1);
      for (const bytes of [out.preview, out.thumbnail]) {
        const m = await sharp(bytes).metadata();
        assert.equal(m.format, 'webp');
        assert.equal(m.orientation, undefined);
        assert.equal(m.exif, undefined);
      }
    }
  );
for (const format of ['tiff', 'avif'])
  test(
    'complete processPhoto ' +
      format +
      ' returns the same container with exact oriented pixels and no private EXIF',
    async () => {
      const input = await image()
          .withMetadata({ orientation: 6 })
          .withExifMerge({ IFD0: { Artist: SECRET } })
          .toFormat(format)
          .toBuffer(),
        out = await processPhoto(input, 'synthetic.' + format);
      assert.equal(out.mime, format === 'avif' ? 'image/avif' : 'image/tiff');
      const metadata = await sharp(out.original).metadata();
      assert.equal(metadata.format, format === 'avif' ? 'heif' : 'tiff');
      assert.equal(metadata.exif, undefined);
      assert.equal(metadata.xmp, undefined);
      assert.equal(metadata.iptc, undefined);
      const visual = await equalVisual(input, out.original);
      assert.equal(out.width, visual.width);
      assert.equal(out.height, visual.height);
    }
  );
for (const format of ['gif', 'webp'])
  test(
    'complete processPhoto animated ' + format + ' preserves frames, timing and loop while cleaning metadata',
    async () => {
      const input = await sharp(Buffer.concat([Buffer.alloc(4 * 3 * 3, 80), Buffer.alloc(4 * 3 * 3, 120)]), {
        raw: { width: 4, height: 6, channels: 3, pageHeight: 3 }
      })
        .toFormat(format, { loop: 2, delay: [100, 200] })
        .withMetadata()
        .toBuffer();
      const out = await processPhoto(input, 'synthetic.' + format),
        before = await sharp(input, { animated: true }).metadata(),
        after = await sharp(out.original, { animated: true }).metadata();
      assert.equal(out.frames, 2);
      assert.equal(after.pages, before.pages);
      assert.deepEqual(after.delay, before.delay);
      assert.equal(after.loop, before.loop);
      assert.equal(after.xmp, undefined);
      assert.equal(after.iptc, undefined);
      await equalVisual(input, out.original);
    }
  );
function mpo(frames) {
  const tiff = Buffer.alloc(50 + frames.length * 16);
  tiff.write('MM');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(3, 8);
  for (const [at, tag, type, count, value] of [
    [10, 0xb000, 7, 4, 0x30313030],
    [22, 0xb001, 4, 1, frames.length],
    [34, 0xb002, 7, frames.length * 16, 50]
  ]) {
    tiff.writeUInt16BE(tag, at);
    tiff.writeUInt16BE(type, at + 2);
    tiff.writeUInt32BE(count, at + 4);
    tiff.writeUInt32BE(value, at + 8);
  }
  const header = Buffer.alloc(8 + tiff.length);
  header.writeUInt16BE(0xffe2);
  header.writeUInt16BE(header.length - 2, 2);
  header.write('MPF\0', 4);
  let at = 0;
  for (let i = 0; i < frames.length; i++) {
    const p = 50 + i * 16;
    tiff.writeUInt32BE(i === 0 ? 0x030000 : 0, p);
    tiff.writeUInt32BE(frames[i].length + (i ? 0 : header.length), p + 4);
    tiff.writeUInt32BE(i ? at - 10 : 0, p + 8);
    at += frames[i].length + (i ? 0 : header.length);
  }
  tiff.copy(header, 8);
  return Buffer.concat([frames[0].subarray(0, 2), header, frames[0].subarray(2), ...frames.slice(1)]);
}
test('complete processPhoto keeps a valid independent MPO container rather than persisting only its primary JPEG', async () => {
  const frames = await Promise.all(
    [6, 3].map((orientation) =>
      image()
        .withMetadata({ orientation })
        .withExifMerge({ IFD0: { Artist: SECRET } })
        .jpeg()
        .toBuffer()
    )
  );
  const input = mpo(frames),
    out = await processPhoto(input, 'synthetic.mpo');
  assert.equal(out.mime, 'image/mpo');
  assert.equal(out.frames, 1);
  assert.equal(out.original.includes(Buffer.from(SECRET)), false);
  assert.equal(out.original.toString('ascii', 6, 10), 'MPF\0');
  assert.equal(out.original.readUInt32BE(40), 2);
  const firstSize = out.original.readUInt32BE(64),
    secondStart = 10 + out.original.readUInt32BE(84),
    secondSize = out.original.readUInt32BE(80);
  assert.equal(firstSize, secondStart);
  assert.equal(secondStart + secondSize, out.original.length);
  await equalVisual(frames[0], out.original.subarray(0, firstSize));
  await equalVisual(frames[1], out.original.subarray(secondStart));
});
