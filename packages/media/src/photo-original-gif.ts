import { bad } from './photo-contract.js';
/** Preserve rendering blocks byte-for-byte; discard comments and private application payloads. */
export function sanitizeGif(input: Buffer): Buffer {
  const fail = (): never => bad('GIF文件结构无效');
  if (input.length < 13 || !/^GIF8[79]a$/.test(input.toString('ascii', 0, 6))) return fail();
  let offset = 13 + (input[10]! & 128 ? 3 * 2 ** ((input[10]! & 7) + 1) : 0);
  if (offset > input.length) return fail();
  const parts = [input.subarray(0, offset)];
  let frames = 0,
    retained = 1;
  const keep = (start: number, end: number) => {
    if (retained >= 16_384) return bad('GIF结构分段过多');
    retained++;
    parts.push(input.subarray(start, end));
  };
  const blocks = () => {
    for (;;) {
      if (offset >= input.length) return fail();
      const n = input[offset++]!;
      if (!n) return;
      if (offset + n > input.length) return fail();
      offset += n;
    }
  };
  while (offset < input.length) {
    const start = offset,
      marker = input[offset++]!;
    if (marker === 0x3b) {
      if (!frames || offset !== input.length) return fail();
      keep(start, offset);
      return Buffer.concat(parts);
    }
    if (marker === 0x2c) {
      if (offset + 9 > input.length) return fail();
      const flags = input[offset + 8]!;
      offset += 9;
      if (flags & 128) offset += 3 * 2 ** ((flags & 7) + 1);
      if (offset >= input.length) return fail();
      offset++;
      blocks();
      frames++;
      keep(start, offset);
      continue;
    }
    if (marker !== 0x21 || offset >= input.length) return fail();
    const label = input[offset++]!;
    if (label === 0xf9) {
      if (offset + 6 > input.length || input[offset] !== 4 || input[offset + 5] !== 0) return fail();
      offset += 6;
      keep(start, offset);
    } else if (label === 0xff) {
      if (offset >= input.length || input[offset] !== 11 || offset + 12 > input.length) return fail();
      const name = input.toString('ascii', offset + 1, offset + 12);
      offset += 12;
      const payload = offset;
      blocks();
      if (['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(name)) {
        if (input[payload] !== 3 || input[payload + 1] !== 1 || offset !== payload + 5) return fail();
        keep(start, offset);
      } else if (name === 'ICCRGBG1012') keep(start, offset);
    } else if (label === 0xfe) blocks();
    else if (label === 0x01) {
      if (offset >= input.length || input[offset] !== 12 || offset + 13 > input.length) return fail();
      offset += 13;
      blocks();
      keep(start, offset);
    } else return fail();
  }
  return fail();
}
