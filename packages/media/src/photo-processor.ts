import sharp from 'sharp';
import { AccountError } from '@artzoo/domain';
import { PHOTO_RULES, bad } from './photo-contract.js';
import { bitmap } from './bitmap-runtime.js';
import { sanitizeOriginal, type OriginalSource } from './photo-original.js';

export interface PhotoOutput {
  /** Newly sanitized bytes only; callers retain raw input for request idempotency. */
  original: Buffer;
  preview: Buffer;
  thumbnail: Buffer;
  mime: string;
  width: number;
  height: number;
  frames: number;
}
type Source = OriginalSource;
function jpegPrimary(input: Buffer, mpo: boolean): Buffer {
  let offset = 2,
    primarySize: number | undefined;
  while (offset + 4 < input.length && input[offset] === 0xff) {
    const marker = input[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const size = input.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > input.length) bad('JPEG文件不完整');
    if (marker === 0xe2 && input.toString('ascii', offset + 4, offset + 8) === 'MPF\0') {
      const base = offset + 8,
        end = offset + 2 + size;
      const little = input.toString('ascii', base, base + 2) === 'II';
      if (!little && input.toString('ascii', base, base + 2) !== 'MM') bad('MPO主图索引无效');
      const u16 = (p: number) => {
        if (p < base || p + 2 > end) bad('MPO主图索引无效');
        return little ? input.readUInt16LE(p) : input.readUInt16BE(p);
      };
      const u32 = (p: number) => {
        if (p < base || p + 4 > end) bad('MPO主图索引无效');
        return little ? input.readUInt32LE(p) : input.readUInt32BE(p);
      };
      if (u16(base + 2) !== 42) bad('MPO主图索引无效');
      const ifd = base + u32(base + 4),
        count = u16(ifd);
      let images = 0,
        entries = 0,
        entryBytes = 0;
      for (let i = 0; i < count; i++) {
        const p = ifd + 2 + i * 12,
          tag = u16(p);
        if (tag === 0xb001) {
          if (u16(p + 2) !== 4 || u32(p + 4) !== 1) bad('MPO图像数量无效');
          images = u32(p + 8);
        }
        if (tag === 0xb002) {
          if (u16(p + 2) !== 7) bad('MPO主图索引无效');
          entryBytes = u32(p + 4);
          entries = base + u32(p + 8);
        }
      }
      if (images < 2 || images > 100 || entryBytes !== images * 16 || entries + entryBytes > end)
        bad('MPO主图索引无效');
      for (let i = 0; i < images; i++) {
        const p = entries + i * 16,
          attr = u32(p),
          length = u32(p + 4),
          relative = u32(p + 8),
          start = i === 0 ? 0 : base + relative;
        if (
          (attr & 0x07000000) !== 0 ||
          length < 4 ||
          start + length > input.length ||
          input.readUInt16BE(start) !== 0xffd8 ||
          input.readUInt16BE(start + length - 2) !== 0xffd9
        )
          bad('MPO图像索引无效');
        if (i === 0) {
          if (relative !== 0 || (attr & 0x00ffffff) !== 0x030000) bad('MPO缺少有效相机主图索引');
          primarySize = length;
        }
      }
    }
    offset += 2 + size;
  }
  if (mpo && !primarySize) bad('MPO缺少有效相机主图索引');
  return primarySize ? input.subarray(0, primarySize) : input;
}
async function identify(input: Buffer, name: string, timeoutSeconds: number): Promise<Source> {
  const ext = name.toLowerCase().split('.').pop();
  if (!['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'avif', 'mpo'].includes(ext ?? ''))
    bad('不支持此图片格式');
  if (input.length >= 3 && input.readUInt16BE(0) === 0xffd8)
    return {
      input: jpegPrimary(input, ext === 'mpo'),
      format: 'jpeg',
      mime: ext === 'mpo' ? 'image/mpo' : 'image/jpeg',
      animated: false
    };
  if (ext === 'mpo') bad('MPO主图索引无效');
  if (input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8;
    while (offset + 12 <= input.length) {
      const length = input.readUInt32BE(offset),
        end = offset + length + 12;
      if (end > input.length) bad('PNG文件不完整');
      const kind = input.toString('ascii', offset + 4, offset + 8);
      // This pinned decoder cannot preserve APNG frames: reject before it can flatten.
      if (['acTL', 'fcTL', 'fdAT'].includes(kind)) bad('暂不支持此动态PNG，请使用GIF或动态WebP');
      offset = end;
      if (kind === 'IEND') {
        if (offset !== input.length) bad('PNG文件无效');
        return { input, format: 'png', mime: 'image/png', animated: false };
      }
    }
    bad('PNG文件不完整');
  }
  if (/^GIF8[79]a$/.test(input.toString('ascii', 0, 6)))
    return { input, format: 'gif', mime: 'image/gif', animated: true };
  if (input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP') {
    if (input.length < 12 || input.readUInt32LE(4) + 8 !== input.length) bad('WebP文件不完整');
    return { input, format: 'webp', mime: 'image/webp', animated: true };
  }
  if (input.toString('ascii', 0, 2) === 'BM')
    return { input: await bitmap(input, timeoutSeconds), format: 'png', mime: 'image/bmp', animated: false };
  if (['49492a00', '4d4d002a'].includes(input.subarray(0, 4).toString('hex')))
    return { input, format: 'tiff', mime: 'image/tiff', animated: false };
  if (input.length > 16 && input.toString('ascii', 4, 8) === 'ftyp') {
    const size = input.readUInt32BE(0);
    if (size < 16 || size > input.length) bad('AVIF文件无效');
    const brands = [input.toString('ascii', 8, 12)];
    for (let p = 16; p + 4 <= size; p += 4) brands.push(input.toString('ascii', p, p + 4));
    if (!brands.includes('avif') || brands.some((x) => ['avis', 'heic', 'heix', 'hevc', 'hevx'].includes(x)))
      bad('仅支持静态AVIF，不支持HEIC/HEIF或AVIF序列');
    return { input, format: 'heif', mime: 'image/avif', animated: false };
  }
  return bad('不支持此图片格式或文件已损坏');
}
const slots = globalThis as unknown as { artzooPhotoUploads?: number };
export async function withPhotoSlot<T>(action: () => Promise<T>): Promise<T> {
  if ((slots.artzooPhotoUploads ?? 0) >= 2)
    throw new AccountError('SERVICE_UNAVAILABLE', '图片处理繁忙，请稍后再上传', 503);
  slots.artzooPhotoUploads = (slots.artzooPhotoUploads ?? 0) + 1;
  try {
    return await action();
  } finally {
    slots.artzooPhotoUploads!--;
  }
}
export async function processPhoto(
  input: Buffer,
  name: string,
  limits: { timeoutSeconds?: number } = {}
): Promise<PhotoOutput> {
  const timeoutSeconds = limits.timeoutSeconds ?? 20;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 20) bad('图片处理时限无效');
  if (!input.length || input.length > PHOTO_RULES.maxBytes) bad('每张图片最多30MiB');
  try {
    const source = await identify(input, name, timeoutSeconds),
      options = {
        animated: source.animated,
        limitInputPixels: PHOTO_RULES.maxDecodedPixels,
        failOn: 'warning' as const
      };
    const metadata = await sharp(source.input, options).metadata(),
      frames = metadata.pages ?? 1;
    const width = metadata.width ?? 0,
      height = metadata.pageHeight ?? metadata.height ?? 0;
    if (
      source.format !== metadata.format ||
      !width ||
      !height ||
      width * height > PHOTO_RULES.maxPixels ||
      width * height * frames > PHOTO_RULES.maxDecodedPixels ||
      frames > PHOTO_RULES.maxFrames
    )
      bad('图片尺寸或动画帧数过大');
    if (!source.animated && frames !== 1) bad('不支持多页TIFF或此动画格式');
    const encode = (size: number) =>
      sharp(source.input, options)
        .autoOrient()
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .webp({
          quality: 85,
          alphaQuality: 100,
          effort: 4,
          ...(frames > 1 ? { loop: metadata.loop ?? 0, delay: metadata.delay } : {})
        })
        .timeout({ seconds: timeoutSeconds })
        .toBuffer();
    const preview = await encode(2048),
      thumbnail = await encode(480);
    for (const output of [preview, thumbnail]) {
      const derived = await sharp(output, { animated: true }).metadata();
      if (
        (derived.pages ?? 1) !== frames ||
        (frames > 1 &&
          (derived.loop !== (metadata.loop ?? 0) ||
            JSON.stringify(derived.delay) !== JSON.stringify(metadata.delay)))
      )
        bad('此动图暂不能完整保留动画，请使用GIF或动态WebP');
    }
    // Validate/decode and create both auto-oriented derivatives before stripping anything.
    // A sanitizer must never turn a damaged input into an accepted upload.
    const original = await sanitizeOriginal(input, source, {
      orientation: metadata.orientation,
      timeoutSeconds
    });
    if (!Buffer.isBuffer(original) || !original.length || original.length > PHOTO_RULES.maxBytes)
      bad('净化后的图片无效或超过30MiB');
    const oriented = (metadata.orientation ?? 1) >= 5;
    return {
      original,
      preview,
      thumbnail,
      mime: source.mime,
      width: oriented ? height : width,
      height: oriented ? width : height,
      frames
    };
  } catch (error) {
    if (error instanceof AccountError) throw error;
    return bad('图片解码失败或暂不支持此编码');
  }
}
