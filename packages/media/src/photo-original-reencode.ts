import sharp from 'sharp';
import { bad, PHOTO_RULES } from './photo-contract.js';
function fail(): never {
  return bad('此图片色深、颜色配置或编码无法无损安全保留');
}
// Rebuild only a fresh encoder's structural TIFF tags and strips, never its private metadata.
function cleanTiff(input: Buffer): Buffer {
  const le = input.toString('ascii', 0, 2) === 'II';
  if (!le && input.toString('ascii', 0, 2) !== 'MM') return fail();
  const u16 = (p: number) => {
    if (p < 0 || p + 2 > input.length) return fail();
    return le ? input.readUInt16LE(p) : input.readUInt16BE(p);
  };
  const u32 = (p: number) => {
    if (p < 0 || p + 4 > input.length) return fail();
    return le ? input.readUInt32LE(p) : input.readUInt32BE(p);
  };
  if (u16(2) !== 42) return fail();
  const first = u32(4),
    n = u16(first);
  if (first + 2 + n * 12 + 4 > input.length || u32(first + 2 + n * 12) !== 0) return fail();
  const allowed = new Set([
    256, 257, 258, 259, 262, 273, 274, 277, 278, 279, 282, 283, 284, 296, 317, 338, 339, 34675
  ]);
  const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 12: 8 };
  const tags: { id: number; type: number; count: number; data: Buffer }[] = [];
  for (let i = 0; i < n; i++) {
    const p = first + 2 + i * 12,
      id = u16(p),
      type = u16(p + 2),
      count = u32(p + 4);
    if (!allowed.has(id)) continue;
    const size = sizes[type];
    if (!size || count * size > input.length) return fail();
    const length = count * size,
      start = length <= 4 ? p + 8 : u32(p + 8);
    if (start + length > input.length) return fail();
    tags.push({ id, type, count, data: Buffer.from(input.subarray(start, start + length)) });
  }
  const values = (tag: { type: number; count: number; data: Buffer } | undefined) => {
    if (!tag || ![3, 4].includes(tag.type)) return fail();
    return Array.from({ length: tag.count }, (_, i) =>
      tag.type === 3
        ? le
          ? tag.data.readUInt16LE(i * 2)
          : tag.data.readUInt16BE(i * 2)
        : le
          ? tag.data.readUInt32LE(i * 4)
          : tag.data.readUInt32BE(i * 4)
    );
  };
  const off = tags.find((t) => t.id === 273),
    lengths = values(tags.find((t) => t.id === 279)),
    offsets = values(off);
  if (!off || offsets.length !== lengths.length) return fail();
  const strips = offsets.map((p, i) => {
    if (p + lengths[i]! > input.length) return fail();
    return input.subarray(p, p + lengths[i]!);
  });
  off.type = 4;
  off.data = Buffer.alloc(off.count * 4);
  let cursor = 8 + 2 + tags.length * 12 + 4;
  for (const t of tags) if (t.data.length > 4) cursor += (t.data.length + 1) & ~1;
  const total = cursor + strips.reduce((n, b) => n + b.length, 0);
  if (total > PHOTO_RULES.maxBytes) return bad('净化后原图超过30MiB');
  const out = Buffer.alloc(total);
  out.write(le ? 'II' : 'MM');
  const w16 = (v: number, p: number) => (le ? out.writeUInt16LE(v, p) : out.writeUInt16BE(v, p)),
    w32 = (v: number, p: number) => (le ? out.writeUInt32LE(v, p) : out.writeUInt32BE(v, p));
  w16(42, 2);
  w32(8, 4);
  w16(tags.length, 8);
  let pixels = cursor;
  for (let i = 0; i < strips.length; i++) {
    le ? off.data.writeUInt32LE(pixels, i * 4) : off.data.writeUInt32BE(pixels, i * 4);
    strips[i]!.copy(out, pixels);
    pixels += strips[i]!.length;
  }
  cursor = 8 + 2 + tags.length * 12 + 4;
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i]!,
      p = 10 + i * 12;
    w16(t.id, p);
    w16(t.type, p + 2);
    w32(t.count, p + 4);
    if (t.data.length <= 4) t.data.copy(out, p + 8);
    else {
      w32(cursor, p + 8);
      t.data.copy(out, cursor);
      cursor += (t.data.length + 1) & ~1;
    }
  }
  return out;
}
/** Explicit lossless encode, with a decoded-pixel and ICC equality gate before return. */
export async function reencodeOriginal(
  input: Buffer,
  format: 'tiff' | 'avif',
  timeoutSeconds: number
): Promise<Buffer> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const seconds = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) return bad('图片净化超时');
    return Math.max(1, Math.ceil(ms / 1000));
  };
  // Bound additional verification buffers to 2 x 4MP x RGBA = 32MB/request, before decoding.
  const options = { failOn: 'warning' as const, limitInputPixels: PHOTO_RULES.maxPixels, ignoreIcc: true };
  const meta = await sharp(input, options).timeout({ seconds: seconds() }).metadata();
  if (
    meta.depth !== 'uchar' ||
    (meta.bitsPerSample !== undefined && meta.bitsPerSample !== 8) ||
    meta.space !== 'srgb' ||
    ![3, 4].includes(meta.channels) ||
    (meta.pages ?? 1) !== 1
  )
    return fail();
  if (!meta.width || !meta.height || meta.width * meta.height > 4_000_000)
    return bad('TIFF/AVIF安全净化最多400万像素');
  const before = await sharp(input, options)
    .autoOrient()
    .ensureAlpha()
    .raw()
    .timeout({ seconds: seconds() })
    .toBuffer({ resolveWithObject: true });
  let image = sharp(input, options).autoOrient().keepIccProfile();
  image =
    format === 'tiff'
      ? image.tiff({ compression: 'lzw', predictor: 'horizontal' })
      : image.avif({ lossless: true, bitdepth: 8, chromaSubsampling: '4:4:4', effort: 4 });
  let output: Buffer = await image.timeout({ seconds: seconds() }).toBuffer();
  if (output.length > PHOTO_RULES.maxBytes) return bad('净化后原图超过30MiB');
  if (format === 'tiff') output = cleanTiff(output);
  const afterMeta = await sharp(output, options).timeout({ seconds: seconds() }).metadata();
  if (Boolean(meta.icc) !== Boolean(afterMeta.icc) || (meta.icc && !meta.icc.equals(afterMeta.icc!)))
    return fail();
  if (afterMeta.exif || afterMeta.xmp || afterMeta.iptc) return fail();
  const after = await sharp(output, options)
    .autoOrient()
    .ensureAlpha()
    .raw()
    .timeout({ seconds: seconds() })
    .toBuffer({ resolveWithObject: true });
  if (
    after.info.width !== before.info.width ||
    after.info.height !== before.info.height ||
    !after.data.equals(before.data)
  )
    return fail();
  seconds();
  return output;
}
