import { AVATAR_RULES } from '@artzoo/domain';

function ascii(bytes: Uint8Array, start: number, count: number) {
  return String.fromCharCode(...bytes.subarray(start, start + count));
}
function checkDimensions(width: number, height: number) {
  if (
    !width ||
    !height ||
    width > AVATAR_RULES.maxDimension ||
    height > AVATAR_RULES.maxDimension ||
    width * height > AVATAR_RULES.maxPixels
  ) {
    throw new Error('图片尺寸过大或无效，请选择边长不超过 8192 像素且不超过 2400 万像素的图片');
  }
}
function jpegDimensions(bytes: Uint8Array, view: DataView): [number, number] {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined) break;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
      return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
    }
    offset += length;
  }
  throw new Error('无法读取图片尺寸，请选择完整有效的 JPG 图片');
}
/** Inspect compressed headers before allocating decoded pixels. Server decoding remains authoritative. */
export async function decodeAvatar(file: File): Promise<ImageBitmap> {
  if (!file.size || file.size > AVATAR_RULES.maxBytes) throw new Error('请选择不超过 10 MB 的图片');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const png = bytes.length >= 24 && bytes[0] === 137 && ascii(bytes, 1, 3) === 'PNG';
  const webp = bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP';
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !webp && !jpeg) throw new Error('仅支持静态 JPG、PNG 或 WebP 图片');
  let dimensions: [number, number] | null = jpeg ? jpegDimensions(bytes, view) : null;
  if (png || webp) {
    for (let offset = png ? 8 : 12; offset + 8 <= bytes.length;) {
      const length = view.getUint32(offset + (png ? 0 : 4), !png);
      const kind = ascii(bytes, offset + (png ? 4 : 0), 4);
      const start = offset + 8;
      if (kind === 'acTL' || kind === 'ANIM' || kind === 'ANMF')
        throw new Error('头像不支持动画，请选择静态图片');
      const next = start + length + (png ? 4 : length % 2);
      if (next > bytes.length || next <= offset) throw new Error('无法读取图片，请选择完整有效的图片');
      if (png && kind === 'IHDR' && length === 13)
        dimensions = [view.getUint32(start), view.getUint32(start + 4)];
      if (webp && kind === 'VP8X' && length >= 10) {
        if (view.getUint8(start) & 2) throw new Error('头像不支持动画，请选择静态图片');
        dimensions = [
          1 + view.getUint8(start + 4) + (view.getUint8(start + 5) << 8) + (view.getUint8(start + 6) << 16),
          1 + view.getUint8(start + 7) + (view.getUint8(start + 8) << 8) + (view.getUint8(start + 9) << 16)
        ];
      }
      if (webp && kind === 'VP8 ' && length >= 10 && ascii(bytes, start + 3, 3) === '\x9d\x01\x2a') {
        const frame: [number, number] = [
          view.getUint16(start + 6, true) & 0x3fff,
          view.getUint16(start + 8, true) & 0x3fff
        ];
        checkDimensions(...frame);
        dimensions ??= frame;
      }
      if (webp && kind === 'VP8L' && length >= 5 && view.getUint8(start) === 0x2f) {
        const bits = view.getUint32(start + 1, true);
        const frame: [number, number] = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
        checkDimensions(...frame);
        dimensions ??= frame;
      }
      if (dimensions) checkDimensions(...dimensions);
      offset = next;
    }
  }
  if (!dimensions) throw new Error('无法读取图片尺寸，请选择完整有效的图片');
  checkDimensions(...dimensions);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('无法读取图片，请选择完整有效的静态图片');
  }
  try {
    checkDimensions(bitmap.width, bitmap.height);
  } catch (error) {
    bitmap.close();
    throw error;
  }
  return bitmap;
}
