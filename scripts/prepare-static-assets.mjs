import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  normalizeUnicodeRanges,
  subtractUnicodeRanges,
  unicodeSet,
  mergeUnicodeIntervals
} from './static-asset-utils.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)),
  web = join(root, 'apps/web');
const sharp = createRequire(join(web, 'package.json'))('sharp');
sharp.concurrency(1);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const save = async (path, bytes) => {
  try {
    if ((await readFile(path)).equals(Buffer.from(bytes))) return;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await writeFile(path, bytes);
};
const sources = {
  'paper-texture': 'assets/source/artzoo/paper-texture.png',
  'login-paper': 'components/account/assets/login-paper.png',
  'register-paper': 'components/account/assets/register-paper.png',
  'profile-paper': 'components/members/assets/profile-paper.png',
  'directory-paper': 'components/members/assets/directory-paper.png',
  'album-preview-paper': 'assets/source/artzoo/albums/preview-paper.png',
  'album-upload-paper': 'assets/source/artzoo/albums/upload-paper.png',
  'knowledge-history-paper': 'assets/source/artzoo/knowledge/history-paper.png',
  'team-left': 'assets/source/artzoo/teams/1-img74.png',
  'team-right': 'assets/source/artzoo/teams/1-img75.png',
  'team-session': 'assets/source/artzoo/teams/1-img3.png',
  'team-seat': 'assets/source/artzoo/teams/1-img.png',
  'album-card': 'assets/source/artzoo/albums/card-paper.png'
};
const internalSourcePaths = new Set([
  'assets/source/artzoo/albums/card-paper.png',
  'assets/source/artzoo/albums/preview-paper.png',
  'assets/source/artzoo/albums/upload-paper.png',
  'assets/source/artzoo/knowledge/history-paper.png',
  'assets/source/artzoo/paper-texture.png',
  'assets/source/artzoo/teams/1-img.png',
  'assets/source/artzoo/teams/1-img3.png',
  'assets/source/artzoo/teams/1-img74.png',
  'assets/source/artzoo/teams/1-img75.png'
]);
async function readSource(source) {
  if (!source.startsWith('assets/')) return readFile(join(web, source));
  if (!internalSourcePaths.has(source)) throw new Error('Internal source path is not approved');
  let current = root;
  for (const part of source.split('/')) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Refuse internal source symlink');
    if (current === join(root, source) && !stat.isFile())
      throw new Error('Internal source must be regular PNG');
  }
  const bytes = await readFile(current);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('Internal source must be PNG');
  return bytes;
}
const defaultEncodingKey = 'webp-q78-alpha100-effort5-smart-v1';
let previous = {};
try {
  previous = JSON.parse(await readFile(join(web, 'static-assets.json'), 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
await mkdir(join(web, 'public/artzoo/optimized'), { recursive: true });
const backgrounds = {};
for (const [name, source] of Object.entries(sources)) {
  const lossless = name === 'directory-paper';
  const encodingKey = lossless ? 'webp-lossless-effort6-v1' : defaultEncodingKey;
  const input = await readSource(source),
    originalSha256 = hash(input),
    cached = previous.backgrounds?.[name];
  let bytes;
  if (cached?.originalSha256 === originalSha256 && cached.encodingKey === encodingKey) {
    bytes = await readFile(join(web, 'public', cached.url));
    if (hash(bytes) !== cached.sha256) throw Error('Background integrity mismatch: ' + name);
  }
  if (!bytes)
    bytes = await sharp(input)
      .keepMetadata()
      .webp(
        lossless
          ? { lossless: true, effort: 6 }
          : { quality: 78, alphaQuality: 100, effort: 5, smartSubsample: true }
      )
      .toBuffer();
  const sha256 = hash(bytes),
    url = '/artzoo/optimized/' + name + '.' + sha256.slice(0, 16) + '.webp';
  await save(join(web, 'public', url), bytes);
  backgrounds[name] = {
    source,
    originalSha256,
    sha256,
    url,
    originalBytes: input.length,
    bytes: bytes.length,
    encodingKey
  };
}
// Retain the prior 1080px/q75 rendering without double-encoding a new lossy input.
const paperInput = await readSource(sources['paper-texture']);
let referenceBytes;
const reference = previous.losslessPaperReference;
if (reference?.originalSha256 === hash(paperInput)) {
  referenceBytes = await readFile(join(web, 'public', reference.url));
  if (hash(referenceBytes) !== reference.sha256) throw Error('Paper reference integrity mismatch');
} else referenceBytes = await sharp(paperInput).keepMetadata().webp({ lossless: true, effort: 6 }).toBuffer();
const referenceSha = hash(referenceBytes),
  referenceUrl = '/artzoo/optimized/paper-texture.' + referenceSha.slice(0, 16) + '.webp';
await save(join(web, 'public', referenceUrl), referenceBytes);
const losslessPaperReference = {
  originalSha256: hash(paperInput),
  sha256: referenceSha,
  url: referenceUrl,
  bytes: referenceBytes.length
};
const paper = await sharp(referenceBytes)
  .autoOrient()
  .resize({ width: 1080, withoutEnlargement: true })
  .webp({ quality: 75 })
  .toBuffer();
const paperSha = hash(paper),
  paperUrl = '/artzoo/optimized/paper-rendered.' + paperSha.slice(0, 16) + '.webp';
await save(join(web, 'public', paperUrl), paper);
const fontRoot = join(web, 'public/artzoo/fonts');
const originals = await Promise.all(
  ['DymonShouXieTi.css', 'Xiaolai.css'].map(async (name) => ({
    name,
    css: await readFile(join(fontRoot, name), 'utf8')
  }))
);
const fontNames = [
  ...new Set([
    'PatrickHand-Regular.woff2',
    ...originals.flatMap(({ css }) =>
      [...css.matchAll(/url\(["']\.\/([^"']+\.woff2)["']\)/g)].map((m) => m[1])
    )
  ])
].sort();
const fontHashes = await Promise.all(
  fontNames.map(async (name) => [name, hash(await readFile(join(fontRoot, name)))])
);
// Keep unchanged font binary addresses warm. Stylesheets receive their own content hashes.
const fontVersion = hash(JSON.stringify([fontHashes, originals])).slice(0, 20);
const core = JSON.parse(await readFile(join(fontRoot, 'ui-core/manifest.json'), 'utf8'));
const extended = JSON.parse(await readFile(join(fontRoot, 'ui-core/extended-manifest.json'), 'utf8'));
const uiSubsets = [core, extended],
  uiCodepoints = new Set();
for (const item of uiSubsets) {
  if (item.sourceCssSha256 !== hash(await readFile(join(fontRoot, 'Xiaolai.css'))))
    throw Error('UI font source changed; regenerate the subset');
  for (const [file, expected] of Object.entries(item.sourceFontSha256))
    if (Object.fromEntries(fontHashes)[file] !== expected) throw Error('UI font source changed: ' + file);
  if (hash(await readFile(join(fontRoot, item.file))) !== item.sha256)
    throw Error('UI font integrity mismatch: ' + item.file);
  for (const point of item.codepoints) {
    if (uiCodepoints.has(point)) throw Error('Overlapping UI font subsets');
    uiCodepoints.add(point);
  }
}
const stylesheets = [],
  stylesheetMetadata = [];
for (const { name, css } of originals) {
  const before = new Set(),
    after = new Set();
  let generated = css.replace(/@font-face\s*\{[^}]+\}/g, (face) => {
    const found = face.match(/unicode-range\s*:\s*([^;}]+)/);
    if (!found) throw Error('Font face missing Unicode range');
    for (const p of unicodeSet(found[1])) before.add(p);
    const range =
      name === 'Xiaolai.css'
        ? subtractUnicodeRanges(found[1], [...uiCodepoints])
        : normalizeUnicodeRanges(found[1]);
    if (!range) return '';
    for (const p of unicodeSet(range)) {
      if (after.has(p)) throw Error('Overlapping font coverage');
      after.add(p);
    }
    return face.replace(found[1], range);
  });
  if (name === 'Xiaolai.css') {
    for (const p of uiCodepoints) {
      if (!before.has(p) || after.has(p)) throw Error('Invalid UI font coverage');
      after.add(p);
    }
    for (const item of uiSubsets) {
      const range = mergeUnicodeIntervals(item.codepoints.map((p) => [p, p]));
      generated +=
        "\n@font-face{font-family:'Xiaolai';font-style:normal;font-weight:400;font-display:swap;src:url('./" +
        item.file +
        "') format('woff2');unicode-range:" +
        range +
        ';}\n';
    }
  }
  if (before.size !== after.size || [...before].some((p) => !after.has(p)))
    throw Error('Font coverage changed');
  generated = generated.replace(/(\.woff2)(?=["']\))/g, '$1?v=' + fontVersion);
  const sha256 = hash(generated),
    generatedName = name.replace('.css', '.' + sha256.slice(0, 16) + '.css');
  await save(join(fontRoot, generatedName), generated);
  const url = '/artzoo/fonts/' + generatedName + '?v=' + fontVersion;
  stylesheets.push(url);
  stylesheetMetadata.push({
    source: name,
    url,
    sha256,
    originalBytes: Buffer.byteLength(css),
    bytes: Buffer.byteLength(generated),
    codepoints: before.size
  });
}
const vars = Object.entries(backgrounds).map(
  ([name, value]) => '  --artzoo-bg-' + name + ': url("' + value.url + '");'
);
vars.push('  --artzoo-bg-paper-optimized: url("' + paperUrl + '");');
const generatedCss =
  "/* Generated static resources. Original assets remain available. */\n@font-face{font-family:'Patrick Hand';src:url('/artzoo/fonts/PatrickHand-Regular.woff2?v=" +
  fontVersion +
  "') format('woff2');font-style:normal;font-weight:400;font-display:swap;unicode-range:U+0000-2E7F;}\n:root{\n" +
  vars.join('\n') +
  '\n}\n';
await save(join(web, 'app/static-assets.css'), generatedCss);
await save(
  join(web, 'static-assets.json'),
  JSON.stringify(
    {
      fontVersion,
      fontCount: fontNames.length,
      fontHashes: Object.fromEntries(fontHashes),
      stylesheets,
      stylesheetMetadata,
      uiCoreFont: {
        file: core.file,
        sha256: core.sha256,
        bytes: core.bytes,
        codepoints: core.codepoints.length
      },
      uiExtendedFont: {
        file: extended.file,
        sha256: extended.sha256,
        bytes: extended.bytes,
        codepoints: extended.codepoints.length
      },
      backgrounds,
      losslessPaperReference,
      renderedPaper: { url: paperUrl, sha256: paperSha, bytes: paper.length, width: 1080, quality: 75 }
    },
    null,
    2
  ) + '\n'
);
console.log(
  JSON.stringify({
    backgrounds: Object.keys(backgrounds).length,
    backgroundBytes: Object.values(backgrounds).reduce((n, x) => n + x.bytes, 0),
    fontsUnchanged: fontNames.length,
    uiCoreBytes: core.bytes,
    fontVersion,
    stylesheetBytes: stylesheetMetadata.map((x) => x.bytes),
    renderedPaperBytes: paper.length
  })
);
