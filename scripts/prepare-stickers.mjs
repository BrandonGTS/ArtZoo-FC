import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const sharp = createRequire(join(root, 'apps/web/package.json'))('sharp');
sharp.concurrency(1);
const source = join(root, 'assets/stickers/rsemojivol1'),
  out = join(root, 'apps/web/public/artzoo/optimized/stickers');
const hash = (b) => createHash('sha256').update(b).digest('hex');
await mkdir(out, { recursive: true });
const manifest = [];
for (const name of (await readdir(source)).sort((a, b) => parseInt(a) - parseInt(b))) {
  if (!/^\d+[^/\\]*\.png$/.test(name)) throw Error('Unexpected sticker source');
  const input = await readFile(join(source, name)),
    meta = await sharp(input).metadata();
  if (meta.width !== 290 || meta.height !== 346 || meta.channels !== 4 || (meta.pages ?? 1) !== 1)
    throw Error('Invalid sticker source');
  const bytes = await sharp(input).webp({ lossless: true, effort: 6 }).toBuffer();
  const original = await sharp(input).raw().toBuffer(),
    decoded = await sharp(bytes).raw().toBuffer();
  // Lossless WebP may normalize invisible RGB; every visible channel and all alpha must match.
  for (let i = 0; i < original.length; i += 4) {
    if (
      original[i + 3] !== decoded[i + 3] ||
      (original[i + 3] && ![0, 1, 2].every((c) => original[i + c] === decoded[i + c]))
    )
      throw Error('Visible pixel mismatch');
  }
  const id = String(parseInt(name)).padStart(2, '0'),
    sha256 = hash(bytes),
    url = `/artzoo/optimized/stickers/rs1-${id}.${sha256.slice(0, 16)}.webp`;
  await writeFile(join(root, 'apps/web/public', url), bytes);
  manifest.push({
    id,
    label: name.replace(/^\d+|\.png$/g, ''),
    url,
    width: 290,
    height: 346,
    source: name,
    originalSha256: hash(input),
    sha256,
    originalBytes: input.length,
    bytes: bytes.length
  });
}
if (manifest.length !== 29 || new Set(manifest.map((x) => x.id)).size !== 29)
  throw Error('Sticker inventory mismatch');
await writeFile(
  join(root, 'apps/web/components/stickers/manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);
console.log(
  JSON.stringify({
    count: manifest.length,
    originalBytes: manifest.reduce((s, x) => s + x.originalBytes, 0),
    bytes: manifest.reduce((s, x) => s + x.bytes, 0),
    visiblePixels: 'exact',
    alpha: 'exact'
  })
);
