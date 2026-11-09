import { bad } from './photo-contract.js';
/** Rebuild the supported BI_RGB container, retaining exact BGR(A) rows and ignoring alpha as before. */
export function sanitizeBmp(input: Buffer): Buffer {
  const fail = (): never => bad('此BMP颜色配置无法安全保留，请使用标准24或32位BMP');
  if (input.length < 54 || input.toString('ascii', 0, 2) !== 'BM') return fail();
  const dib = input.readUInt32LE(14),
    width = input.readInt32LE(18),
    h = input.readInt32LE(22),
    bits = input.readUInt16LE(28),
    offset = input.readUInt32LE(10);
  // V4/V5 carry masks, color spaces and optional linked/embedded profiles: do not silently discard them.
  if (
    dib !== 40 ||
    input.readUInt16LE(26) !== 1 ||
    input.readUInt32LE(30) !== 0 ||
    ![24, 32].includes(bits) ||
    width <= 0 ||
    !h ||
    width * Math.abs(h) > 40_000_000 ||
    offset < 54 ||
    input.readUInt32LE(46) !== 0
  )
    return fail();
  const stride = Math.ceil((width * bits) / 32) * 4,
    length = stride * Math.abs(h);
  if (offset + length > input.length) return fail();
  const output = Buffer.alloc(54 + length);
  output.write('BM');
  output.writeUInt32LE(output.length, 2);
  output.writeUInt32LE(54, 10);
  output.writeUInt32LE(40, 14);
  output.writeInt32LE(width, 18);
  output.writeInt32LE(h, 22);
  output.writeUInt16LE(1, 26);
  output.writeUInt16LE(bits, 28);
  output.writeUInt32LE(length, 34);
  // Copy only actual pixel bytes: padding, reserved fields, resolution and appended payload cannot leak.
  const rowBytes = width * (bits / 8);
  for (let y = 0; y < Math.abs(h); y++)
    input.copy(output, 54 + y * stride, offset + y * stride, offset + y * stride + rowBytes);
  return output;
}
