import { bad, PHOTO_RULES } from './photo-contract.js';
import { stripMetadata } from './metadata-strip.js';
import { hasMpf, sanitizeMpo } from './photo-original-mpo.js';
import { sanitizeGif } from './photo-original-gif.js';
import { sanitizeBmp } from './photo-original-bmp.js';
import { reencodeOriginal } from './photo-original-reencode.js';
export interface OriginalSource {
  input: Buffer;
  format: string;
  mime: string;
  animated: boolean;
}
/** Raw input (not primary-MPO/BMP decoder input) is the container of record. New uploads only. */
export async function sanitizeOriginal(
  input: Buffer,
  source: OriginalSource,
  options: { orientation?: number; timeoutSeconds: number }
): Promise<Buffer> {
  const start = Date.now();
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 1 || options.timeoutSeconds > 20)
    return bad('图片处理时限无效');
  if (!input.length || input.length > PHOTO_RULES.maxBytes) return bad('每张图片最多30MiB');
  if (
    options.orientation !== undefined &&
    (!Number.isInteger(options.orientation) || options.orientation < 1 || options.orientation > 8)
  )
    return bad('图片方向无效');
  let output: Buffer;
  if (source.mime === 'image/bmp') output = sanitizeBmp(input);
  else if (source.mime === 'image/mpo' || (source.format === 'jpeg' && hasMpf(input)))
    output = await sanitizeMpo(input, options.orientation, options.timeoutSeconds);
  else if (['jpeg', 'png', 'webp'].includes(source.format))
    output = stripMetadata(input, source.format as 'jpeg' | 'png' | 'webp', options.orientation);
  else if (source.format === 'gif') output = sanitizeGif(input);
  else if (source.format === 'tiff') output = await reencodeOriginal(input, 'tiff', options.timeoutSeconds);
  else if (source.format === 'heif' && source.mime === 'image/avif')
    output = await reencodeOriginal(input, 'avif', options.timeoutSeconds);
  else return bad('此原图格式无法安全净化');
  if (output.length > PHOTO_RULES.maxBytes) return bad('净化后原图超过30MiB');
  if (Date.now() - start >= options.timeoutSeconds * 1000) return bad('图片净化超时');
  return output;
}
