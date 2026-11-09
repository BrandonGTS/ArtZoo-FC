import dns from 'node:dns';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import sharp from 'sharp';

const v4 = new BlockList(),
  v6 = new BlockList(),
  global6 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['168.63.129.16', 32]
] as const)
  v4.addSubnet(address, prefix, 'ipv4');
global6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3ffe::', 16],
  ['3fff::', 20],
  ['2620:4f:8000::', 48]
] as const)
  v6.addSubnet(address, prefix, 'ipv6');
export function publicIconAddress(address: string, family: number) {
  return (
    isIP(address) === family &&
    (family === 4
      ? !v4.check(address, 'ipv4')
      : family === 6 && global6.check(address, 'ipv6') && !v6.check(address, 'ipv6'))
  );
}
export function iconUrl(value: string) {
  const url = new URL(value),
    host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    /[\\\u0000-\u0020\u007f]/.test(value) ||
    (!isIP(host) && (!host.includes('.') || /\.(localhost|local|internal)$/i.test(host)))
  )
    throw Error('Icon URL rejected');
  if (isIP(host) && !publicIconAddress(host, isIP(host))) throw Error('Icon address rejected');
  url.hash = '';
  return url;
}
/** Saved-page queries are private by default. Only NGA's public board locator is needed. */
export function websitePageUrl(value: string) {
  const url = iconUrl(value),
    fids = url.searchParams.getAll('fid');
  url.search = '';
  if (
    url.hostname === 'bbs.nga.cn' &&
    url.pathname === '/thread.php' &&
    fids.length === 1 &&
    /^[+-]?\d{1,10}$/.test(fids[0]!)
  )
    url.searchParams.set('fid', fids[0]!);
  return url;
}
type Download = { bytes: Buffer; mime: string; contentType: string; url: string };
export interface IconNetwork {
  lookup: typeof dns.lookup;
  http: typeof http.request;
  https: typeof https.request;
}
const network: IconNetwork = { lookup: dns.lookup, http: http.request, https: https.request };
/** No proxy, cookies or shared agent. All DNS answers checked; the connector pins one checked IP. */
export async function downloadIconResource(
  value: string,
  limit: number,
  signal: AbortSignal,
  ports = network,
  redirects = 0,
  pageRequest = false
): Promise<Download> {
  signal.throwIfAborted();
  const url = pageRequest ? websitePageUrl(value) : iconUrl(value),
    host = url.hostname.replace(/^\[|\]$/g, '');
  const response = await new Promise<Download | { redirect: string }>((resolve, reject) => {
    let request: ClientRequest | undefined,
      incoming: IncomingMessage | undefined,
      settled = false;
    const finish = (error?: Error, result?: Download | { redirect: string }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) {
        incoming?.destroy();
        request?.destroy();
        reject(error);
      } else resolve(result!);
    };
    const fail = () => finish(Error('Icon download failed'));
    const abort = () => finish(Error('Icon download timed out'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    const connect = (addresses: dns.LookupAddress[]) => {
      if (settled || signal.aborted) return;
      if (
        !addresses.length ||
        addresses.length > 32 ||
        addresses.some((a) => !publicIconAddress(a.address, a.family))
      )
        return fail();
      const chosen = addresses.find((a) => a.family === 4) ?? addresses[0]!;
      const lookup: LookupFunction = (hostname, options, callback) => {
        if (hostname.replace(/^\[|\]$/g, '') !== host) return callback(Error('Icon host changed'), '', 0);
        if (options.all) callback(null, [chosen]);
        else callback(null, chosen.address, chosen.family);
      };
      try {
        request = (url.protocol === 'https:' ? ports.https : ports.http)(
          url,
          {
            method: 'GET',
            agent: false,
            lookup,
            family: chosen.family,
            signal,
            ...(url.protocol === 'https:'
              ? { rejectUnauthorized: true, servername: isIP(host) ? undefined : host }
              : {}),
            headers: {
              Accept:
                'text/html,image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon',
              'Accept-Encoding': 'identity'
            }
          },
          (res) => {
            if (settled) {
              res.destroy();
              return;
            }
            incoming = res;
            if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
              const location = res.headers.location;
              res.destroy();
              if (!location || redirects >= 2) return fail();
              try {
                return finish(undefined, { redirect: iconUrl(new URL(location, url).href).href });
              } catch {
                return fail();
              }
            }
            const contentType = res.headers['content-type'] ?? '',
              mime = contentType.split(';')[0]!.trim().toLowerCase();
            const length = res.headers['content-length'],
              encoding = res.headers['content-encoding'];
            if (
              res.statusCode !== 200 ||
              ![
                'text/html',
                'image/png',
                'image/jpeg',
                'image/webp',
                'image/gif',
                'image/x-icon',
                'image/vnd.microsoft.icon'
              ].includes(mime) ||
              (encoding && encoding !== 'identity') ||
              (length !== undefined &&
                (!/^[1-9]\d*$/.test(length) ||
                  !Number.isSafeInteger(Number(length)) ||
                  Number(length) > limit))
            )
              return fail();
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
              if (settled) return;
              size += chunk.length;
              if (size > limit) return fail();
              chunks.push(Buffer.from(chunk));
            });
            res.once('error', fail);
            res.once('aborted', fail);
            res.once('close', () => {
              if (!res.complete && !settled) fail();
            });
            res.once('end', () => {
              if (!size || (length !== undefined && Number(length) !== size)) return fail();
              finish(undefined, { bytes: Buffer.concat(chunks, size), mime, contentType, url: url.href });
            });
          }
        );
        request.once('error', fail);
        request.end();
      } catch {
        fail();
      }
    };
    if (isIP(host)) connect([{ address: host, family: isIP(host) }]);
    else
      try {
        ports.lookup(host, { all: true, verbatim: true }, (error, addresses) => {
          if (settled) return;
          if (error) return fail();
          connect(addresses);
        });
      } catch {
        fail();
      }
  });
  if ('redirect' in response)
    return downloadIconResource(response.redirect, limit, signal, ports, redirects + 1, pageRequest);
  return response;
}
export function iconCandidates(html: string, pageUrl: string) {
  const found: string[] = [];
  for (const tag of html.match(/<link\b[^>]{0,4096}>/gi) ?? []) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
      attributes.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
    if (
      !(attributes.get('rel') ?? '').toLowerCase().split(/\s+/).includes('icon') ||
      /svg/i.test(attributes.get('type') ?? '')
    )
      continue;
    try {
      const url = iconUrl(new URL((attributes.get('href') ?? '').replace(/&amp;/g, '&'), pageUrl).href).href;
      if (!found.includes(url)) found.push(url);
    } catch {
      /* invalid candidate is ignored */
    }
    if (found.length === 2) break;
  }
  const fallback = new URL('/favicon.ico', pageUrl).href;
  return [...found.filter((url) => url !== fallback), fallback];
}
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type IconPixels = { data: Buffer; width: number; height: number };
/** Fixed 40-byte BI_RGB 8/24/32-bit layouts only; never pass a remote DIB to sharp. */
function iconDib(image: Buffer, directory: Buffer): IconPixels {
  if (image.length < 40 || image.readUInt32LE(0) !== 40) throw Error('Unsupported ICO bitmap');
  const width = image.readInt32LE(4),
    doubleHeight = image.readInt32LE(8),
    bits = image.readUInt16LE(14);
  const indexed = bits === 8,
    colors = image.readUInt32LE(32),
    important = image.readUInt32LE(36);
  const paletteColors = indexed ? colors || 256 : 0,
    planes = directory.readUInt16LE(4),
    directoryBits = directory.readUInt16LE(6);
  if (
    width < 1 ||
    width > 256 ||
    doubleHeight < 2 ||
    doubleHeight > 512 ||
    doubleHeight % 2 !== 0 ||
    width !== (directory[0] || 256) ||
    doubleHeight / 2 !== (directory[1] || 256) ||
    directory[3] !== 0 ||
    image.readUInt16LE(12) !== 1 ||
    ![8, 24, 32].includes(bits) ||
    image.readUInt32LE(16) !== 0 ||
    (indexed
      ? paletteColors > 256 ||
        important > paletteColors ||
        (directory[2] !== 0 && directory[2] !== paletteColors) ||
        ![0, 1].includes(planes) ||
        ![0, 8].includes(directoryBits)
      : directory[2] !== 0 || planes !== 1 || directoryBits !== bits || colors !== 0 || important !== 0)
  )
    throw Error('Invalid ICO bitmap');
  const height = doubleHeight / 2,
    bytesPerPixel = bits / 8,
    pixelOffset = 40 + paletteColors * 4;
  const rowBytes = Math.ceil((width * bits) / 32) * 4,
    maskRowBytes = Math.ceil(width / 32) * 4;
  const pixelBytes = rowBytes * height,
    maskBytes = maskRowBytes * height,
    sizeImage = image.readUInt32LE(20);
  if (
    image.length !== pixelOffset + pixelBytes + maskBytes ||
    ![0, pixelBytes, pixelBytes + maskBytes].includes(sizeImage)
  )
    throw Error('Invalid ICO bitmap size');
  // All dimensions and ranges are checked before allocating at most 256 KiB of RGBA.
  const data = Buffer.alloc(width * height * 4);
  let hasAlpha = false;
  for (let y = 0; y < height; y++) {
    const source = pixelOffset + (height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x++) {
      const at = source + x * bytesPerPixel,
        target = (y * width + x) * 4;
      const index = indexed ? image[at]! : 0;
      if (indexed && index >= paletteColors) throw Error('Invalid ICO palette index');
      const color = indexed ? 40 + index * 4 : at;
      data[target] = image[color + 2]!;
      data[target + 1] = image[color + 1]!;
      data[target + 2] = image[color]!;
      // RGBQUAD's fourth palette byte is reserved, never per-pixel alpha.
      const alpha = bits === 32 ? image[at + 3]! : 0;
      data[target + 3] = alpha;
      hasAlpha ||= alpha !== 0;
    }
  }
  // Legacy 32-bit icons use all-zero alpha and the AND mask. Otherwise preserve every alpha value.
  if (bits !== 32 || !hasAlpha)
    for (let y = 0; y < height; y++) {
      const mask = pixelOffset + pixelBytes + (height - 1 - y) * maskRowBytes;
      for (let x = 0; x < width; x++)
        data[(y * width + x) * 4 + 3] = image[mask + (x >> 3)]! & (0x80 >> (x & 7)) ? 0 : 255;
    }
  return { data, width, height };
}
export function iconRaster(input: Buffer, mime: string): Buffer | IconPixels {
  if (input.length > 256 * 1024) throw Error('Icon too large');
  if (!['image/x-icon', 'image/vnd.microsoft.icon'].includes(mime)) return input;
  if (input.length < 6 || input.readUInt16LE(0) !== 0 || input.readUInt16LE(2) !== 1)
    throw Error('Invalid ICO');
  const count = input.readUInt16LE(4);
  if (count < 1 || count > 16 || input.length < 6 + count * 16) throw Error('Invalid ICO');
  let selected: Buffer | null = null,
    bitmap: { image: Buffer; directory: Buffer } | null = null;
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16,
      size = input.readUInt32LE(entry + 8),
      offset = input.readUInt32LE(entry + 12);
    if (offset < 6 + count * 16 || size < 8 || offset + size > input.length) throw Error('Invalid ICO');
    const image = input.subarray(offset, offset + size);
    if (!selected && image.subarray(0, 8).equals(pngSignature)) selected = image;
    if (!bitmap && image.readUInt32LE(0) === 40)
      bitmap = { image, directory: input.subarray(entry, entry + 16) };
  }
  if (selected) return selected;
  if (bitmap) return iconDib(bitmap.image, bitmap.directory);
  throw Error('Unsupported ICO');
}
export async function normalizeIcon(input: Buffer, mime: string) {
  if (
    ![
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
      'image/x-icon',
      'image/vnd.microsoft.icon'
    ].includes(mime)
  )
    throw Error('Invalid icon type');
  const raster = iconRaster(input, mime);
  const options = { limitInputPixels: 1024 * 1024, animated: false, pages: 1, failOn: 'warning' as const };
  let image;
  if (Buffer.isBuffer(raster)) {
    const bytes = raster;
    const detected = bytes.subarray(0, 8).equals(pngSignature)
      ? 'png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? 'jpeg'
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
          ? 'webp'
          : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
            ? 'gif'
            : null;
    // Reject vector/XML inputs before even asking the image decoder for metadata.
    if (
      !detected ||
      (!['image/x-icon', 'image/vnd.microsoft.icon'].includes(mime) && mime !== 'image/' + detected)
    )
      throw Error('Icon signature mismatch');
    image = sharp(bytes, options);
  } else
    image = sharp(raster.data, {
      ...options,
      raw: { width: raster.width, height: raster.height, channels: 4 }
    });
  image.timeout({ seconds: 1 });
  const meta = await image.metadata();
  const formats = Buffer.isBuffer(raster) ? ['png', 'jpeg', 'webp', 'gif'] : ['raw'];
  if (
    !formats.includes(meta.format ?? '') ||
    (meta.pages ?? 1) > 1 ||
    !meta.width ||
    !meta.height ||
    meta.width * meta.height > 1024 * 1024
  )
    throw Error('Invalid icon image');
  // Decode to raw pixels and re-encode: no remote metadata, SVG or embedded script is served.
  const { data, info } = await image
    .resize(64, 64, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const output = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .webp({ quality: 85 })
    .toBuffer();
  if (output.length > 64 * 1024) throw Error('Icon output too large');
  return output;
}
const websiteEntities: Readonly<Record<string, string>> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•'
};
function websiteNameText(value: string): string | null {
  const decoded = value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity: string, code: string) => {
    if (!code.startsWith('#'))
      return Object.hasOwn(websiteEntities, code.toLowerCase())
        ? websiteEntities[code.toLowerCase()]!
        : entity;
    const point =
      code[1]?.toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point)
      : ' ';
  });
  if (decoded.includes('\ufffd')) return null;
  const text = decoded
    .replace(/<!--[^]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|template)\b[^<>]*>[^]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  let result = '';
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) continue;
    if (result.length + character.length > 80) break;
    result += character;
  }
  return result.trimEnd() || null;
}
/** Treat remote metadata only as bounded plain text; it is never executable markup. */
export function parseWebsiteName(html: string): string | null {
  const source = html
    .slice(0, 128 * 1024)
    .replace(/<!--[^]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|template)\b[^<>]*>[^]*?(?:<\/\1\s*>|$)/gi, ' ');
  for (const tag of source.match(/<meta\b[^>]{0,4096}>/gi) ?? []) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
      attributes.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
    if ((attributes.get('property') ?? attributes.get('name') ?? '').toLowerCase() !== 'og:site_name')
      continue;
    const name = websiteNameText(attributes.get('content') ?? '');
    if (name) return name;
  }
  const title = source.match(/<title\b[^>]{0,4096}>([^]*?)<\/title\s*>/i);
  return title ? websiteNameText(title[1]!) : null;
}
const websiteCharsets: Readonly<Record<string, string>> = {
  'utf-8': 'utf-8',
  utf8: 'utf-8',
  gbk: 'gbk',
  gb2312: 'gbk',
  gb18030: 'gb18030'
};
function declaredWebsiteCharset(value: string): string | null {
  if (value.length > 1024) return null;
  const matches = [
    ...value.matchAll(/(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))\s*(?=;|$)/gi)
  ];
  if (matches.length !== 1) return null;
  const label = (matches[0]![1] ?? matches[0]![2] ?? matches[0]![3] ?? '').toLowerCase();
  return Object.hasOwn(websiteCharsets, label) ? websiteCharsets[label]! : null;
}
/** BOM > supported HTTP charset > bounded early meta > UTF-8. Never guess arbitrary encodings. */
export function decodeWebsiteHtml(bytes: Buffer, contentType = ''): string {
  const bounded = bytes.subarray(0, 128 * 1024);
  let charset = bounded.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? 'utf-8'
    : declaredWebsiteCharset(contentType);
  if (!charset) {
    const early = bounded
      .subarray(0, 4096)
      .toString('latin1')
      .replace(/<!--[^]*?(?:-->|$)/g, ' ')
      .replace(/<(script|style|template)\b[^<>]*>[^]*?(?:<\/\1\s*>|$)/gi, ' ');
    for (const tag of early.match(/<meta\b[^>]{0,1024}>/gi) ?? []) {
      const attributes = new Map<string, string>();
      for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
        attributes.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
      const label = (attributes.get('charset') ?? '').toLowerCase();
      charset = Object.hasOwn(websiteCharsets, label)
        ? websiteCharsets[label]!
        : (attributes.get('http-equiv') ?? '').toLowerCase() === 'content-type'
          ? declaredWebsiteCharset(attributes.get('content') ?? '')
          : null;
      if (charset) break;
    }
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bounded);
  } catch {
    return bounded.toString('utf8');
  } // Invalid labels fall back safely; malformed names retain the replacement-character guard.
}
let active = 0;
export async function fetchQuickWebsite(
  link: string,
  measureSelectedIcon?: (bytes: number) => void
): Promise<{ name: string | null; icon: Buffer | null }> {
  if (active >= 2) return { name: null, icon: null };
  active++;
  const signal = AbortSignal.timeout(4000);
  let name: string | null = null;
  try {
    const pageUrl = websitePageUrl(link);
    let candidates = [new URL('/favicon.ico', pageUrl).href];
    try {
      const page = await downloadIconResource(pageUrl.href, 128 * 1024, signal, network, 0, true);
      if (page.mime === 'text/html') {
        const html = decodeWebsiteHtml(page.bytes, page.contentType);
        name = parseWebsiteName(html);
        candidates = iconCandidates(html, page.url);
      }
    } catch {
      /* direct favicon may still be available */
    }
    for (const candidate of candidates) {
      signal.throwIfAborted();
      try {
        const icon = await downloadIconResource(candidate, 256 * 1024, signal);
        const output = await normalizeIcon(icon.bytes, icon.mime);
        signal.throwIfAborted();
        measureSelectedIcon?.(icon.bytes.length);
        return { name, icon: output };
      } catch {
        /* use next safe candidate or default */
      }
    }
    return { name, icon: null };
  } catch {
    return { name, icon: null };
  } finally {
    active--;
  }
}
export async function fetchQuickIcon(link: string): Promise<Buffer | null> {
  return (await fetchQuickWebsite(link)).icon;
}

/** Internal accounting port: only the selected successful icon body, never HTML or rejected candidates. */
export interface MeteredQuickIcon {
  icon: Buffer | null;
  rawBytes: number;
}
export interface MeteredQuickWebsite extends MeteredQuickIcon {
  name: string | null;
}
export interface QuickIconMeterPort {
  icon(url: string): Promise<MeteredQuickIcon>;
  website(url: string): Promise<MeteredQuickWebsite>;
}
export async function fetchQuickWebsiteMetered(link: string): Promise<MeteredQuickWebsite> {
  let rawBytes = 0;
  const result = await fetchQuickWebsite(link, (bytes) => {
    rawBytes = bytes;
  });
  return { ...result, rawBytes };
}
export async function fetchQuickIconMetered(link: string): Promise<MeteredQuickIcon> {
  const { icon, rawBytes } = await fetchQuickWebsiteMetered(link);
  return { icon, rawBytes };
}
