import Image from 'next/image';
import type { ReactNode } from 'react';
import { stickerParts } from './sticker-codec';
import './stickers.css';
type TextRange = { start: number; end: number };

function markMatches(text: string, offset: number, highlights: readonly TextRange[]): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const { start, end } of highlights) {
    const from = Math.max(0, start - offset);
    const to = Math.min(text.length, end - offset);
    if (from >= to) continue;

    nodes.push(text.slice(cursor, from), <mark key={from}>{text.slice(from, to)}</mark>);
    cursor = to;
  }

  return nodes.length ? [...nodes, text.slice(cursor)] : text;
}

export default function StickerText({
  text,
  highlights = [],
  excerptStart = 0
}: {
  text: string;
  /** Offsets in the readable string returned by stickerLabelText. */
  highlights?: readonly TextRange[];
  /** Start of the preview in the same readable string. */
  excerptStart?: number;
}) {
  const content: ReactNode[] = [];
  let offset = 0;

  for (const [index, part] of stickerParts(text).entries()) {
    const label = typeof part === 'string' ? part : '[' + part.label + ']';
    const start = offset;
    const end = start + label.length;
    offset = end;
    if (end <= excerptStart) continue;

    // Stickers are kept whole even when the excerpt starts within their label.
    const from = typeof part === 'string' ? Math.max(start, excerptStart) : start;
    if (!content.length && from > 0) content.push('\u2026');

    if (typeof part === 'string') {
      const visibleText = part.slice(from - start);
      content.push(highlights.length ? markMatches(visibleText, from, highlights) : visibleText);
      continue;
    }

    const sticker = (
      <Image
        key={index}
        className="artzoo-sticker"
        src={part.url}
        width={part.width}
        height={part.height}
        alt={label}
        title={part.label}
        unoptimized
        loading="lazy"
      />
    );
    const matched = highlights.some((range) => range.start < end && range.end > start);
    content.push(matched ? <mark key={index}>{sticker}</mark> : sticker);
  }

  return <>{content}</>;
}
