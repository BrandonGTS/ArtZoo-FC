import sharp from 'sharp';
import { bad, PHOTO_RULES } from './photo-contract.js';
import { stripMetadata } from './metadata-strip.js';
function fail(): never {
  return bad('MPO多图索引无法安全保留');
}
function segments(input: Buffer): { start: number; end: number; mpf: boolean }[] {
  if (input.length < 4 || input.readUInt16BE(0) !== 0xffd8) return fail();
  const result = [];
  let p = 2;
  while (p < input.length) {
    const start = p;
    if (input[p++] !== 255) return fail();
    while (input[p] === 255) p++;
    const marker = input[p++]!;
    if (marker === 0xda || marker === 0xd9) break;
    if (p + 2 > input.length) return fail();
    const n = input.readUInt16BE(p);
    if (n < 2 || p + n > input.length) return fail();
    result.push({
      start,
      end: p + n,
      mpf: marker === 0xe2 && input.toString('ascii', p + 2, p + 6) === 'MPF\0'
    });
    p += n;
  }
  return result;
}
export function hasMpf(input: Buffer): boolean {
  return segments(input).some((s) => s.mpf);
}
/** Rebuild a minimal MP Index and retain every indexed JPEG, never flatten to the primary. */
export async function sanitizeMpo(input: Buffer, orientation?: number, timeoutSeconds = 20): Promise<Buffer> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const seconds = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return bad('MPO净化超时');
    return Math.max(1, Math.ceil(remaining / 1000));
  };
  const found = segments(input).filter((s) => s.mpf);
  if (found.length !== 1) return fail();
  const mp = found[0]!,
    base = mp.start + 8,
    end = mp.end;
  const little = input.toString('ascii', base, base + 2) === 'II';
  if (!little && input.toString('ascii', base, base + 2) !== 'MM') return fail();
  const u16 = (p: number) => {
    if (p < base || p + 2 > end) return fail();
    return little ? input.readUInt16LE(p) : input.readUInt16BE(p);
  };
  const u32 = (p: number) => {
    if (p < base || p + 4 > end) return fail();
    return little ? input.readUInt32LE(p) : input.readUInt32BE(p);
  };
  if (u16(base + 2) !== 42) return fail();
  const ifd = base + u32(base + 4),
    count = u16(ifd);
  if (![2, 3].includes(count) || u32(ifd + 2 + count * 12) !== 0) return fail();
  const seen = new Set<number>();
  let n = 0,
    table = 0,
    bytes = 0;
  for (let i = 0; i < count; i++) {
    const p = ifd + 2 + i * 12,
      tag = u16(p);
    if (![0xb000, 0xb001, 0xb002].includes(tag) || seen.has(tag)) return fail();
    seen.add(tag);
    if (
      tag === 0xb000 &&
      (u16(p + 2) !== 7 || u32(p + 4) !== 4 || input.toString('ascii', p + 8, p + 12) !== '0100')
    )
      return fail();
    if (tag === 0xb001) {
      if (u16(p + 2) !== 4 || u32(p + 4) !== 1) return fail();
      n = u32(p + 8);
    }
    if (tag === 0xb002) {
      if (u16(p + 2) !== 7) return fail();
      bytes = u32(p + 4);
      table = base + u32(p + 8);
    }
  }
  if (n < 2 || n > 100 || bytes !== n * 16 || table + bytes > end) return fail();
  const entries = [];
  for (let i = 0; i < n; i++) {
    const p = table + i * 16,
      attr = u32(p),
      size = u32(p + 4),
      rel = u32(p + 8),
      start = i ? base + rel : 0;
    if (
      (attr & 0x07000000) !== 0 ||
      size < 4 ||
      start + size > input.length ||
      input.readUInt16BE(start) !== 0xffd8 ||
      input.readUInt16BE(start + size - 2) !== 0xffd9 ||
      (i === 0 && (rel !== 0 || (attr & 0xffffff) !== 0x030000))
    )
      return fail();
    entries.push({ attr, size, start, dep1: u16(p + 12), dep2: u16(p + 14) });
  }
  // Fixed-size MPEntry attributes are rendering structure, not an EXIF payload.
  // Preserve them under the original JPEG-format/type checks; validate dependency references.
  if (
    mp.end > entries[0]!.size ||
    entries.some((e, i) => e.dep1 > n || e.dep2 > n || e.dep1 === i + 1 || e.dep2 === i + 1)
  )
    return fail();
  const ordered = [...entries].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++)
    if (ordered[i]!.start < ordered[i - 1]!.start + ordered[i - 1]!.size) return fail();
  const frames = entries.map((e, i) => {
    const frame = input.subarray(e.start, e.start + e.size);
    let pos = 0;
    const parts = [];
    for (const s of segments(frame))
      if (s.mpf) {
        parts.push(frame.subarray(pos, s.start));
        pos = s.end;
      }
    parts.push(frame.subarray(pos));
    return stripMetadata(Buffer.concat(parts), 'jpeg', i === 0 ? orientation : undefined);
  });
  // The pipeline decodes the primary for derivatives. Verify every indexed frame here too:
  // stats() forces native full decode without returning/retaining large per-frame raw Buffers.
  let totalPixels = 0;
  for (const frame of frames) {
    const image = sharp(frame, { failOn: 'warning', limitInputPixels: PHOTO_RULES.maxPixels });
    const meta = await image
      .timeout({ seconds: seconds() })
      .metadata()
      .catch(() => fail());
    if (!meta.width || !meta.height || (meta.pages ?? 1) !== 1) return fail();
    totalPixels += meta.width * meta.height;
    if (meta.width * meta.height > PHOTO_RULES.maxPixels || totalPixels > PHOTO_RULES.maxDecodedPixels)
      return bad('MPO累计图像像素过大');
    await image
      .timeout({ seconds: seconds() })
      .stats()
      .catch(() => bad('MPO图像无法完整解码'));
    seconds();
  }
  // Three structural MP tags only. No UID list, maker notes or unknown MP attributes are copied.
  const tiff = Buffer.alloc(50 + n * 16);
  tiff.write('MM');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(3, 8);
  const tag = (p: number, id: number, type: number, count: number, value: number) => {
    tiff.writeUInt16BE(id, p);
    tiff.writeUInt16BE(type, p + 2);
    tiff.writeUInt32BE(count, p + 4);
    tiff.writeUInt32BE(value, p + 8);
  };
  tag(10, 0xb000, 7, 4, 0x30313030);
  tag(22, 0xb001, 4, 1, n);
  tag(34, 0xb002, 7, n * 16, 50);
  const app = Buffer.alloc(8 + tiff.length);
  app.writeUInt16BE(0xffe2);
  app.writeUInt16BE(app.length - 2, 2);
  app.write('MPF\0', 4);
  tiff.copy(app, 8);
  const newBase = 10;
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const p = 8 + 50 + i * 16,
      e = entries[i]!,
      size = frames[i]!.length + (i === 0 ? app.length : 0);
    app.writeUInt32BE(e.attr, p);
    app.writeUInt32BE(size, p + 4);
    app.writeUInt32BE(i ? cursor - newBase : 0, p + 8);
    app.writeUInt16BE(e.dep1, p + 12);
    app.writeUInt16BE(e.dep2, p + 14);
    cursor += size;
  }
  return Buffer.concat([frames[0]!.subarray(0, 2), app, frames[0]!.subarray(2), ...frames.slice(1)]);
}
