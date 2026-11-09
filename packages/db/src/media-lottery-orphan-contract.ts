import type { MediaBudgetReceipt } from './media-budget.js';

export const LOTTERY_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
export const LOTTERY_ORPHAN_BATCH_LIMIT = 10;
export const LOTTERY_ORPHAN_BATCH_BYTES = 256n * 1024n * 1024n;
export const LOTTERY_PHOTO_PARTS = ['photo-original', 'photo-preview', 'photo-thumbnail'] as const;
declare const candidateBrand: unique symbol;
declare const batchBrand: unique symbol;
export type LotteryOrphanCandidate = object & { readonly [candidateBrand]: never };
export type LotteryOrphanBatch = object & { readonly [batchBrand]: never };
export interface LotteryOrphanCursor {
  readonly createdAt: Date;
  readonly componentId: string;
}
export interface LotteryPhotoComponent {
  id: string;
  sourceKind: 'RECEIPT' | 'BASELINE';
  receiptScope: string | null;
  receiptOperationKey: string | null;
  baselineStateId: string | null;
  baselineFingerprint: string | null;
  namespace: string;
  objectKey: string;
  generation: string;
  part: (typeof LOTTERY_PHOTO_PARTS)[number];
  policy: string;
  chargedBytes: bigint;
  contentBindingSha256: string;
  storageIdentityFingerprint: string;
  createdAt: Date;
}
export interface LotteryOrphanDescription {
  id: string;
  accountId: string;
  operationKey: string;
  generation: string;
  fingerprint: string;
  components: readonly LotteryPhotoComponent[];
  intents: readonly {
    id: string;
    componentId: string;
    identityFingerprint: string;
    authorityFingerprint: string;
    createdAt: Date;
  }[];
}
/** DTOs describe facts only. Only the DB module's private WeakMap authorizes a batch. */
export interface LotteryMountReceipt extends MediaBudgetReceipt {
  lotteryMountedAt: Date | null;
}
export interface LotteryOrphanCandidateDescription {
  id: string;
  receipt: LotteryMountReceipt;
  cursor: LotteryOrphanCursor;
}
