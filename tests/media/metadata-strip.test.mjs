import { deflateSync, inflateSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { stripMetadata, readExifOrientation } from '../../packages/media/src/metadata-strip.ts';
import {
  SECRET,
  richExif,
  dirtyJpeg,
  dirtyPng,
  dirtyWebp,
  jpegChunk,
  jpegHeaders,
  pngChunk,
  pngChunks,
  riffChunk,
  riff,
  webpChunks
} from './support/metadata-fixtures.mjs';
const require = createRequire(new URL('../../packages/media/package.json', import.meta.url)),
  sharp = require('sharp');
const width = 7,
  height = 5,
  raw = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++)
    raw.set([x * 32, y * 48, (x + y) * 17, (x + y) % 2 ? 128 : 255], (y * width + x) * 4);
async function image(format, options = {}) {
  return sharp(raw, { raw: { width, height, channels: 4 } })
    .withMetadata({ orientation: 6 })
    .toFormat(format, { ...options })
    .toBuffer();
}
async function pixels(input, orient = false, animated = false) {
  const pipeline = sharp(input, { animated });
  if (orient) pipeline.autoOrient();
  return pipeline.raw().toBuffer({ resolveWithObject: true });
}
async function equalPixels(a, b, orient = false, animated = false) {
  const x = await pixels(a, orient, animated),
    y = await pixels(b, orient, animated);
  assert.equal(y.info.width, x.info.width);
  assert.equal(y.info.height, x.info.height);
  assert.equal(y.info.channels, x.info.channels);
  assert.deepEqual(y.data, x.data);
}
for (const format of ['jpeg', 'png', 'webp'])
  test(`${format}: clears GPS/XMP/IPTC/serial, preserves raw pixels, visual orientation and ICC`, async () => {
    const encoded = await image(
        format,
        format === 'jpeg' ? { progressive: true } : format === 'webp' ? { lossless: true } : {}
      ),
      dirty = { jpeg: dirtyJpeg, png: dirtyPng, webp: dirtyWebp }[format](encoded),
      before = Buffer.from(dirty),
      clean = stripMetadata(dirty, format);
    assert.deepEqual(dirty, before);
    assert.ok(!clean.includes(Buffer.from(SECRET)));
    assert.ok(!clean.includes(Buffer.from('SERIAL!!')));
    await equalPixels(dirty, clean);
    await equalPixels(dirty, clean, true);
    const a = await sharp(dirty).metadata(),
      b = await sharp(clean).metadata();
    assert.equal(b.orientation, 6);
    assert.deepEqual(b.icc, a.icc);
    assert.ok(b.icc?.length > 0);
    assert.ok(b.exif.length <= 32);
    assert.equal(readExifOrientation(b.exif), 6);
    const twice = stripMetadata(clean, format);
    assert.deepEqual(twice, clean);
  });
test('Exif little/big endian, naked payload and direction1..8; malformed and duplicate orientation rejected', () => {
  for (const little of [false, true])
    for (let n = 1; n <= 8; n++) {
      assert.equal(readExifOrientation(richExif(n, little)), n);
      assert.equal(readExifOrientation(richExif(n, little).subarray(6)), n);
    }
  const mutations = [
    (b) => b.subarray(0, 12),
    (b) => {
      b.writeUInt32LE(0xfffffffe, 10);
      return b;
    },
    (b) => {
      b.writeUInt16LE(65535, 14);
      return b;
    },
    (b) => {
      b.writeUInt16LE(9, 24);
      return b;
    },
    (b) => {
      b.writeUInt16LE(0x112, 28);
      return b;
    },
    (b) => {
      b.writeUInt32LE(0xffffffff, 36);
      return b;
    }
  ];
  for (const mutate of mutations) assert.throws(() => readExifOrientation(mutate(richExif())));
});
for (const format of ['jpeg', 'png', 'webp'])
  test(`${format}: explicit orientation takes priority; orientation1 omits Exif; invalid explicit rejects`, async () => {
    const source = { jpeg: dirtyJpeg, png: dirtyPng, webp: dirtyWebp }[format](await image(format), 6);
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const clean = stripMetadata(source, format, orientation),
        metadata = await sharp(clean).metadata();
      assert.equal(metadata.orientation, orientation === 1 ? undefined : orientation);
      await equalPixels(source, clean);
    }
    for (const n of [0, 9, 1.5, NaN]) assert.throws(() => stripMetadata(source, format, n));
  });
test('JPEG progressive multi-scan entropy survives; embedded marker byte patterns are not scanned as metadata', async () => {
  const source = dirtyJpeg(await image('jpeg', { progressive: true })),
    clean = stripMetadata(source, 'jpeg');
  await equalPixels(source, clean);
  // Valid synthetic minimal structure exercises stuffed FF/E1, restart, TEM, multiple scans and inter-scan APP13.
  const sof = jpegChunk(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    sos = jpegChunk(0xda, Buffer.from([1, 1, 0, 0, 63, 0]));
  const entropy = Buffer.from([1, 255, 0, 0xe1, 2, 255, 0xd0, 3, 255, 1, 4]);
  const fixture = Buffer.concat([
    Buffer.from([255, 216]),
    sof,
    sos,
    entropy,
    jpegChunk(0xed, Buffer.from(SECRET)),
    sos,
    entropy,
    Buffer.from([255, 217])
  ]);
  const out = stripMetadata(fixture, 'jpeg', 1);
  assert.equal(out.indexOf(entropy), fixture.indexOf(entropy));
  assert.equal(out.lastIndexOf(entropy) - out.indexOf(entropy), entropy.length + sos.length);
  assert.ok(!out.includes(Buffer.from(SECRET)));
});
test('JPEG APP2 ICC and MPF payloads retained byte-for-byte; trailing second frame rejected for MPO owner', async () => {
  const source = await image('jpeg'),
    extra = jpegChunk(0xe2, Buffer.from('MPF\0SYNTHETIC-INDEX')),
    fixture = Buffer.concat([source.subarray(0, 2), extra, source.subarray(2)]),
    out = stripMetadata(fixture, 'jpeg');
  assert.deepEqual(
    jpegHeaders(out)
      .filter((c) => c.marker === 0xe2)
      .map((c) => c.payload),
    jpegHeaders(fixture)
      .filter((c) => c.marker === 0xe2)
      .map((c) => c.payload)
  );
  assert.throws(() => stripMetadata(Buffer.concat([source, source]), 'jpeg'));
});
for (const format of ['jpeg', 'png', 'webp'])
  test(`${format}: truncation, trailing bytes, length overflow and duplicate Exif fail closed`, async () => {
    const source = { jpeg: dirtyJpeg, png: dirtyPng, webp: dirtyWebp }[format](await image(format));
    for (const cut of [0, 2, 8, source.length - 1])
      assert.throws(() => stripMetadata(source.subarray(0, cut), format));
    assert.throws(() => stripMetadata(Buffer.concat([source, Buffer.from([1])]), format));
    if (format === 'jpeg') {
      const duplicate = Buffer.concat([
        source.subarray(0, 2),
        jpegChunk(0xe1, richExif()),
        source.subarray(2)
      ]);
      assert.throws(() => stripMetadata(duplicate, format, 6));
      const bad = Buffer.from(source);
      bad.writeUInt16BE(65535, 4);
      assert.throws(() => stripMetadata(bad, format));
    }
    if (format === 'png') {
      const chunks = pngChunks(source),
        duplicate = Buffer.concat([
          source.subarray(0, 8),
          chunks[0].bytes,
          pngChunk('eXIf', richExif().subarray(6)),
          ...chunks.slice(1).map((c) => c.bytes)
        ]);
      assert.throws(() => stripMetadata(duplicate, format));
      const bad = Buffer.from(source);
      bad.writeUInt32BE(0xffffffff, 8);
      assert.throws(() => stripMetadata(bad, format));
      const crc = Buffer.from(source);
      crc[crc.length - 1] ^= 1;
      assert.throws(() => stripMetadata(crc, format));
    }
    if (format === 'webp') {
      const chunks = webpChunks(source);
      assert.throws(() =>
        stripMetadata(riff([...chunks.map((c) => c.bytes), riffChunk('EXIF', richExif())]), format)
      );
      const bad = Buffer.from(source);
      bad.writeUInt32LE(0xffffffff, 16);
      assert.throws(() => stripMetadata(bad, format));
    }
  });
test('PNG CRC validates removed/private metadata; unknown critical chunks, duplicate IHDR and noncontiguous IDAT reject', async () => {
  const input = await image('png'),
    chunks = pngChunks(input),
    header = chunks[0].bytes,
    tail = chunks.slice(1).map((c) => c.bytes);
  assert.throws(() =>
    stripMetadata(
      Buffer.concat([input.subarray(0, 8), header, pngChunk('ABCD', Buffer.from('x')), ...tail]),
      'png'
    )
  );
  assert.throws(() => stripMetadata(Buffer.concat([input.subarray(0, 8), header, header, ...tail]), 'png'));
  const dirty = dirtyPng(input),
    bad = Buffer.from(dirty),
    at = bad.indexOf(Buffer.from('tEXt'));
  bad[at + 4] ^= 1;
  assert.throws(() => stripMetadata(bad, 'png'));
  const idat = chunks.find((c) => c.type === 'IDAT');
  assert.throws(() =>
    stripMetadata(
      Buffer.concat([
        input.subarray(0, 8),
        header,
        idat.bytes,
        pngChunk('tEXt', Buffer.from('x\0x')),
        idat.bytes,
        chunks.at(-1).bytes
      ]),
      'png'
    )
  );
});
test('WebP simple VP8/VP8L gains minimal VP8X orientation without changing alpha pixels', async () => {
  for (const lossless of [false, true]) {
    const input = await sharp(raw, { raw: { width, height, channels: 4 } })
      .toFormat('webp', { lossless })
      .toBuffer();
    const out = stripMetadata(input, 'webp', 6);
    await equalPixels(input, out);
    assert.equal((await sharp(out).metadata()).orientation, 6);
  }
});
test('WebP animation encoded frames/loop/delays/alpha/ICC preserved byte-for-byte', async () => {
  const frames = Buffer.concat([raw, Buffer.from(raw).map((x, i) => (i % 4 === 3 ? x : 255 - x))]);
  const source = await sharp(frames, { raw: { width, height: height * 2, channels: 4, pageHeight: height } })
      .withMetadata({ orientation: 6 })
      .webp({ lossless: true, loop: 3, delay: [70, 110] })
      .toBuffer(),
    dirty = dirtyWebp(source),
    out = stripMetadata(dirty, 'webp');
  for (const type of ['ICCP', 'ANIM', 'ANMF'])
    assert.deepEqual(
      webpChunks(out)
        .filter((c) => c.type === type)
        .map((c) => c.bytes),
      webpChunks(dirty)
        .filter((c) => c.type === type)
        .map((c) => c.bytes)
    );
  const a = await sharp(dirty, { animated: true }).metadata(),
    b = await sharp(out, { animated: true }).metadata();
  for (const key of ['pages', 'pageHeight', 'loop', 'delay', 'hasAlpha']) assert.deepEqual(b[key], a[key]);
  assert.equal(b.pages, 2);
  assert.deepEqual(b.icc, a.icc);
  await equalPixels(dirty, out, false, true);
  assert.ok(!out.includes(Buffer.from(SECRET)));
  const flags = webpChunks(out)[0].payload[0];
  assert.equal(flags & 0x04, 0);
  assert.equal(flags & 0x08, 8);
  assert.equal(flags & 0x02, 2);
});

test('non-ASCII container/type/endian bytes never alias valid ASCII signatures', async () => {
  const exif = richExif();
  exif[6] |= 0x80;
  assert.throws(() => readExifOrientation(exif));
  const png = await image('png'),
    chunks = pngChunks(png),
    forged = pngChunk('IHDR', chunks[0].payload);
  forged[4] |= 0x80;
  // Repair CRC so this exercises the chunk-name check, not a checksum rejection.
  const { crc } = await import('./support/metadata-fixtures.mjs');
  forged.writeUInt32BE(crc(forged.subarray(4, -4)), forged.length - 4);
  assert.throws(() =>
    stripMetadata(Buffer.concat([png.subarray(0, 8), forged, ...chunks.slice(1).map((c) => c.bytes)]), 'png')
  );
  const webp = await image('webp');
  webp[0] |= 0x80;
  assert.throws(() => stripMetadata(webp, 'webp'));
});

for (const format of ['jpeg', 'png', 'webp'])
  test(`${format}: excessive tiny container fragments fail within bounded input`, async () => {
    const source = await image(format);
    let fragmented;
    if (format === 'jpeg')
      fragmented = Buffer.concat([
        source.subarray(0, 2),
        ...Array(16_385).fill(jpegChunk(0xe2, Buffer.alloc(0))),
        source.subarray(2)
      ]);
    if (format === 'png') {
      const chunks = pngChunks(source);
      fragmented = Buffer.concat([
        source.subarray(0, 8),
        chunks[0].bytes,
        ...Array(16_385).fill(pngChunk('tEXt', Buffer.from('x\0x'))),
        ...chunks.slice(1).map((c) => c.bytes)
      ]);
    }
    if (format === 'webp') {
      const chunks = webpChunks(source);
      fragmented = riff([
        ...chunks.map((c) => c.bytes),
        ...Array(16_385).fill(riffChunk('PRIV', Buffer.alloc(0)))
      ]);
    }
    assert.ok(fragmented.length < 400_000, 'small fragmentation fixture, no OOM-sized sample');
    assert.throws(() => stripMetadata(fragmented, format), /fragmentation limit/);
  });
test('WebP applies the same fragmentation budget inside animation frames', async () => {
  const frames = Buffer.concat([raw, Buffer.from(raw).map((x, i) => (i % 4 === 3 ? x : 255 - x))]);
  const source = await sharp(frames, { raw: { width, height: height * 2, channels: 4, pageHeight: height } })
    .withMetadata()
    .webp({ lossless: true, delay: [70, 110] })
    .toBuffer();
  const chunks = webpChunks(source),
    frame = chunks.find((c) => c.type === 'ANMF');
  const payload = Buffer.concat([frame.payload, ...Array(16_384).fill(riffChunk('PRIV', Buffer.alloc(0)))]);
  const fragmented = riff(chunks.map((c) => (c === frame ? riffChunk('ANMF', payload) : c.bytes)));
  assert.ok(fragmented.length < 400_000);
  assert.throws(() => stripMetadata(fragmented, 'webp'), /fragmentation limit/);
});

function pngWithChunks(source, replacements) {
  const names = new Set(replacements.map(([type]) => type)),
    chunks = pngChunks(source).filter((c) => !names.has(c.type));
  return Buffer.concat([
    source.subarray(0, 8),
    chunks[0].bytes,
    ...replacements.map(([type, payload]) => pngChunk(type, payload)),
    ...chunks.slice(1).map((c) => c.bytes)
  ]);
}
test('PNG decodable malformed retained chunks cannot carry private payloads', async () => {
  const source = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } })
    .png()
    .toBuffer();
  const marker = Buffer.from('synthetic-private-marker');
  for (const type of [
    'pHYs',
    'gAMA',
    'sRGB',
    'bKGD',
    'cICP',
    'cHRM',
    'sBIT',
    'mDCV',
    'cLLI',
    'tRNS',
    'iCCP'
  ]) {
    const bad = pngWithChunks(source, [[type, marker]]);
    assert.ok(bad.length < 200);
    // Independent decoder acceptance is the regression: outer Sharp validation alone is insufficient.
    await sharp(bad, { failOn: 'warning' }).raw().toBuffer();
    assert.throws(() => stripMetadata(bad, 'png'), undefined, `must reject malformed ${type}`);
  }
});
test('PNG same-length invalid numeric values and color-dependent chunks reject', async () => {
  const rgb = await sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  const bads = [
    ['pHYs', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 2])],
    ['gAMA', Buffer.alloc(4)],
    ['sRGB', Buffer.from([4])],
    ['sBIT', Buffer.from([9, 8, 8, 8])],
    ['bKGD', Buffer.from([1, 0, 0, 0, 0, 0])],
    ['tRNS', Buffer.alloc(6)],
    ['cICP', Buffer.from([9, 16, 1, 1])],
    ['cICP', Buffer.from([0, 16, 0, 1])],
    ['cLLI', Buffer.from([0, 0, 0, 1, 0, 0, 0, 2])]
  ];
  const chroma = Buffer.alloc(32);
  chroma.writeUInt32BE(100001);
  bads.push(['cHRM', chroma]);
  const mastering = Buffer.alloc(24);
  mastering.writeUInt16BE(50001);
  bads.push(['mDCV', mastering]);
  for (const [type, payload] of bads)
    assert.throws(() => stripMetadata(pngWithChunks(rgb, [[type, payload]]), 'png'), undefined, type);
  const chunks = pngChunks(rgb),
    header = Buffer.from(chunks[0].payload);
  header[8] = 3;
  assert.throws(() => stripMetadata(pngWithChunks(rgb, [['IHDR', header]]), 'png'));
});
test('PNG legal color and density chunks retain payloads, decoded pixels and ICC', async () => {
  const source = await image('png'),
    payloads = [];
  const gamma = Buffer.alloc(4);
  gamma.writeUInt32BE(45455);
  payloads.push(['gAMA', gamma]);
  const chroma = Buffer.alloc(32);
  [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000].forEach((v, i) => chroma.writeUInt32BE(v, i * 4));
  payloads.push(['cHRM', chroma]);
  payloads.push(
    ['sBIT', Buffer.from([8, 8, 8, 8])],
    ['bKGD', Buffer.from([0, 8, 0, 16, 0, 32])],
    ['pHYs', Buffer.from([0, 0, 14, 196, 0, 0, 14, 196, 1])],
    ['cICP', Buffer.from([9, 16, 0, 1])]
  );
  const mastering = Buffer.alloc(24);
  [35400, 14600, 8500, 39850, 6550, 2300, 15635, 16450].forEach((v, i) => mastering.writeUInt16BE(v, i * 2));
  mastering.writeUInt32BE(40000000, 16);
  mastering.writeUInt32BE(5, 20);
  payloads.push(['mDCV', mastering]);
  const light = Buffer.alloc(8);
  light.writeUInt32BE(10000000);
  light.writeUInt32BE(2500000, 4);
  payloads.push(['cLLI', light]);
  // Keep mDCV preceding cICP too: PNG requires accompaniment, not an order between these two.
  const ordered = [payloads.find(([t]) => t === 'mDCV'), ...payloads.filter(([t]) => t !== 'mDCV')];
  const input = pngWithChunks(source, ordered),
    out = stripMetadata(input, 'png');
  for (const [type, payload] of ordered)
    assert.deepEqual(pngChunks(out).find((c) => c.type === type).payload, payload);
  assert.deepEqual((await sharp(out).metadata()).icc, (await sharp(source).metadata()).icc);
  await equalPixels(input, out);
  await equalPixels(input, out, true);
  const noProfile = await sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  const srgb = pngWithChunks(noProfile, [['sRGB', Buffer.from([0])]]);
  assert.deepEqual(
    pngChunks(stripMetadata(srgb, 'png')).find((c) => c.type === 'sRGB').payload,
    Buffer.from([0])
  );
});
test('PNG palette, transparency, gray/RGB sample bounds are checked without changing valid pixels', async () => {
  for (const source of [
    await sharp(raw, { raw: { width, height, channels: 4 } })
      .png({ palette: true, colours: 16 })
      .toBuffer(),
    await sharp(raw, { raw: { width, height, channels: 4 } })
      .greyscale()
      .png()
      .toBuffer()
  ]) {
    const out = stripMetadata(source, 'png');
    await equalPixels(source, out);
  }
  const palette = await sharp(raw, { raw: { width, height, channels: 4 } })
      .png({ palette: true, colours: 16 })
      .toBuffer(),
    size = pngChunks(palette).find((c) => c.type === 'PLTE').payload.length / 3;
  assert.throws(() => stripMetadata(pngWithChunks(palette, [['bKGD', Buffer.from([size])]]), 'png'));
  assert.throws(() => stripMetadata(pngWithChunks(palette, [['tRNS', Buffer.alloc(size + 1)]]), 'png'));
  const chunks = pngChunks(palette),
    withoutPalette = Buffer.concat([
      palette.subarray(0, 8),
      ...chunks.filter((c) => c.type !== 'PLTE').map((c) => c.bytes)
    ]);
  assert.throws(() => stripMetadata(withoutPalette, 'png'));
});
test('PNG ICC validates wrapper, bounded stream, profile header/tag ranges and strips identifying wrapper name', async () => {
  const source = await image('png'),
    original = pngChunks(source).find((c) => c.type === 'iCCP').payload,
    end = original.indexOf(0),
    compressed = original.subarray(end + 2),
    profile = inflateSync(compressed);
  const renamed = pngWithChunks(source, [
      ['iCCP', Buffer.concat([Buffer.from('synthetic-private-marker\0\0'), compressed])]
    ]),
    clean = stripMetadata(renamed, 'png');
  assert.ok(!clean.includes(Buffer.from('synthetic-private-marker')));
  assert.deepEqual((await sharp(clean).metadata()).icc, profile);
  const malformed = [
    Buffer.from('bad-name-only'),
    Buffer.concat([Buffer.from('ICC\0\x01'), compressed]),
    Buffer.concat([Buffer.from('ICC\0\0'), compressed, Buffer.from('private-trailing')])
  ];
  const badSize = Buffer.from(profile);
  badSize.writeUInt32BE(0xffffffff, 0);
  malformed.push(Buffer.concat([Buffer.from('ICC\0\0'), deflateSync(badSize)]));
  const badOffset = Buffer.from(profile);
  badOffset.writeUInt32BE(0xffffffff, 136);
  malformed.push(Buffer.concat([Buffer.from('ICC\0\0'), deflateSync(badOffset)]));
  const wrongSpace = Buffer.from(profile);
  wrongSpace.write('GRAY', 16);
  malformed.push(Buffer.concat([Buffer.from('ICC\0\0'), deflateSync(wrongSpace)]));
  for (const payload of malformed)
    assert.throws(() => stripMetadata(pngWithChunks(source, [['iCCP', payload]]), 'png'));
});

test('PNG legitimate grayscale, gray-alpha, RGB transparency and sixteen-bit colors stay lossless', async () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const color of [0, 4]) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0);
    header.writeUInt32BE(2, 4);
    header[8] = 8;
    header[9] = color;
    const scan =
      color === 0
        ? Buffer.from([0, 0, 255, 0, 128, 64])
        : Buffer.from([0, 0, 0, 255, 255, 0, 128, 255, 64, 128]);
    const chunks = [
      pngChunk('IHDR', header),
      pngChunk('sBIT', Buffer.from(color === 0 ? [8] : [8, 8])),
      pngChunk('bKGD', Buffer.from([0, 32]))
    ];
    if (color === 0) chunks.push(pngChunk('tRNS', Buffer.from([0, 128])));
    const image = Buffer.concat([
      signature,
      ...chunks,
      pngChunk('IDAT', deflateSync(scan)),
      pngChunk('IEND', Buffer.alloc(0))
    ]);
    const clean = stripMetadata(image, 'png');
    await equalPixels(image, clean);
    assert.equal(pngChunks(clean)[0].payload[9], color);
    if (color === 4)
      assert.throws(() => stripMetadata(pngWithChunks(image, [['tRNS', Buffer.from([0, 1])]]), 'png'));
    if (color === 0)
      assert.throws(() => stripMetadata(pngWithChunks(image, [['bKGD', Buffer.from([1, 0])]]), 'png'));
  }
  const rgb = await sharp(raw, { raw: { width, height, channels: 4 } })
    .removeAlpha()
    .png()
    .toBuffer();
  const transparent = pngWithChunks(rgb, [
    ['tRNS', Buffer.from([0, 0, 0, 0, 0, 0])],
    ['sBIT', Buffer.from([8, 8, 8])]
  ]);
  await equalPixels(transparent, stripMetadata(transparent, 'png'));
  const sixteen = await sharp(raw, { raw: { width, height, channels: 4 } })
    .removeAlpha()
    .toColourspace('rgb16')
    .png()
    .toBuffer();
  assert.equal(pngChunks(sixteen)[0].payload[8], 16);
  const input = pngWithChunks(sixteen, [
      ['bKGD', Buffer.from([255, 255, 18, 52, 128, 0])],
      ['sBIT', Buffer.from([16, 16, 16])]
    ]),
    out = stripMetadata(input, 'png');
  assert.deepEqual(
    pngChunks(out)
      .filter((c) => c.type === 'IDAT')
      .map((c) => c.bytes),
    pngChunks(input)
      .filter((c) => c.type === 'IDAT')
      .map((c) => c.bytes)
  );
  const a = await sharp(input).raw({ depth: 'ushort' }).toBuffer(),
    b = await sharp(out).raw({ depth: 'ushort' }).toBuffer();
  assert.deepEqual(a, b);
});
