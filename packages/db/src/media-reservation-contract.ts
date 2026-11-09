import type { MediaBudgetReceipt } from './media-budget.js';

/** Enrollment is written only by new server reserve/retry transactions. NULL is never adopted. */
export const MEDIA_RESERVATION_PROTOCOL = 'prewrite-expiry-v1';
export const MEDIA_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;
export const MEDIA_RESERVATION_BATCH_LIMIT = 10;
export const MEDIA_RESERVATION_BATCH_BYTES = 256n * 1024n * 1024n;
export const MEDIA_RESERVATION_SCOPES = [
  'avatar',
  'album-photo',
  'album-comment',
  'knowledge',
  'daily',
  'wish',
  'activity-share',
  'lottery-image',
  'official-image'
] as const;
export type MediaReservationScope = (typeof MEDIA_RESERVATION_SCOPES)[number];
export interface MediaReservationCursor {
  readonly createdAt: Date;
  readonly scope: string;
  readonly operationKey: string;
}
declare const candidateBrand: unique symbol;
/** Only listMediaReservationCandidates can mint a usable candidate; JSON/casts are not authority. */
export interface MediaReservationCandidate {
  readonly [candidateBrand]: true;
}
export interface MediaReservationCandidatePage {
  readonly candidates: readonly MediaReservationCandidate[];
  readonly nextCursor: MediaReservationCursor | null;
}
/** Ordinary bounded keyset read over enrolled RESERVED/prewrite rows. No locks, no wrap;
 * nextCursor=null ends this pass; a later pass starts with after omitted. */
export interface MediaReservationListInput {
  readonly now: Date;
  readonly after?: MediaReservationCursor;
  readonly limit?: number;
}
export type MediaReservationExpiryResult =
  | { readonly kind: 'expired'; readonly releasedStoredBytes: bigint; readonly releasedRawBytes: bigint }
  | {
      readonly kind: 'retained';
      readonly reason:
        | 'unknown'
        | 'started'
        | 'recent'
        | 'legacy'
        | 'changed-generation'
        | 'already-terminal'
        | 'invalid-time'
        | 'invalid-state';
    };
/** operationKey is the logical root key, never a client supplied retry child key. */
export interface MediaReservationReconcileInput {
  readonly scope: string;
  readonly operationKey: string;
  readonly accountId: string | null;
  readonly fingerprint: string;
  readonly rawBytes: bigint;
}
export type MediaReservationReconciliation =
  | { readonly kind: 'missing' | 'conflict' }
  | {
      readonly kind: 'committed' | 'active-prewrite' | 'preserve' | 'failed-retry';
      /** Authoritative root/head tuple, read in one statement; not an authorization or storage proof. */
      readonly receipt: Readonly<MediaBudgetReceipt>;
    };
