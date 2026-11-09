import { withUploadSlot } from './upload-gate';
import sharp from 'sharp';
import { AccountError, AVATAR_RULES, type AvatarCrop } from '@artzoo/domain';

export interface AvatarOutput {
  full: Buffer;
  small: Buffer;
  width: number;
  height: number;
}
export function invalidAvatar(message = '请上传有效的静态 JPG、PNG 或 WebP 图片'): never {
  throw new AccountError('VALIDATION_ERROR', message, 400, { file: message });
}
export function avatarCrop(value: unknown): AvatarCrop {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidAvatar('裁剪参数无效');
  const crop = value as Record<string, unknown>;
  if (
    Object.keys(crop).length !== 3 ||
    Object.keys(crop).some((key) => !['x', 'y', 'size'].includes(key)) ||
    !['x', 'y', 'size'].every((key) => typeof crop[key] === 'number' && Number.isFinite(crop[key]))
  )
    invalidAvatar('裁剪参数无效');
  const { x, y, size } = crop as unknown as AvatarCrop;
  if (x < 0 || y < 0 || x > 1 || y > 1 || size <= 0 || size > 1) invalidAvatar('裁剪参数无效');
  return { x, y, size };
}
export function imageFormat(
  input: Buffer,
  reject: (message?: string) => never = invalidAvatar,
  animationMessage = '暂不支持动态头像'
): 'jpeg' | 'png' | 'webp' {
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return 'jpeg';
  if (input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8,
      ended = false;
    while (offset + 12 <= input.length) {
      const length = input.readUInt32BE(offset),
        end = offset + length + 12;
      if (end > input.length) reject();
      const kind = input.toString('ascii', offset + 4, offset + 8);
      // Reject animation even if the decoder would silently return the default image.
      if (['acTL', 'fcTL', 'fdAT'].includes(kind)) reject(animationMessage);
      offset = end;
      if (kind === 'IEND') {
        ended = true;
        break;
      }
    }
    if (!ended || offset !== input.length) reject();
    return 'png';
  }
  if (
    input.length >= 12 &&
    input.toString('ascii', 0, 4) === 'RIFF' &&
    input.toString('ascii', 8, 12) === 'WEBP'
  ) {
    if (input.readUInt32LE(4) + 8 !== input.length) reject();
    let offset = 12;
    while (offset + 8 <= input.length) {
      const kind = input.toString('ascii', offset, offset + 4),
        length = input.readUInt32LE(offset + 4);
      const end = offset + 8 + length + (length % 2);
      if (end > input.length) reject();
      if (kind === 'ANIM' || kind === 'ANMF' || (kind === 'VP8X' && length > 0 && input[offset + 8]! & 2))
        reject(animationMessage);
      offset = end;
    }
    if (offset !== input.length) reject();
    return 'webp';
  }
  return reject();
}
const state = globalThis as unknown as { artzooAvatarDecoders?: number };
export function withAvatarUploadSlot<T>(
  action: () => Promise<T>,
  busyMessage = '头像处理繁忙，请稍后再试'
): Promise<T> {
  return withUploadSlot(action, busyMessage);
}
export async function withAvatarDecodeSlot<T>(
  action: () => Promise<T>,
  busyMessage = '头像处理繁忙，请稍后再试'
): Promise<T> {
  if ((state.artzooAvatarDecoders ?? 0) >= 2) throw new AccountError('SERVICE_UNAVAILABLE', busyMessage, 503);
  state.artzooAvatarDecoders = (state.artzooAvatarDecoders ?? 0) + 1;
  try {
    return await action();
  } finally {
    state.artzooAvatarDecoders!--;
  }
}
export async function processAvatar(input: Buffer, rawCrop: unknown): Promise<AvatarOutput> {
  if (!input.length || input.length > AVATAR_RULES.maxBytes) invalidAvatar('图片大小需在 10 MB 以内');
  const crop = avatarCrop(rawCrop),
    format = imageFormat(input);
  if ((state.artzooAvatarDecoders ?? 0) >= 2)
    throw new AccountError('SERVICE_UNAVAILABLE', '头像处理繁忙，请稍后再试', 503);
  state.artzooAvatarDecoders = (state.artzooAvatarDecoders ?? 0) + 1;
  try {
    const source = sharp(input, {
      failOn: 'warning',
      limitInputPixels: AVATAR_RULES.maxPixels,
      sequentialRead: true
    });
    const metadata = await source.metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1) invalidAvatar('暂不支持动态头像');
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > AVATAR_RULES.maxDimension ||
      metadata.height > AVATAR_RULES.maxDimension ||
      metadata.width * metadata.height > AVATAR_RULES.maxPixels
    )
      invalidAvatar('图片尺寸过大');
    // Decode orientation first. Starting the next pipeline from raw pixels also guarantees EXIF/XMP/ICC removal.
    const decoded = await source.rotate().timeout({ seconds: 8 }).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = decoded.info;
    const side = crop.size * Math.min(width, height),
      left = crop.x * width,
      top = crop.y * height;
    if (side < 1 || left + side > width + 0.000001 || top + side > height + 0.000001)
      invalidAvatar('裁剪范围超出图片');
    const size = Math.min(Math.round(side), width, height);
    const region = {
      left: Math.min(Math.round(left), width - size),
      top: Math.min(Math.round(top), height - size),
      width: size,
      height: size
    };
    const encode = (target: number) =>
      sharp(decoded.data, { raw: { width, height, channels } })
        .extract(region)
        .resize({ width: target, height: target, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85, alphaQuality: 100, effort: 4 })
        .timeout({ seconds: 8 })
        .toBuffer();
    const full = await encode(AVATAR_RULES.outputSize),
      small = await encode(AVATAR_RULES.smallSize);
    return {
      full,
      small,
      width: Math.min(size, AVATAR_RULES.outputSize),
      height: Math.min(size, AVATAR_RULES.outputSize)
    };
  } catch (error) {
    if (error instanceof AccountError) throw error;
    return invalidAvatar('图片无法安全解码，请重新选择静态 JPG、PNG 或 WebP 图片');
  } finally {
    state.artzooAvatarDecoders!--;
  }
}
