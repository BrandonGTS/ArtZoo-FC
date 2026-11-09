import type { MediaBudgetReceipt } from './media-budget.js';

export const KNOWLEDGE_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
export const KNOWLEDGE_ORPHAN_BATCH_LIMIT = 10;
export const KNOWLEDGE_ORPHAN_BATCH_BYTES = 256n * 1024n * 1024n;
export const KNOWLEDGE_PHOTO_PARTS = ['photo-original', 'photo-preview', 'photo-thumbnail'] as const;
declare const candidateBrand: unique symbol;
declare const batchBrand: unique symbol;
export type KnowledgeOrphanCandidate = object & { readonly [candidateBrand]: never };
export type KnowledgeOrphanBatch = object & { readonly [batchBrand]: never };
export interface KnowledgeOrphanCursor {
  readonly createdAt: Date;
  readonly componentId: string;
}
export interface KnowledgePhotoComponent {
  id: string;
  sourceKind: 'RECEIPT' | 'BASELINE';
  receiptScope: string | null;
  receiptOperationKey: string | null;
  baselineStateId: string | null;
  baselineFingerprint: string | null;
  namespace: string;
  objectKey: string;
  generation: string;
  part: (typeof KNOWLEDGE_PHOTO_PARTS)[number];
  policy: string;
  chargedBytes: bigint;
  contentBindingSha256: string;
  storageIdentityFingerprint: string;
  createdAt: Date;
}
export interface KnowledgeOrphanDescription {
  id: string;
  accountId: string;
  operationKey: string;
  generation: string;
  fingerprint: string;
  components: readonly KnowledgePhotoComponent[];
  intents: readonly {
    id: string;
    componentId: string;
    identityFingerprint: string;
    authorityFingerprint: string;
    createdAt: Date;
  }[];
}
/** DTOs describe facts only. Only the DB module's private WeakMap authorizes a batch. */
export interface KnowledgeOrphanCandidateDescription {
  id: string;
  receipt: MediaBudgetReceipt;
  cursor: KnowledgeOrphanCursor;
}
