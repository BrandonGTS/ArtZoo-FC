import { randomInt } from 'node:crypto';

// Sample up to two distinct visible IDs without replacement. Prefer candidates
// outside the previous batch; only fill remaining slots from that batch when
// needed. Each draw is uniform within its remaining pool. No list-page limit.
export function sampleHomeWishIds(
  candidateIds: readonly string[],
  previousIds: readonly string[],
  draw: (maxExclusive: number) => number = randomInt
): string[] {
  const previous = new Set(previousIds);
  const candidates = [...new Set(candidateIds)];
  const fresh = candidates.filter((id) => !previous.has(id));
  const fallback = candidates.filter((id) => previous.has(id));
  const selected: string[] = [];
  for (const pool of [fresh, fallback]) {
    while (selected.length < 2 && pool.length) {
      const index = draw(pool.length);
      selected.push(pool[index]!);
      pool[index] = pool[pool.length - 1]!;
      pool.pop();
    }
  }
  return selected;
}
