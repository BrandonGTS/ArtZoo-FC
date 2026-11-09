import { inflateSync } from 'node:zlib';
import { orientationExif, readExifOrientation } from './safe-exif.js';
export { readExifOrientation } from './safe-exif.js';
export type MetadataImageFormat = 'jpeg' | 'png' | 'webp';
// One allocation budget across all WebP frame subchunks as well as top-level chunks.
const MAX_CONTAINER_PARTS = 16_384;
type Budget = { parts: number };
function part(budget: Budget): void {
  if (++budget.parts > MAX_CONTAINER_PARTS) throw new Error('Image container fragmentation limit exceeded');
}

const fail = (): never => {
  throw new Error('Invalid image metadata container');
};
function direction(explicit: number | undefined, exif: Buffer[]): number | undefined {
  if (explicit !== undefined && (!Number.isInteger(explicit) || explicit < 1 || explicit > 8)) return fail();
  if (exif.length > 1) return fail();
  return explicit ?? (exif[0] ? readExifOrientation(exif[0]) : undefined);
}
function jpegSegment(marker: number, payload: Buffer) {
  const head = Buffer.from([255, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
function jpeg(input: Buffer, explicit?: number) {
  if (input.length < 4 || input.readUInt16BE(0) !== 0xffd8) return fail();
  const pieces: { marker: number; bytes: Buffer }[] = [],
    exif: Buffer[] = [];
  const budget: Budget = { parts: 0 };
  let at = 2,
    ended = false,
    frame = false,
    scans = 0;
  while (at < input.length) {
    part(budget);
    const start = at;
    if (input[at++] !== 255) return fail();
    while (input[at] === 255) at++;
    if (at >= input.length) return fail();
    const marker = input[at++]!;
    if (marker === 0xd9) {
      if (!frame || !scans || at !== input.length) return fail();
      pieces.push({ marker, bytes: input.subarray(start, at) });
      ended = true;
      break;
    }
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return fail();
    if (marker === 1) {
      pieces.push({ marker, bytes: input.subarray(start, at) });
      continue;
    }
    if (at + 2 > input.length) return fail();
    const size = input.readUInt16BE(at),
      end = at + size;
    if (size < 2 || end > input.length) return fail();
    const payload = input.subarray(at + 2, end);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (frame || payload.length < 6 || size !== 8 + 3 * payload[5]!) return fail();
      frame = true;
    }
    if (marker === 0xe1 && payload.subarray(0, 6).equals(Buffer.from('Exif\0\0'))) exif.push(payload);
    if (![0xe1, 0xed, 0xfe].includes(marker)) pieces.push({ marker, bytes: input.subarray(start, end) });
    at = end;
    if (marker !== 0xda) continue;
    if (!frame || payload.length < 4 || payload[0] === 0 || size !== 6 + 2 * payload[0]!) return fail();
    scans++;
    const entropy = at;
    while (at < input.length) {
      if (input[at] !== 255) {
        at++;
        continue;
      }
      const candidate = at;
      while (input[at] === 255) at++;
      if (at >= input.length) return fail();
      const code = input[at]!;
      if (code === 0 || code === 1 || (code >= 0xd0 && code <= 0xd7)) {
        at++;
        continue;
      }
      at = candidate;
      break;
    }
    pieces.push({ marker: -1, bytes: input.subarray(entropy, at) });
  }
  if (!ended) return fail();
  const orientation = direction(explicit, exif);
  if (orientation && orientation !== 1) {
    let place = 0;
    while (pieces[place]?.marker === 0xe0) place++;
    pieces.splice(place, 0, { marker: 0xe1, bytes: jpegSegment(0xe1, orientationExif(orientation, true)) });
  }
  return Buffer.concat([input.subarray(0, 2), ...pieces.map((piece) => piece.bytes)]);
}
// PNG-3: CRC covers type+payload. Preserve encoded image/color chunks byte-for-byte.
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc(input: Buffer) {
  let value = 0xffffffff;
  for (const byte of input) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4, 4, 'ascii');
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type PngState = { depth: number; color: number; palette: number; seen: Set<string> };
function pngIcc(payload: Buffer, color: number): Buffer {
  const end = payload.indexOf(0);
  if (end < 1 || end > 79 || end + 2 >= payload.length || payload[end + 1] !== 0) return fail();
  const name = payload.subarray(0, end);
  if (
    name[0] === 32 ||
    name.at(-1) === 32 ||
    name.some((v, i) => !((v >= 32 && v <= 126) || v >= 161) || (v === 32 && name[i - 1] === 32))
  )
    return fail();
  const compressed = payload.subarray(end + 2);
  let profile: Buffer;
  try {
    // At most one profile per PNG. Bound decompression independently of compressed size.
    // Node 24 supports info=true; the pinned declarations still return Buffer for this overload.
    const decoded = inflateSync(compressed, { info: true, maxOutputLength: 30 * 1024 * 1024 }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (!Buffer.isBuffer(decoded.buffer) || decoded.engine?.bytesWritten !== compressed.length) return fail();
    profile = decoded.buffer;
  } catch {
    return fail();
  }
  if (
    profile.length < 132 ||
    profile.readUInt32BE(0) !== profile.length ||
    profile.toString('latin1', 36, 40) !== 'acsp' ||
    profile.toString('latin1', 16, 20) !== ([0, 4].includes(color) ? 'GRAY' : 'RGB ')
  )
    return fail();
  const count = profile.readUInt32BE(128),
    tableEnd = 132 + count * 12;
  if (!count || count > MAX_CONTAINER_PARTS || tableEnd > profile.length) return fail();
  const tags = new Set<string>();
  for (let i = 0; i < count; i++) {
    const at = 132 + i * 12,
      tag = profile.toString('latin1', at, at + 4),
      offset = profile.readUInt32BE(at + 4),
      size = profile.readUInt32BE(at + 8);
    if (tags.has(tag) || offset % 4 || offset < tableEnd || size < 8 || offset + size > profile.length)
      return fail();
    tags.add(tag);
  }
  // The PNG wrapper name is not color data and can itself contain identifying text.
  // Preserve the actual ICC and its compressed stream exactly, only normalize that name.
  return Buffer.concat([Buffer.from('ICC\0\0'), compressed]);
}
function pngStructure(type: string, p: Buffer, state: PngState): Buffer {
  const { color, depth } = state,
    max = 2 ** depth - 1;
  const sample = (at: number) => {
    if (p.readUInt16BE(at) > max) return fail();
  };
  if (type === 'IHDR') {
    if (
      p.length !== 13 ||
      !p.readUInt32BE(0) ||
      !p.readUInt32BE(4) ||
      p.readUInt32BE(0) > 0x7fffffff ||
      p.readUInt32BE(4) > 0x7fffffff ||
      p[10] !== 0 ||
      p[11] !== 0 ||
      p[12]! > 1
    )
      return fail();
    const depths: Record<number, number[]> = {
      0: [1, 2, 4, 8, 16],
      2: [8, 16],
      3: [1, 2, 4, 8],
      4: [8, 16],
      6: [8, 16]
    };
    if (!depths[p[9]!]?.includes(p[8]!)) return fail();
    state.depth = p[8]!;
    state.color = p[9]!;
  } else if (type === 'PLTE') {
    if (
      [0, 4].includes(color) ||
      !p.length ||
      p.length % 3 ||
      p.length > 768 ||
      (color === 3 && p.length / 3 > 2 ** depth) ||
      state.seen.has('tRNS') ||
      state.seen.has('bKGD')
    )
      return fail();
    state.palette = p.length / 3;
  } else if (type === 'tRNS') {
    if (color === 3) {
      if (!state.palette || !p.length || p.length > state.palette) return fail();
    } else if (color === 0 && p.length === 2) sample(0);
    else if (color === 2 && p.length === 6) {
      sample(0);
      sample(2);
      sample(4);
    } else return fail();
  } else if (type === 'bKGD') {
    if (color === 3) {
      if (p.length !== 1 || !state.palette || p[0]! >= state.palette) return fail();
    } else if ([0, 4].includes(color) && p.length === 2) sample(0);
    else if ([2, 6].includes(color) && p.length === 6) {
      sample(0);
      sample(2);
      sample(4);
    } else return fail();
  } else if (type === 'sBIT') {
    const channels: Record<number, number> = { 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 };
    if (p.length !== channels[color] || p.some((v) => v < 1 || v > (color === 3 ? 8 : depth))) return fail();
  } else if (type === 'pHYs') {
    if (p.length !== 9 || p[8]! > 1) return fail();
  } else if (type === 'gAMA') {
    if (p.length !== 4 || !p.readUInt32BE(0)) return fail();
  } else if (type === 'cHRM') {
    if (p.length !== 32) return fail();
    for (let i = 0; i < 32; i += 8) if (p.readUInt32BE(i) + p.readUInt32BE(i + 4) > 100000) return fail();
  } else if (type === 'sRGB') {
    if (p.length !== 1 || p[0]! > 3) return fail();
  } else if (type === 'cICP') {
    if (
      p.length !== 4 ||
      ![1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 22].includes(p[0]!) ||
      ![1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].includes(p[1]!) ||
      p[2] !== 0 ||
      p[3]! > 1
    )
      return fail();
  } else if (type === 'mDCV') {
    if (p.length !== 24 || p.readUInt32BE(16) < p.readUInt32BE(20)) return fail();
    for (let i = 0; i < 16; i += 4) if (p.readUInt16BE(i) + p.readUInt16BE(i + 2) > 50000) return fail();
  } else if (type === 'cLLI') {
    if (p.length !== 8 || (p.readUInt32BE(0) && p.readUInt32BE(4) > p.readUInt32BE(0))) return fail();
  } else if (type === 'iCCP') return pngIcc(p, color);
  else if (type === 'IDAT' && color === 3 && !state.palette) return fail();
  return p;
}
function png(input: Buffer, explicit?: number) {
  if (!input.subarray(0, 8).equals(pngSignature)) return fail();
  const kept: Buffer[] = [],
    exif: Buffer[] = [],
    seen = new Set<string>();
  const structure: PngState = { depth: 0, color: -1, palette: 0, seen };
  const budget: Budget = { parts: 0 };
  let at = 8,
    idat = false,
    idatEnded = false,
    ended = false;
  const allowed = new Set([
    'IHDR',
    'PLTE',
    'IDAT',
    'IEND',
    'tRNS',
    'gAMA',
    'cHRM',
    'sRGB',
    'iCCP',
    'sBIT',
    'bKGD',
    'pHYs',
    'cICP',
    'mDCV',
    'cLLI'
  ]);
  while (at < input.length) {
    part(budget);
    if (at + 12 > input.length) return fail();
    const size = input.readUInt32BE(at),
      end = at + size + 12,
      type = input.toString('latin1', at + 4, at + 8);
    if (size > 0x7fffffff || end > input.length || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) return fail();
    if (input.readUInt32BE(end - 4) !== crc(input.subarray(at + 4, end - 4))) return fail();
    if (!seen.size && type !== 'IHDR') return fail();
    if (
      type !== 'IDAT' &&
      [
        'IHDR',
        'PLTE',
        'IEND',
        'eXIf',
        'iCCP',
        'sRGB',
        'gAMA',
        'cHRM',
        'sBIT',
        'bKGD',
        'pHYs',
        'tRNS',
        'cICP',
        'mDCV',
        'cLLI'
      ].includes(type) &&
      seen.has(type)
    )
      return fail();
    if (type === 'IHDR' && (size !== 13 || !input.readUInt32BE(at + 8) || !input.readUInt32BE(at + 12)))
      return fail();
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) return fail(); // Pipeline already rejects unsupported APNG.
    if (/^[A-Z]/.test(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) return fail();
    if (type === 'PLTE' && (idat || !size || size % 3 || size > 768)) return fail();
    if (type === 'IDAT') {
      if (idatEnded) return fail();
      idat = true;
    } else if (idat) idatEnded = true;
    if (['iCCP', 'sRGB', 'gAMA', 'cHRM', 'sBIT', 'cICP', 'mDCV', 'cLLI'].includes(type) && idat)
      return fail();
    if (['tRNS', 'bKGD', 'pHYs'].includes(type) && idat) return fail();
    if (['gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'cICP', 'mDCV', 'cLLI'].includes(type) && seen.has('PLTE'))
      return fail();
    const payload = pngStructure(type, input.subarray(at + 8, end - 4), structure);
    if (type === 'eXIf') exif.push(input.subarray(at + 8, end - 4));
    if (allowed.has(type)) kept.push(type === 'iCCP' ? pngChunk(type, payload) : input.subarray(at, end)); // Drop all text/private metadata, not only known GPS carriers.
    seen.add(type);
    at = end;
    if (type === 'IEND') {
      if (size !== 0 || !idat || at !== input.length) return fail();
      ended = true;
      break;
    }
  }
  if (!ended) return fail();
  const orientation = direction(explicit, exif);
  if (orientation && orientation !== 1)
    kept.splice(1, 0, pngChunk('eXIf', orientationExif(orientation, false)));
  return Buffer.concat([pngSignature, ...kept]);
}
type RiffChunk = { type: string; payload: Buffer; bytes: Buffer };
function riffChunks(input: Buffer, start: number, end: number, budget: Budget): RiffChunk[] {
  const chunks: RiffChunk[] = [];
  for (let at = start; at < end;) {
    part(budget);
    if (at + 8 > end) return fail();
    const type = input.toString('latin1', at, at + 4),
      size = input.readUInt32LE(at + 4),
      next = at + 8 + size + (size % 2);
    if (next > end || !/^[\x20-\x7e]{4}$/.test(type) || (size % 2 && input[next - 1] !== 0)) return fail();
    chunks.push({ type, payload: input.subarray(at + 8, at + 8 + size), bytes: input.subarray(at, next) });
    at = next;
  }
  return chunks;
}
function riffChunk(type: string, payload: Buffer) {
  const bytes = Buffer.alloc(8 + payload.length + (payload.length % 2));
  bytes.write(type, 0, 4, 'ascii');
  bytes.writeUInt32LE(payload.length, 4);
  payload.copy(bytes, 8);
  return bytes;
}
function webpSize(chunk: RiffChunk) {
  const p = chunk.payload;
  if (
    chunk.type === 'VP8 ' &&
    p.length >= 10 &&
    !(p[0]! & 1) &&
    p.subarray(3, 6).equals(Buffer.from([0x9d, 1, 0x2a]))
  ) {
    const width = p.readUInt16LE(6) & 0x3fff,
      height = p.readUInt16LE(8) & 0x3fff;
    if (!width || !height) return fail();
    return { width, height, alpha: false };
  }
  if (chunk.type === 'VP8L' && p.length >= 5 && p[0] === 0x2f && !(p[4]! & 0xe0))
    return {
      width: 1 + (p.readUInt32LE(1) % 16384),
      height: 1 + ((p.readUInt32LE(1) >>> 14) & 0x3fff),
      alpha: Boolean(p[4]! & 0x10)
    };
  return fail();
}
function webp(input: Buffer, explicit?: number) {
  if (
    input.length < 12 ||
    input.toString('latin1', 0, 4) !== 'RIFF' ||
    input.toString('latin1', 8, 12) !== 'WEBP' ||
    input.readUInt32LE(4) + 8 !== input.length
  )
    return fail();
  const budget: Budget = { parts: 0 };
  const chunks = riffChunks(input, 12, input.length, budget),
    exif = chunks.filter((c) => c.type === 'EXIF').map((c) => c.payload),
    counts = new Map<string, number>();
  for (const chunk of chunks) counts.set(chunk.type, (counts.get(chunk.type) ?? 0) + 1);
  for (const type of ['VP8X', 'ICCP', 'ANIM', 'EXIF', 'XMP ', 'ALPH', 'VP8 ', 'VP8L'])
    if ((counts.get(type) ?? 0) > 1) return fail();
  const extended = chunks.find((c) => c.type === 'VP8X'),
    anim = chunks.some((c) => c.type === 'ANMF');
  if (
    extended &&
    (chunks[0] !== extended ||
      extended.payload.length !== 10 ||
      extended.payload[0]! & 0xc1 ||
      extended.payload.subarray(1, 4).some((value) => value !== 0))
  )
    return fail();
  if (!extended && (anim || chunks.some((c) => ['ICCP', 'ANIM', 'ALPH', 'EXIF', 'XMP '].includes(c.type))))
    return fail();
  const frames = chunks.filter((c) => ['VP8 ', 'VP8L'].includes(c.type));
  if (anim ? frames.length !== 0 || counts.get('ANIM') !== 1 : frames.length !== 1 || counts.has('ANIM'))
    return fail();
  const size = anim
    ? {
        width: extended!.payload.readUIntLE(4, 3) + 1,
        height: extended!.payload.readUIntLE(7, 3) + 1,
        alpha: Boolean(extended!.payload[0]! & 0x10)
      }
    : webpSize(frames[0]!);
  if (
    extended &&
    (Boolean(extended.payload[0]! & 2) !== anim ||
      Boolean(extended.payload[0]! & 0x20) !== counts.has('ICCP') ||
      extended.payload.readUIntLE(4, 3) + 1 !== size.width ||
      extended.payload.readUIntLE(7, 3) + 1 !== size.height)
  )
    return fail();
  if (counts.has('ALPH') && (anim || frames[0]?.type !== 'VP8 ')) return fail();
  let seenImage = false,
    seenAnim = false;
  for (const chunk of chunks) {
    if (chunk.type === 'ICCP' && seenImage) return fail();
    if (chunk.type === 'ANIM') {
      if (chunk.payload.length !== 6 || seenImage) return fail();
      seenAnim = true;
    }
    if (chunk.type === 'ANMF') {
      const p = chunk.payload;
      if (!seenAnim || p.length < 16 || p[15]! & 0xfc) return fail();
      const width = p.readUIntLE(6, 3) + 1,
        height = p.readUIntLE(9, 3) + 1;
      if (2 * p.readUIntLE(0, 3) + width > size.width || 2 * p.readUIntLE(3, 3) + height > size.height)
        return fail();
      const nested = riffChunks(p, 16, p.length, budget),
        images = nested.filter((c) => ['VP8 ', 'VP8L'].includes(c.type));
      if (
        images.length !== 1 ||
        nested.some((c) => !['ALPH', 'VP8 ', 'VP8L'].includes(c.type)) ||
        nested.filter((c) => c.type === 'ALPH').length > 1 ||
        (nested.some((c) => c.type === 'ALPH') && (nested[0]?.type !== 'ALPH' || images[0]!.type !== 'VP8 '))
      )
        return fail();
      const actual = webpSize(images[0]!);
      if (actual.width !== width || actual.height !== height) return fail();
      seenImage = true;
    }
    if (['VP8 ', 'VP8L'].includes(chunk.type)) seenImage = true;
  }
  const orientation = direction(explicit, exif),
    hasOrientation = orientation !== undefined && orientation !== 1;
  const kept = chunks
    .filter((c) => ['VP8X', 'ICCP', 'ANIM', 'ANMF', 'ALPH', 'VP8 ', 'VP8L'].includes(c.type))
    .map((c) => c.bytes);
  if (extended) {
    const payload = Buffer.from(extended.payload);
    payload[0] = (payload[0]! & ~0x0c) | (hasOrientation ? 8 : 0);
    kept[0] = riffChunk('VP8X', payload);
  } else if (hasOrientation) {
    const payload = Buffer.alloc(10);
    payload[0] = 8 | (size.alpha ? 0x10 : 0);
    payload.writeUIntLE(size.width - 1, 4, 3);
    payload.writeUIntLE(size.height - 1, 7, 3);
    kept.unshift(riffChunk('VP8X', payload));
  }
  if (hasOrientation) kept.push(riffChunk('EXIF', orientationExif(orientation!, true)));
  const body = Buffer.concat(kept),
    header = Buffer.from('RIFF\0\0\0\0WEBP');
  header.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([header, body]);
}
export function stripMetadata(input: Buffer, format: MetadataImageFormat, orientation?: number): Buffer {
  if (format === 'jpeg') return jpeg(input, orientation);
  if (format === 'png') return png(input, orientation);
  if (format === 'webp') return webp(input, orientation);
  return fail();
}
