/** Bounded inert HTML discovery for six verified official topics. No I/O or execution. */
export interface OfficialSourceImage {
  url: string;
  pageUrl: string;
  kind: 'API' | 'NEWS' | 'TOPIC_METADATA' | 'TOPIC_SECTION';
}
export const OFFICIAL_EVENT_IMAGE_HOSTS = ['fu5.web.sdo.com', 'static.web.sdo.com'] as const;
const IMAGE_PATHS: Record<string, string> = {
  'fu5.web.sdo.com': '/10036/',
  'static.web.sdo.com': '/jijiamobile/pic/ff14/'
};
export function validOfficialEventImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\//.test(value) || /[\s\\%]/.test(value))
    return false;
  try {
    const url = new URL(value);
    return (
      url.href === value &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      Boolean(IMAGE_PATHS[url.hostname]) &&
      url.pathname.startsWith(IMAGE_PATHS[url.hostname]!) &&
      /\.(?:jpe?g|png|webp|gif)$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}
const TOPICS: Record<string, string> = {
  'calendar:110': 'https://actff1.web.sdo.com/project/20261005All_Saints_Wake/hjwff6jkcti4/index.html',
  'calendar:109': 'https://actff1.web.sdo.com/project/20260928ff14fallguys/4kkmxknj3rno/index.html',
  'calendar:108': 'https://actff1.web.sdo.com/project/20260915ffxv/index.html',
  'calendar:106': 'https://actff1.web.sdo.com/project/20260826mogmog/0by196dc8ija/index.html',
  'calendar:102': 'https://actff1.web.sdo.com/project/20240927dawntrail/patch75/index.html',
  'calendar:99': 'https://actff1.web.sdo.com/20260704_CardBill/index.html#/index'
};
export function verifiedOfficialTopic(externalId: string, pageUrl: string): boolean {
  return TOPICS[externalId] === pageUrl;
}
export function verifiedOfficialTopicFetchUrl(url: string): boolean {
  return Object.values(TOPICS).some((topic) => topic.split('#')[0] === url);
}
interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  text: string;
}
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
]);
const INERT = new Set(['script', 'style', 'template', 'noscript']);
const OPTIONAL = new Set(['p', 'li', 'dt', 'dd', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'option']);
const BLOCK = new Set([
  'div',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'aside',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'dl',
  'table'
]);
const MAX_HTML = 512 * 1024,
  MAX_NODES = 20000,
  MAX_DEPTH = 96,
  MAX_TEXT = 80000;
function fail(): never {
  throw new Error('Official HTML structure is unsupported');
}
function entities(value: string): string {
  return value.replace(
    /&(?:#(x[0-9a-f]+|[0-9]+)|(amp|quot|apos|lt|gt|nbsp|ndash|mdash));/gi,
    (_, number: string | undefined, name: string | undefined) => {
      if (number) {
        const code = number[0]?.toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
        if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return fail();
        return String.fromCodePoint(code);
      }
      return (
        { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—' } as Record<
          string,
          string
        >
      )[name!.toLowerCase()]!;
    }
  );
}
function attributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null);
  let pos = 0;
  while (pos < raw.length) {
    while (/\s/.test(raw[pos] ?? '') && pos < raw.length) pos++;
    if (pos === raw.length) break;
    const key = /^[^\s=\/<>"']+/.exec(raw.slice(pos))?.[0]?.toLowerCase();
    if (!key || (Object.hasOwn(attrs, key) && !['width', 'height'].includes(key))) return fail();
    pos += key.length;
    while (/\s/.test(raw[pos] ?? '') && pos < raw.length) pos++;
    let value = '';
    if (raw[pos] === '=') {
      pos++;
      while (/\s/.test(raw[pos] ?? '') && pos < raw.length) pos++;
      const quote = raw[pos];
      if (quote === '"' || quote === "'") {
        pos++;
        const end = raw.indexOf(quote, pos);
        if (end < 0) return fail();
        value = raw.slice(pos, end);
        pos = end + 1;
      } else {
        const part = /^[^\s<>`"'=]+/.exec(raw.slice(pos))?.[0];
        if (!part) return fail();
        value = part;
        pos += part.length;
      }
    }
    // The verified legacy Fall Guys page repeats presentation-only image dimensions.
    // They never participate in discovery; identity/navigation duplicates still fail closed.
    if (!Object.hasOwn(attrs, key)) attrs[key] = entities(value);
  }
  return attrs;
}
function parseHtml(html: string): HtmlNode {
  if (typeof html !== 'string' || html.length > MAX_HTML || html.includes('\u0000')) return fail();
  const root: HtmlNode = { tag: '#root', attrs: {}, children: [], text: '' },
    stack = [root];
  let pos = 0,
    count = 1;
  const add = (node: HtmlNode) => {
    if (++count > MAX_NODES) return fail();
    stack.at(-1)!.children.push(node);
  };
  const addText = (value: string) => {
    if (value) add({ tag: '#text', attrs: {}, children: [], text: entities(value) });
  };
  while (pos < html.length) {
    const open = html.indexOf('<', pos);
    if (open < 0) {
      addText(html.slice(pos));
      break;
    }
    addText(html.slice(pos, open));
    pos = open;
    if (html.startsWith('<!--', pos)) {
      const end = html.indexOf('-->', pos + 4);
      if (end < 0) return fail();
      pos = end + 3;
      continue;
    }
    if (/^<!doctype\b/i.test(html.slice(pos))) {
      const end = html.indexOf('>', pos);
      if (end < 0) return fail();
      pos = end + 1;
      continue;
    }
    if (!/^<\/?[A-Za-z]/.test(html.slice(pos))) {
      addText('<');
      pos++;
      continue;
    }
    let end = pos + 1,
      quote = '';
    for (; end < html.length; end++) {
      const char = html[end]!;
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end >= html.length || quote) return fail();
    const raw = html.slice(pos + 1, end),
      close = raw.startsWith('/'),
      match = /^\/?([A-Za-z][A-Za-z0-9:_-]*)/.exec(raw);
    if (!match) return fail();
    const tag = match[1]!.toLowerCase();
    pos = end + 1;
    if (close) {
      if (raw.slice(match[0].length).trim() || VOID.has(tag)) return fail();
      let index = stack.length - 1;
      while (index > 0 && stack[index]!.tag !== tag && OPTIONAL.has(stack[index]!.tag)) index--;
      if (index === 0 || stack[index]!.tag !== tag) return fail();
      stack.length = index;
      continue;
    }
    const selfClosing = /\/\s*$/.test(raw),
      tail = raw.slice(match[0].length).replace(/\/\s*$/, ''),
      attrs = attributes(tail);
    if (INERT.has(tag)) {
      if (selfClosing) continue;
      const closing = new RegExp('<\\/' + tag + '\\s*>', 'ig');
      closing.lastIndex = pos;
      const stopped = closing.exec(html);
      if (!stopped) return fail();
      pos = closing.lastIndex;
      continue;
    }
    const top = () => stack.at(-1)!.tag;
    if (
      (tag === 'li' && top() === 'li') ||
      (['dt', 'dd'].includes(tag) && ['dt', 'dd'].includes(top())) ||
      (tag === 'option' && top() === 'option') ||
      (BLOCK.has(tag) && top() === 'p')
    )
      stack.pop();
    if (['td', 'th'].includes(tag) && ['td', 'th'].includes(top())) stack.pop();
    if (tag === 'tr') {
      if (['td', 'th'].includes(top())) stack.pop();
      if (top() === 'tr') stack.pop();
    }
    const node: HtmlNode = { tag, attrs, children: [], text: '' };
    add(node);
    if (!selfClosing && !VOID.has(tag)) {
      stack.push(node);
      if (stack.length > MAX_DEPTH) return fail();
    }
  }
  if (stack.slice(1).some((node) => !OPTIONAL.has(node.tag))) return fail();
  return root;
}
const has = (node: HtmlNode, cls: string) => (node.attrs.class ?? '').split(/\s+/).includes(cls);
function nodes(root: HtmlNode, predicate: (node: HtmlNode) => boolean): HtmlNode[] {
  const result: HtmlNode[] = [];
  const visit = (node: HtmlNode) => {
    if (predicate(node)) result.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return result;
}
function text(node: HtmlNode): string {
  return (node.tag === '#text' ? node.text : node.children.map(text).join(' ')).replace(/\s+/g, ' ').trim();
}
const directText = (node: HtmlNode) =>
  node.children
    .filter((child) => child.tag === '#text')
    .map(text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
function uniqueText(parts: HtmlNode[]): string {
  const seen = new Set<string>(),
    values: string[] = [];
  for (const node of parts) {
    const value = text(node),
      key = value.replace(/\s+/g, '');
    if (value && !seen.has(key)) {
      seen.add(key);
      values.push(value);
    }
  }
  const value = values.join('\n');
  if (value.length > MAX_TEXT) return fail();
  return value;
}
function image(
  node: HtmlNode | undefined,
  pageUrl: string,
  kind: OfficialSourceImage['kind']
): OfficialSourceImage | undefined {
  const url = node?.attrs.src;
  if (!validOfficialEventImageUrl(url)) return undefined;
  return { url, pageUrl, kind };
}
export function officialTextFromHtml(html: string): string {
  const value = text(parseHtml(html));
  if (value.length > MAX_TEXT) return fail();
  return value;
}
export function officialNewsHasBacklink(html: string, pageUrl: string): boolean {
  return nodes(parseHtml(html), (node) => node.tag === 'a' && node.attrs.href === pageUrl).length > 0;
}
export function discoverOfficialTopic(
  externalId: string,
  pageUrl: string,
  html: string
): { sourceText: string; summary: string; image?: OfficialSourceImage } {
  if (!verifiedOfficialTopic(externalId, pageUrl)) return fail();
  const root = parseHtml(html);
  let parts: HtmlNode[] = [],
    picture: OfficialSourceImage | undefined;
  if (externalId === 'calendar:110')
    parts = nodes(
      root,
      (node) => has(node, 'content__event-info__quest--text') || has(node, 'content__event-info__level')
    );
  if (externalId === 'calendar:109') {
    const section = nodes(root, (node) => node.attrs.id === 'howto-playguide');
    if (section.length !== 1) return fail();
    parts = nodes(
      section[0]!,
      (node) => node.tag === 'h3' || (has(node, 'fgs__howto__text') && has(node, 'pc_view'))
    );
  }
  if (externalId === 'calendar:106') {
    const sections = nodes(root, (node) => has(node, 'how_to__inner'));
    parts = sections.flatMap((section) => section.children.filter((node) => node.tag === 'p'));
  }
  if (externalId === 'calendar:108') {
    const section = nodes(root, (node) => node.attrs.id === 'event_overview');
    if (section.length !== 1) return fail();
    for (const quest of nodes(section[0]!, (node) => has(node, 'quest')))
      parts.push(...nodes(quest, (node) => has(node, 'quest__text') || node.tag === 'dl'));
    const header = nodes(root, (node) => node.tag === 'header' && has(node, 'content__header'));
    if (header.length !== 1) return fail();
    const logos = nodes(header[0]!, (node) => has(node, 'content__logo'));
    if (logos.length === 1)
      picture = image(nodes(logos[0]!, (node) => node.tag === 'img')[0], pageUrl, 'TOPIC_SECTION');
  }
  if (externalId === 'calendar:102') {
    const sections = nodes(root, (node) => has(node, 'patch_site__content__inner')).filter(
      (section) => nodes(section, (node) => node.tag === 'h3' && directText(node) === '魔光键影').length === 1
    );
    if (sections.length !== 1) return fail();
    const section = sections[0]!;
    parts = nodes(section, (node) => node.tag === 'p' && has(node, 'text'));
    const galleries = nodes(section, (node) => node.tag === 'ul' && has(node, 'image'));
    if (galleries.length === 1) {
      const active = galleries[0]!.children.filter((node) => node.tag === 'li' && has(node, 'active'));
      if (active.length === 1)
        picture = image(nodes(active[0]!, (node) => node.tag === 'img')[0], pageUrl, 'TOPIC_SECTION');
    }
  }
  // Page-wide metadata is reliable only for a verified dedicated event page, never the patch collection.
  if (!picture && externalId !== 'calendar:102') {
    const metadata = nodes(
      root,
      (node) =>
        node.tag === 'meta' &&
        ['og:image', 'twitter:image'].includes(node.attrs.property ?? node.attrs.name ?? '')
    );
    if (metadata.length === 1 && validOfficialEventImageUrl(metadata[0]!.attrs.content))
      picture = { url: metadata[0]!.attrs.content!, pageUrl, kind: 'TOPIC_METADATA' };
  }
  const sourceText = uniqueText(parts),
    summary = sourceText.slice(0, 2000).trim();
  return { sourceText, summary, ...(picture ? { image: picture } : {}) };
}
