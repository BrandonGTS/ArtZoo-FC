export function unicodeIntervals(value) {
  return value
    .split(',')
    .filter((x) => x.trim())
    .map((token) => {
      const match = token.trim().match(/^U\+([0-9A-F]{1,6})(?:-([0-9A-F]{1,6}))?$/i);
      if (!match) throw new Error('Unsupported Unicode range');
      const low = parseInt(match[1], 16),
        high = parseInt(match[2] || match[1], 16);
      if (low > high || high > 0x10ffff) throw new Error('Invalid Unicode range');
      return [low, high];
    });
}
export function mergeUnicodeIntervals(intervals) {
  const merged = [];
  for (const [low, high] of intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = merged.at(-1);
    if (last && low <= last[1] + 1) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  return merged
    .map(
      ([low, high]) =>
        'U+' + low.toString(16).toUpperCase() + (high === low ? '' : '-' + high.toString(16).toUpperCase())
    )
    .join(',');
}
export function normalizeUnicodeRanges(value) {
  return mergeUnicodeIntervals(unicodeIntervals(value));
}
export function subtractUnicodeRanges(value, excluded) {
  const points = [...new Set(excluded)].sort((a, b) => a - b),
    result = [];
  for (const [low, high] of unicodeIntervals(value)) {
    let start = low;
    for (const point of points) {
      if (point < start || point > high) continue;
      if (point > start) result.push([start, point - 1]);
      start = point + 1;
    }
    if (start <= high) result.push([start, high]);
  }
  return mergeUnicodeIntervals(result);
}
export function unicodeSet(value) {
  const points = new Set();
  for (const [low, high] of unicodeIntervals(value)) for (let p = low; p <= high; p++) points.add(p);
  return points;
}
