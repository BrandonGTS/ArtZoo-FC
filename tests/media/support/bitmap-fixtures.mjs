export function bmp({ width = 3, height = 2, bits = 24, topDown = false } = {}) {
  const stride = Math.ceil((width * bits) / 32) * 4,
    input = Buffer.alloc(54 + stride * height, 0x7d);
  input.fill(0, 0, 54); // Valid BI_RGB header; pixel/padding/alpha patterns remain unchanged.
  input.write('BM');
  input.writeUInt32LE(input.length, 2);
  input.writeUInt32LE(54, 10);
  input.writeUInt32LE(40, 14);
  input.writeInt32LE(width, 18);
  input.writeInt32LE(topDown ? -height : height, 22);
  input.writeUInt16LE(1, 26);
  input.writeUInt16LE(bits, 28);
  input.writeUInt32LE(0, 30);
  const expected = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const rgb = [(x * 37 + y * 71) % 256, (x * 61 + y * 17) % 256, (x * 13 + y * 101) % 256],
        at = 54 + (topDown ? y : height - 1 - y) * stride + (x * bits) / 8;
      input[at] = rgb[2];
      input[at + 1] = rgb[1];
      input[at + 2] = rgb[0];
      if (bits === 32) input[at + 3] = (x + y) % 2 ? 0 : 255;
      expected.set(rgb, (y * width + x) * 3);
    }
  return { input, expected };
}
