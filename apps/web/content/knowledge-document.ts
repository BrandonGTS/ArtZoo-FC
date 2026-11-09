import { stickers } from '../components/stickers/sticker-codec';

/** Small, versioned storage schema. No HTML is stored or rendered. Shared by editor and server. */
export type BodyFormat = 'PLAIN' | 'RICH_V1';
export interface Mark {
  type: 'bold' | 'italic' | 'underline' | 'strike' | 'link' | 'textStyle';
  attrs?: Record<string, unknown>;
}
export interface RichNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Mark[];
  content?: RichNode[];
}
export interface KnowledgeImageDimensions {
  width: number;
  height: number;
}
export function knowledgeImageDimensions(attrs: {
  width?: unknown;
  height?: unknown;
}): KnowledgeImageDimensions | undefined {
  return Number.isSafeInteger(attrs.width) &&
    Number(attrs.width) > 0 &&
    Number(attrs.width) <= 100000 &&
    Number.isSafeInteger(attrs.height) &&
    Number(attrs.height) > 0 &&
    Number(attrs.height) <= 100000
    ? { width: Number(attrs.width), height: Number(attrs.height) }
    : undefined;
}
/** The authenticated preview is resized inside 2048px without enlargement. */
export function knowledgePreviewDimensions(attrs: {
  width?: unknown;
  height?: unknown;
}): KnowledgeImageDimensions | undefined {
  const dimensions = knowledgeImageDimensions(attrs);
  if (!dimensions) return undefined;
  const ratio = Math.min(1, 2048 / Math.max(dimensions.width, dimensions.height));
  return {
    width: Math.max(1, Math.round(dimensions.width * ratio)),
    height: Math.max(1, Math.round(dimensions.height * ratio))
  };
}
export interface RichDocument extends RichNode {
  type: 'doc';
  content: RichNode[];
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('正文结构无效');
  return value as Record<string, unknown>;
};
export function safeKnowledgeLink(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    /[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(value)
  )
    throw Error('链接需为有效的 http 或 https 地址');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error('链接需为有效的 http 或 https 地址');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw Error('链接需为有效的 http 或 https 地址');
  return url.href;
}
export function knowledgeImageId(src: unknown): string {
  if (
    typeof src !== 'string' ||
    !/^\/api\/knowledge-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\?variant=preview$/i.test(
      src
    )
  )
    throw Error('正文图片来源无效');
  return src.split('/')[3]!.split('?')[0]!.toLowerCase();
}
export const KNOWLEDGE_FONT_SIZES = [12, 14, 16, 18, 24, 36] as const;
export const KNOWLEDGE_LINE_HEIGHTS = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 2] as const;
export function safeKnowledgeColor(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw Error('颜色无效');
  return value.toLowerCase();
}
export function knowledgePresentation(attrs: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (attrs.textAlign != null) {
    if (!['left', 'center', 'right', 'justify'].includes(String(attrs.textAlign)))
      throw Error('对齐方式无效');
    result.textAlign = attrs.textAlign;
  }
  if (attrs.lineHeight != null) {
    if (!KNOWLEDGE_LINE_HEIGHTS.includes(Number(attrs.lineHeight) as never)) throw Error('行高无效');
    result.lineHeight = Number(attrs.lineHeight);
  }
  if (attrs.indent != null) {
    if (!Number.isInteger(attrs.indent) || Number(attrs.indent) < 0 || Number(attrs.indent) > 8)
      throw Error('缩进无效');
    result.indent = attrs.indent;
  }
  return result;
}
export function normalizeKnowledgeDocument(value: unknown): RichDocument {
  let count = 0;
  function node(input: unknown, parent: string, depth: number): RichNode {
    if (++count > 10000 || depth > 16) throw Error('正文结构过于复杂');
    const raw = object(input),
      type = raw.type;
    if (typeof type !== 'string') throw Error('正文结构无效');
    const attrs = raw.attrs === undefined ? {} : object(raw.attrs);
    if (type === 'text') {
      if (
        !['paragraph', 'heading', 'codeBlock', 'detailsSummary'].includes(parent) ||
        typeof raw.text !== 'string' ||
        !raw.text ||
        raw.text.includes('\0')
      )
        throw Error('正文文字无效');
      const result: RichNode = { type, text: raw.text };
      if (raw.marks !== undefined) {
        if (!Array.isArray(raw.marks) || raw.marks.length > 6 || (parent === 'codeBlock' && raw.marks.length))
          throw Error('正文格式无效');
        const marks = raw.marks.map((m) => {
          const mark = object(m);
          if (['bold', 'italic', 'underline', 'strike'].includes(String(mark.type)))
            return { type: mark.type } as Mark;
          if (mark.type === 'link') {
            const a = object(mark.attrs);
            if (a.target != null && !['_blank', '_self'].includes(String(a.target)))
              throw Error('链接打开位置无效');
            if (a.title != null && (typeof a.title !== 'string' || a.title.length > 500))
              throw Error('链接标题无效');
            return {
              type: 'link',
              attrs: {
                href: safeKnowledgeLink(a.href),
                ...(a.title ? { title: a.title } : {}),
                ...(a.target ? { target: a.target } : {})
              }
            } as Mark;
          }
          if (mark.type === 'textStyle') {
            const a = object(mark.attrs),
              style: Record<string, unknown> = {};
            if (a.fontSize != null) {
              const size = Number(String(a.fontSize).replace(/px$/, ''));
              if (!KNOWLEDGE_FONT_SIZES.includes(size as never)) throw Error('字号无效');
              style.fontSize = size + 'px';
            }
            for (const key of ['color', 'backgroundColor'])
              if (a[key] != null) style[key] = safeKnowledgeColor(a[key]);
            return { type: 'textStyle', attrs: style } as Mark;
          }
          throw Error('不支持此文字格式');
        });
        const unique = new Map(marks.map((mark) => [mark.type, mark]));
        result.marks = [...unique.values()].sort((a, b) => a.type.localeCompare(b.type));
        if (!result.marks.length) delete result.marks;
      }
      return result;
    }
    if (type === 'sticker') {
      if (
        !['paragraph', 'heading', 'detailsSummary'].includes(parent) ||
        typeof attrs.id !== 'string' ||
        !stickers.some((sticker) => sticker.id === attrs.id)
      )
        throw Error('正文表情无效');
      return { type, attrs: { id: attrs.id } };
    }
    const blocks = [
      'paragraph',
      'heading',
      'bulletList',
      'orderedList',
      'blockquote',
      'codeBlock',
      'image',
      'table',
      'details'
    ];
    if (type === 'doc') {
      if (parent !== 'root') throw Error('正文结构无效');
    } else if (type === 'tableRow') {
      if (parent !== 'table') throw Error('表格行结构无效');
    } else if (type === 'tableCell' || type === 'tableHeader') {
      if (parent !== 'tableRow') throw Error('单元格结构无效');
    } else if (type === 'detailsSummary') {
      if (parent !== 'details') throw Error('折叠标题结构无效');
    } else if (type === 'detailsContent') {
      if (parent !== 'details') throw Error('折叠内容结构无效');
    } else if (type === 'listItem') {
      if (!['bulletList', 'orderedList'].includes(parent)) throw Error('列表结构无效');
    } else if (type === 'hardBreak') {
      if (!['paragraph', 'heading', 'detailsSummary'].includes(parent)) throw Error('换行结构无效');
      return { type };
    } else if (
      !blocks.includes(type) ||
      !['doc', 'blockquote', 'listItem', 'tableCell', 'tableHeader', 'detailsContent'].includes(parent)
    )
      throw Error('不支持此正文内容');
    if (type === 'image') {
      knowledgeImageId(attrs.src);
      const caption = (v: unknown) => (typeof v === 'string' ? v.slice(0, 500) : '');
      return {
        type,
        attrs: {
          src: attrs.src,
          alt: caption(attrs.alt),
          title: caption(attrs.title),
          ...knowledgeImageDimensions(attrs)
        }
      };
    }
    const content = raw.content ?? [];
    if (!Array.isArray(content)) throw Error('正文结构无效');
    const children = content.map((child) => node(child, type, depth + 1));
    if (
      ['paragraph', 'heading', 'codeBlock', 'detailsSummary'].includes(type) &&
      children.some((c) => !['text', 'hardBreak', 'sticker'].includes(c.type))
    )
      throw Error('段落结构无效');
    if (
      ['bulletList', 'orderedList'].includes(type) &&
      (!children.length || children.some((c) => c.type !== 'listItem'))
    )
      throw Error('列表结构无效');
    if (type === 'listItem' && children[0]?.type !== 'paragraph') throw Error('列表项目需以段落开始');
    const result: RichNode = { type, ...(children.length ? { content: children } : {}) };
    if (type === 'doc') result.content = children.length ? children : [{ type: 'paragraph' }];
    if (['paragraph', 'heading'].includes(type)) {
      const presentation = knowledgePresentation(attrs);
      if (Object.keys(presentation).length) result.attrs = presentation;
    }
    if (type === 'table') {
      if (!children.length || children.length > 100 || children.some((c) => c.type !== 'tableRow'))
        throw Error('表格结构无效');
      if (attrs.width != null) {
        if (!Number.isInteger(attrs.width) || Number(attrs.width) < 10 || Number(attrs.width) > 100)
          throw Error('表格宽度无效');
        result.attrs = { width: attrs.width };
      }
      const grid: boolean[][] = Array.from({ length: children.length }, () => []);
      let width = 0;
      children.forEach((row, r) => {
        let column = 0;
        for (const cell of row.content ?? []) {
          while (grid[r]![column]) column++;
          const span = Number(cell.attrs?.colspan ?? 1),
            rows = Number(cell.attrs?.rowspan ?? 1);
          if (r + rows > children.length || column + span > 100) throw Error('表格合并范围无效');
          for (let y = r; y < r + rows; y++)
            for (let x = column; x < column + span; x++) {
              if (grid[y]![x]) throw Error('表格合并结构无效');
              grid[y]![x] = true;
            }
          column += span;
        }
        width = Math.max(width, grid[r]!.length);
      });
      if (
        !width ||
        grid.some(
          (row) => row.length !== width || Array.from({ length: width }, (_, c) => row[c]).some((v) => !v)
        )
      )
        throw Error('表格列数无效');
    }
    if (type === 'tableRow') {
      if (children.length > 100 || children.some((c) => !['tableCell', 'tableHeader'].includes(c.type)))
        throw Error('表格行无效');
      if (attrs.height != null) {
        if (!Number.isInteger(attrs.height) || Number(attrs.height) < 20 || Number(attrs.height) > 600)
          throw Error('行高无效');
        result.attrs = { height: attrs.height };
      }
    }
    if (type === 'tableCell' || type === 'tableHeader') {
      if (!children.length) throw Error('单元格内容无效');
      const a: Record<string, unknown> = {};
      for (const key of ['colspan', 'rowspan']) {
        const n = attrs[key] ?? 1;
        if (!Number.isInteger(n) || Number(n) < 1 || Number(n) > 100) throw Error('单元格合并无效');
        a[key] = n;
      }
      if (attrs.colwidth != null) {
        if (
          !Array.isArray(attrs.colwidth) ||
          attrs.colwidth.length !== a.colspan ||
          attrs.colwidth.some((v) => !Number.isInteger(v) || v < 20 || v > 1600)
        )
          throw Error('单元格宽度无效');
        a.colwidth = attrs.colwidth;
      }
      if (attrs.backgroundColor != null) a.backgroundColor = safeKnowledgeColor(attrs.backgroundColor);
      if (attrs.textAlign != null)
        a.textAlign = knowledgePresentation({ textAlign: attrs.textAlign }).textAlign;
      result.attrs = a;
    }
    if (
      type === 'details' &&
      (children.length !== 2 ||
        children[0]?.type !== 'detailsSummary' ||
        children[1]?.type !== 'detailsContent')
    )
      throw Error('折叠结构无效');
    if (type === 'detailsContent' && !children.length) throw Error('折叠内容无效');
    if (type === 'heading') {
      const level = attrs.level;
      if (level !== 1 && level !== 2 && level !== 3) throw Error('标题级别无效');
      result.attrs = { ...result.attrs, level };
    }
    if (type === 'orderedList') {
      const start = attrs.start ?? 1;
      if (!Number.isSafeInteger(start) || Number(start) < 1 || Number(start) > 1000000)
        throw Error('列表序号无效');
      result.attrs = { start };
    }
    return result;
  }
  return node(value, 'root', 0) as RichDocument;
}
export function plainDocument(body: string): RichDocument {
  return {
    type: 'doc',
    content: body
      .split('\n')
      .map((line) => ({ type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}) }))
  };
}
export function readKnowledgeDocument(body: string, format: BodyFormat = 'PLAIN'): RichDocument {
  return format === 'PLAIN' ? plainDocument(body) : normalizeKnowledgeDocument(JSON.parse(body));
}
export function documentText(doc: RichNode): string {
  if (doc.type === 'sticker') {
    const sticker = stickers.find((item) => item.id === doc.attrs?.id);
    return sticker ? '[' + sticker.label + ']' : '';
  }
  return doc.type === 'text'
    ? (doc.text ?? '')
    : doc.type === 'image'
      ? String(doc.attrs?.alt ?? '')
      : doc.type === 'hardBreak'
        ? '\n'
        : (doc.content ?? [])
            .map(documentText)
            .join(
              [
                'doc',
                'blockquote',
                'bulletList',
                'orderedList',
                'listItem',
                'table',
                'tableRow',
                'tableCell',
                'tableHeader',
                'details',
                'detailsContent'
              ].includes(doc.type)
                ? '\n'
                : ''
            );
}
export function documentImages(doc: RichNode): string[] {
  return [
    ...new Set(
      doc.type === 'image' ? [knowledgeImageId(doc.attrs?.src)] : (doc.content ?? []).flatMap(documentImages)
    )
  ];
}
export function validateKnowledgeBody(
  body: unknown,
  format: unknown = 'PLAIN'
): { body: string; bodyFormat: BodyFormat; images: string[] } {
  if (typeof body !== 'string' || body.length > 200000 || body.includes('\0')) throw Error('正文为空或过长');
  if (format === 'PLAIN') {
    if (!body.trim()) throw Error('请填写正文');
    return { body, bodyFormat: 'PLAIN', images: [] };
  }
  if (format !== 'RICH_V1') throw Error('正文格式无效');
  let doc: RichDocument;
  try {
    doc = normalizeKnowledgeDocument(JSON.parse(body));
  } catch (error) {
    throw Error(error instanceof Error ? error.message : '正文结构无效');
  }
  const images = documentImages(doc);
  if (!documentText(doc).trim() && !images.length) throw Error('请填写正文');
  return { body: JSON.stringify(doc), bodyFormat: 'RICH_V1', images };
}
