import manifest from './manifest.json' with { type: 'json' };
export const stickers = manifest;
export type Sticker = (typeof manifest)[number];
const byId = new Map(stickers.map((sticker) => [sticker.id, sticker]));
export const stickerToken = (id: string) => (byId.has(id) ? `[rs1:${id}]` : null);
export function stickerParts(text: string): Array<string | Sticker> {
  const parts: Array<string | Sticker> = [],
    pattern = /\[rs1:(\d{2})\]/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const sticker = byId.get(match[1]!);
    if (!sticker) continue;
    if (match.index > start) parts.push(text.slice(start, match.index));
    parts.push(sticker);
    start = match.index + match[0].length;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}
export function insertSticker(text: string, id: string, start: number, end: number, maxLength: number) {
  const token = stickerToken(id);
  if (!token) return null;
  const from = Math.max(0, Math.min(text.length, start)),
    to = Math.max(from, Math.min(text.length, end));
  const value = text.slice(0, from) + token + text.slice(to);
  return value.length <= maxLength ? { value, caret: from + token.length } : null;
}

/** Compact excerpts use accessible labels, before truncation, without loading images. */
export function stickerLabelText(text: string): string {
  return stickerParts(text)
    .map((part) => (typeof part === 'string' ? part : '[' + part.label + ']'))
    .join('');
}
