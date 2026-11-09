import sharp from 'sharp';
import { AccountError } from '@artzoo/domain';
import { imageFormat, withAvatarDecodeSlot } from '../media/processor';

export const MANUAL_ICON_MAX_BYTES = 2 * 1024 * 1024;
export interface ManualIconFile {
  input: Buffer;
  name: string;
  type: string;
}
function invalid(message = '请上传有效的静态 JPG、PNG 或 WebP 图片'): never {
  throw new AccountError('VALIDATION_ERROR', message, 400, { file: message });
}
export function validateManualIconFile(file: ManualIconFile) {
  if (!Buffer.isBuffer(file.input) || !file.input.length || file.input.length > MANUAL_ICON_MAX_BYTES)
    invalid('图片大小需在 2 MB 以内');
  const extension = typeof file.name === 'string' ? /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase() : null;
  const expected =
    extension === 'jpg' || extension === 'jpeg'
      ? 'jpeg'
      : extension === 'png' || extension === 'webp'
        ? extension
        : null;
  const mime = expected === 'jpeg' ? 'image/jpeg' : expected ? 'image/' + expected : null;
  if (!expected || file.type !== mime) invalid('图片扩展名、类型与内容必须一致');
  const format = imageFormat(file.input, invalid, '暂不支持动态图标');
  if (format !== expected) invalid('图片扩展名、类型与内容必须一致');
  return format;
}
export function processManualIcon(file: ManualIconFile): Promise<Buffer> {
  return withAvatarDecodeSlot(async () => {
    const format = validateManualIconFile(file);
    try {
      const source = sharp(file.input, {
        failOn: 'warning',
        limitInputPixels: 4_000_000,
        sequentialRead: true
      });
      const metadata = await source.metadata();
      if (metadata.format !== format || (metadata.pages ?? 1) !== 1) invalid('暂不支持动态图标');
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width > 4096 ||
        metadata.height > 4096 ||
        metadata.width * metadata.height > 4_000_000
      )
        invalid('图片尺寸过大');
      // Raw pixels remove all metadata; fit inside preserves the entire image.
      const decoded = await source
        .rotate()
        .timeout({ seconds: 8 })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const { width, height, channels } = decoded.info;
      const output = await sharp(decoded.data, { raw: { width, height, channels } })
        .resize({ width: 64, height: 64, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85, alphaQuality: 100, effort: 4 })
        .timeout({ seconds: 8 })
        .toBuffer();
      if (!output.length || output.length > 65_536) invalid('图标处理后过大，请选择其他图片');
      return output;
    } catch (error) {
      if (error instanceof AccountError) throw error;
      return invalid('图片无法安全解码，请重新选择静态 JPG、PNG 或 WebP 图片');
    }
  }, '图标处理繁忙，请稍后再试');
}
