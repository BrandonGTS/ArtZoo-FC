import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

type ConflictCode = '40P01' | '40001' | 'P2034';

function property(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Inspect only bounded, known Prisma/pg wrappers; never stringify an error or its message. */
function hasCode(error: unknown, matches: (value: unknown) => boolean): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seen = new Set<unknown>();
  let inspected = 0;
  while (pending.length && inspected++ < 32) {
    const item = pending.shift()!;
    if (!item.value || typeof item.value !== 'object' || seen.has(item.value)) continue;
    seen.add(item.value);
    if (
      matches(property(item.value, 'code')) ||
      matches(property(item.value, 'sqlState')) ||
      matches(property(item.value, 'originalCode'))
    )
      return true;
    if (item.depth >= 5) continue;
    for (const key of ['cause', 'meta', 'driverAdapterError', 'originalError']) {
      const value = property(item.value, key);
      if (value && typeof value === 'object') pending.push({ value, depth: item.depth + 1 });
    }
  }
  return false;
}

export function transactionConflictCode(error: unknown): ConflictCode | null {
  for (const code of ['40P01', '40001', 'P2034'] as const) {
    if (hasCode(error, (value) => value === code)) return code;
  }
  return null;
}

export function isTransactionTimeout(error: unknown): boolean {
  return hasCode(error, (value) => value === 'P2028');
}

export interface TransactionReplayOptions {
  /** Opt in only after auditing the ENTIRE transaction callback for safe replay. */
  replaySafe: boolean;
  /** Injectable wait for deterministic tests; normal callers use bounded random backoff. */
  wait?: (milliseconds: number) => Promise<void>;
  jitter?: (upperExclusive: number) => number;
}

/** Each action must start a NEW transaction; never retry a statement in an aborted transaction.
 * The callback must reread trusted time/permissions after its locks on every attempt.
 * External I/O (SMS, QQ, HTTP or files) must not be included in a replayable action.
 * Default is one attempt. Opted-in callbacks get at most two EXTRA attempts. */
export async function withTransactionRetry<T>(
  action: () => Promise<T>,
  options: TransactionReplayOptions = { replaySafe: false }
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (
        !options.replaySafe ||
        attempt >= 2 ||
        isTransactionTimeout(error) ||
        !transactionConflictCode(error)
      )
        throw error;
      const base = 20 * 2 ** attempt;
      const jitter = (options.jitter ?? randomInt)(base);
      // Invalid injected jitter fails closed instead of producing an unbounded delay.
      if (!Number.isSafeInteger(jitter) || jitter < 0 || jitter >= base) throw error;
      await (options.wait ?? delay)(base + jitter);
    }
  }
}
