import { deflateSync } from 'node:zlib';
export const SECRET = 'SYNTHETIC-GPS-XMP-SERIAL-IPTC';
export function richExif(orientation = 6, little = true) {
  const data = Buffer.alloc(140),
    u16 = (at, n) => (little ? data.writeUInt16LE(n, at) : data.writeUInt16BE(n, at)),
    u32 = (at, n) => (little ? data.writeUInt32LE(n, at) : data.writeUInt32BE(n, at));
  data.write(little ? 'II' : 'MM');
  u16(2, 42);
  u32(4, 8);
  u16(8, 4);
  // Orientation, Make, GPS pointer, unknown tag. Only orientation may survive.
  for (const [at, tag, type, count, value] of [
    [10, 0x112, 3, 1, orientation],
    [22, 0x10f, 2, SECRET.length + 1, 100],
    [34, 0x8825, 4, 1, 70],
    [46, 0xcafe, 7, 8, 132]
  ]) {
    u16(at, tag);
    u16(at + 2, type);
    u32(at + 4, count);
    if (type === 3 && count === 1) u16(at + 8, value);
    else u32(at + 8, value);
  }
  u32(58, 0);
  u16(70, 1);
  u16(72, 1);
  u16(74, 2);
  u32(76, 2);
  data.write('N', 80);
  u32(84, 0);
  data.write(SECRET, 100);
  data.write('SERIAL!!', 132);
  return Buffer.concat([Buffer.from('Exif\0\0'), data]);
}
export function jpegChunk(marker, payload) {
  const header = Buffer.from([255, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}
export function jpegHeaders(input) {
  const chunks = [];
  let at = 2;
  while (at < input.length) {
    const start = at;
    if (input[at++] !== 255) throw Error('fixture');
    while (input[at] === 255) at++;
    const marker = input[at++];
    if (marker === 0xd9) break;
    if (marker === 1) continue;
    const size = input.readUInt16BE(at),
      end = at + size;
    chunks.push({ marker, payload: input.subarray(at + 2, end), bytes: input.subarray(start, end) });
    at = end;
    if (marker === 0xda) break;
  }
  return chunks;
}
export function dirtyJpeg(input, orientation = 6) {
  const heads = jpegHeaders(input),
    prefix = heads.filter((c) => c.marker !== 0xe1),
    startOfScan = heads.at(-1);
  return Buffer.concat([
    input.subarray(0, 2),
    jpegChunk(0xe1, richExif(orientation)),
    jpegChunk(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0' + SECRET)),
    jpegChunk(0xed, Buffer.from('Photoshop 3.0\0' + SECRET)),
    jpegChunk(0xfe, Buffer.from(SECRET)),
    ...prefix.map((c) => c.bytes),
    input.subarray(input.indexOf(startOfScan.bytes) + startOfScan.bytes.length)
  ]);
}
const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});
export function crc(data) {
  let c = 0xffffffff;
  for (const b of data) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function pngChunk(type, payload) {
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length);
  chunk.write(type, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}
export function pngChunks(input) {
  let at = 8,
    chunks = [];
  while (at < input.length) {
    const len = input.readUInt32BE(at),
      end = at + 12 + len;
    chunks.push({
      type: input.toString('ascii', at + 4, at + 8),
      payload: input.subarray(at + 8, end - 4),
      bytes: input.subarray(at, end)
    });
    at = end;
  }
  return chunks;
}
export function dirtyPng(input, orientation = 6) {
  const chunks = pngChunks(input).filter((c) => c.type !== 'eXIf'),
    secret = Buffer.from(SECRET);
  return Buffer.concat([
    input.subarray(0, 8),
    chunks[0].bytes,
    pngChunk('eXIf', richExif(orientation).subarray(6)),
    pngChunk('tEXt', Buffer.concat([Buffer.from('GPS\0'), secret])),
    pngChunk('iTXt', Buffer.concat([Buffer.from('XMP\0\0\0\0\0'), secret])),
    pngChunk('zTXt', Buffer.concat([Buffer.from('GPS\0\0'), deflateSync(secret)])),
    pngChunk('prIV', secret),
    ...chunks.slice(1).map((c) => c.bytes)
  ]);
}
export function riffChunk(type, payload) {
  const b = Buffer.alloc(8 + payload.length + (payload.length % 2));
  b.write(type);
  b.writeUInt32LE(payload.length, 4);
  payload.copy(b, 8);
  return b;
}
export function webpChunks(input) {
  let at = 12,
    out = [];
  while (at < input.length) {
    const n = input.readUInt32LE(at + 4),
      end = at + 8 + n + (n % 2);
    out.push({
      type: input.toString('ascii', at, at + 4),
      payload: input.subarray(at + 8, at + 8 + n),
      bytes: input.subarray(at, end)
    });
    at = end;
  }
  return out;
}
export function riff(chunks) {
  const body = Buffer.concat(chunks),
    head = Buffer.from('RIFF\0\0\0\0WEBP');
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}
export function dirtyWebp(input, orientation = 6) {
  const chunks = webpChunks(input).filter((c) => !['EXIF', 'XMP '].includes(c.type));
  const extended = Buffer.from(chunks[0].payload);
  if (chunks[0].type !== 'VP8X') throw Error('fixture needs extended WebP');
  extended[0] |= 12;
  chunks[0].bytes = riffChunk('VP8X', extended);
  return riff([
    ...chunks.map((c) => c.bytes),
    riffChunk('EXIF', richExif(orientation)),
    riffChunk('XMP ', Buffer.from(SECRET)),
    riffChunk('PRIV', Buffer.from(SECRET))
  ]);
}
