import { beijingDateKey } from './beijing-time.js';

export const MEDIA_BUDGET_INT64_MAX = 9_223_372_036_854_775_807n;
export class MediaBudgetError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function mediaBudgetFail(code: string): never {
  throw new MediaBudgetError(code);
}
export function mediaByteCount(value: bigint, positive = false): bigint {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value > MEDIA_BUDGET_INT64_MAX)
    mediaBudgetFail('MEDIA_BUDGET_INVALID_BYTES');
  return value;
}
export function addMediaBytes(a: bigint, b: bigint): bigint {
  return mediaByteCount(mediaByteCount(a) + mediaByteCount(b));
}
export function mediaBudgetDay(now: Date): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) mediaBudgetFail('MEDIA_BUDGET_INVALID_TIME');
  const day = beijingDateKey(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) mediaBudgetFail('MEDIA_BUDGET_INVALID_TIME');
  return day;
}
export interface MediaBudgetPolicy {
  enabled: boolean;
  cleanupExecute: boolean;
  globalLimitBytes: bigint;
  dailyLimitBytes: bigint;
}
export function mediaBudgetPolicy(env: Record<string, string | undefined>): MediaBudgetPolicy {
  const flag = (key: string) => {
    const value = env[key] ?? '0';
    if (value !== '0' && value !== '1') mediaBudgetFail('MEDIA_BUDGET_INVALID_FLAG');
    return value === '1';
  };
  const bytes = (key: string, fallback: string) => {
    const value = env[key] ?? fallback;
    if (!/^[1-9]\d{0,18}$/.test(value)) mediaBudgetFail('MEDIA_BUDGET_INVALID_CONFIG');
    return mediaByteCount(BigInt(value), true);
  };
  return {
    enabled: flag('ARTZOO_MEDIA_BUDGET_ENABLED'),
    cleanupExecute: flag('ARTZOO_MEDIA_CLEANUP_EXECUTE'),
    globalLimitBytes: bytes('ARTZOO_MEDIA_GLOBAL_LIMIT_BYTES', '10000000000'),
    dailyLimitBytes: bytes('ARTZOO_MEDIA_DAILY_LIMIT_BYTES', '2000000000')
  };
}
export interface MediaReservationInput {
  scope: string;
  operationKey: string;
  fingerprint: string;
  accountId: string | null;
  rawBytes: bigint;
  storedBytes: bigint;
}
export function validateMediaReservation(input: MediaReservationInput): void {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(input.scope) ||
    typeof input.operationKey !== 'string' ||
    !input.operationKey.length ||
    input.operationKey.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(input.operationKey) ||
    !/^[a-f0-9]{64}$/.test(input.fingerprint) ||
    (input.accountId !== null &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.accountId))
  )
    mediaBudgetFail('MEDIA_BUDGET_INVALID_IDENTITY');
  mediaByteCount(input.rawBytes, true);
  mediaByteCount(input.storedBytes);
}

export interface MediaWriterIdentity {
  attemptId: string;
  objectIdentity: string;
}
export type MediaWriterReservationInput = MediaReservationInput & MediaWriterIdentity;
export type MediaRawReservationInput = Omit<MediaWriterReservationInput, 'storedBytes'>;
export function validateMediaWriter(input: MediaWriterIdentity): void {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.attemptId) ||
    typeof input.objectIdentity !== 'string' ||
    input.objectIdentity.length > 256 ||
    !/^[a-z][a-z0-9-]{0,31}:[a-zA-Z0-9:._-]{1,220}$/.test(input.objectIdentity)
  )
    mediaBudgetFail('MEDIA_BUDGET_WRITER_IDENTITY_REQUIRED');
}

/** Internal ledger links; never accepted from upload request bodies or returned by the shared adapter. */
export interface MediaReceiptRetryLinks {
  retryHeadKey: string | null;
  retryRootKey: string | null;
}
