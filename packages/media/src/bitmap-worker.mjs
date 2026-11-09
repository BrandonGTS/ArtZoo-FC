// Standalone ESM worker: usable from source loaders and emitted unchanged by tsc.
import { parentPort, workerData } from 'node:worker_threads';
import sharp from 'sharp';

function invalid(code) {
  throw Object.assign(new Error('Invalid bitmap'), { bitmapCode: code });
}
async function decodeBitmap(input, maxPixels) {
  // Preserve the existing uncompressed Windows 24/32-bit decoder and RGB semantics.
  if (
    input.length < 54 ||
    input.readUInt32LE(14) < 40 ||
    input.readUInt16LE(26) !== 1 ||
    input.readUInt32LE(30) !== 0
  )
    invalid('ENCODING');
  const width = input.readInt32LE(18),
    signedHeight = input.readInt32LE(22),
    height = Math.abs(signedHeight),
    bits = input.readUInt16LE(28),
    offset = input.readUInt32LE(10);
  if (width <= 0 || !height || width * height > maxPixels || ![24, 32].includes(bits) || offset < 54)
    invalid('DIMENSIONS');
  const stride = Math.ceil((width * bits) / 32) * 4;
  if (offset + stride * height > input.length) invalid('INCOMPLETE');
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from = offset + (signedHeight > 0 ? height - 1 - y : y) * stride + (x * bits) / 8,
        to = (y * width + x) * 3;
      pixels[to] = input[from + 2];
      pixels[to + 1] = input[from + 1];
      pixels[to + 2] = input[from];
    }
  // No BMP/PPM libvips loader. Alpha bytes remain ignored, exactly as before.
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

if (parentPort) {
  try {
    const input = Buffer.from(workerData.input),
      output = await decodeBitmap(input, workerData.maxPixels);
    // Transfer a dedicated allocation, never a pooled Buffer's unrelated backing bytes.
    const bytes = Uint8Array.from(output);
    parentPort.postMessage({ ok: true, output: bytes }, [bytes.buffer]);
  } catch (error) {
    parentPort.postMessage({ ok: false, code: error?.bitmapCode ?? 'DECODE' });
  } finally {
    parentPort.close();
  }
}
