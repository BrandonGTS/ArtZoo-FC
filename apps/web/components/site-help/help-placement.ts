export type HelpRect = { left: number; top: number; right: number; bottom: number };
export type HelpSide = 'top' | 'right' | 'bottom' | 'left';
export type HelpCardPlacement = {
  side: HelpSide;
  left: number;
  top: number;
  width: number;
  height: number;
  maxHeight: number;
};
type Options = {
  target: HelpRect;
  viewport: HelpRect;
  width: number;
  height: number;
  previousSide?: HelpSide;
  margin?: number;
  gap?: number;
  minWidth?: number;
  minHeight?: number;
};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function findHelpCardPlacement({
  target,
  viewport,
  width,
  height,
  previousSide,
  margin = 12,
  gap = 16,
  minWidth = 280,
  minHeight = 120
}: Options): HelpCardPlacement | null {
  if (
    ![
      target.left,
      target.top,
      target.right,
      target.bottom,
      viewport.left,
      viewport.top,
      viewport.right,
      viewport.bottom,
      width,
      height
    ].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    target.right <= target.left ||
    target.bottom <= target.top
  )
    return null;
  const left = viewport.left + margin,
    right = viewport.right - margin;
  const top = viewport.top + margin,
    bottom = viewport.bottom - margin;
  const availableWidth = right - left,
    availableHeight = bottom - top;
  if (availableWidth <= 0 || availableHeight <= 0) return null;
  const preferredWidth = Math.min(width, availableWidth);
  const candidates: Array<HelpCardPlacement & { score: number }> = [];
  for (const side of ['bottom', 'right', 'top', 'left'] as const) {
    const horizontal = side === 'left' || side === 'right';
    const space =
      side === 'bottom'
        ? bottom - target.bottom - gap
        : side === 'top'
          ? target.top - gap - top
          : side === 'left'
            ? target.left - gap - left
            : right - target.right - gap;
    const cardWidth = horizontal ? Math.min(preferredWidth, space) : preferredWidth;
    const maxHeight = horizontal ? availableHeight : Math.min(availableHeight, space);
    const cardHeight = Math.min(height, maxHeight);
    if (cardWidth < Math.min(minWidth, preferredWidth) || cardHeight < Math.min(minHeight, height)) continue;
    const x =
      side === 'left'
        ? target.left - gap - cardWidth
        : side === 'right'
          ? target.right + gap
          : clamp((target.left + target.right - cardWidth) / 2, left, right - cardWidth);
    const y =
      side === 'top'
        ? target.top - gap - cardHeight
        : side === 'bottom'
          ? target.bottom + gap
          : clamp((target.top + target.bottom - cardHeight) / 2, top, bottom - cardHeight);
    if (x < left || y < top || x + cardWidth > right || y + cardHeight > bottom) continue;
    candidates.push({
      side,
      left: x,
      top: y,
      width: cardWidth,
      height: cardHeight,
      maxHeight,
      score: (cardWidth / preferredWidth) * (cardHeight / height) + (side === previousSide ? 0.015 : 0)
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;
  const best = candidates[0];
  if (!best) return null;
  return {
    side: best.side,
    left: best.left,
    top: best.top,
    width: best.width,
    height: best.height,
    maxHeight: best.maxHeight
  };
}

/** Move a normal-flow target to an actual viewport edge using existing scroll range.
 * Never enlarge the document, move a fixed overlay, or replace the target bounds. */
export function helpScrollForSpace({
  target,
  viewport,
  scrollTop,
  maxScroll,
  cardHeight,
  margin = 12,
  gap = 16
}: {
  target: HelpRect;
  viewport: HelpRect;
  scrollTop: number;
  maxScroll: number;
  cardHeight: number;
  margin?: number;
  gap?: number;
}): number | null {
  if (![scrollTop, maxScroll, cardHeight].every(Number.isFinite) || maxScroll <= 0 || cardHeight <= 0)
    return null;
  const start = clamp(scrollTop + target.top - viewport.top - margin - gap - cardHeight, 0, maxScroll);
  const end = clamp(scrollTop + target.bottom - viewport.bottom + margin + gap + cardHeight, 0, maxScroll);
  const options = [start, end]
    .filter((next) => {
      const delta = next - scrollTop;
      return (
        target.top - delta >= viewport.top + margin + gap + cardHeight ||
        target.bottom - delta <= viewport.bottom - margin - gap - cardHeight
      );
    })
    .sort((a, b) => Math.abs(a - scrollTop) - Math.abs(b - scrollTop));
  return options[0] ?? null;
}
