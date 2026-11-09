// Only orientation survives. Never splice an original IFD or follow GPS/Exif pointers.
const fail = (): never => {
  throw new Error('Invalid image metadata');
};
export function readExifOrientation(exif: Buffer): number | undefined {
  const input = exif.subarray(exif.subarray(0, 6).equals(Buffer.from('Exif\0\0')) ? 6 : 0);
  if (input.length < 8) return fail();
  const endian = input.toString('latin1', 0, 2);
  if (endian !== 'II' && endian !== 'MM') return fail();
  const u16 = (at: number) => {
    if (at < 0 || at + 2 > input.length) return fail();
    return endian === 'II' ? input.readUInt16LE(at) : input.readUInt16BE(at);
  };
  const u32 = (at: number) => {
    if (at < 0 || at + 4 > input.length) return fail();
    return endian === 'II' ? input.readUInt32LE(at) : input.readUInt32BE(at);
  };
  if (u16(2) !== 42) return fail();
  const first = u32(4);
  if (first < 8 || first % 2) return fail();
  const count = u16(first),
    end = first + 2 + count * 12;
  if (end + 4 > input.length) return fail();
  const sizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
  let orientation: number | undefined;
  for (let i = 0; i < count; i++) {
    const at = first + 2 + i * 12,
      tag = u16(at),
      type = u16(at + 2),
      items = u32(at + 4),
      unit = sizes[type];
    if (!unit || !items) return fail();
    const size = unit * items;
    if (size > 4) {
      const offset = u32(at + 8);
      if (offset < 8 || offset + size > input.length) return fail();
    }
    if (tag !== 0x0112) continue;
    if (orientation !== undefined || type !== 3 || items !== 1) return fail();
    orientation = u16(at + 8);
    if (orientation < 1 || orientation > 8) return fail();
  }
  const next = u32(end);
  if (next && (next < 8 || next % 2 || next + 2 > input.length)) return fail();
  return orientation;
}
export function orientationExif(orientation: number, prefix: boolean): Buffer {
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) return fail();
  const tiff = Buffer.alloc(26);
  tiff.write('II');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  return prefix ? Buffer.concat([Buffer.from('Exif\0\0'), tiff]) : tiff;
}
