import { sealBoundAllocation, validateBoundAllocation } from './media-stock-components.js';
import type {
  MediaComponentAllocation,
  MediaBoundComponentAllocation,
  MediaBoundAllocationTicket
} from './media-stock-components.js';
import { randomUUID } from 'node:crypto';
import type { MediaBudgetPolicy, MediaRawReservationInput } from '@artzoo/domain';
import {
  allocateMediaStorage,
  beginMediaPersistence,
  commitMediaBudget,
  failMediaBeforePersistence,
  markMediaBudgetUnknown,
  reserveRawMediaBudget,
  type MediaBudgetTx,
  type MediaReceiptState
} from './media-budget.js';
export interface MediaBudgetTransactionPort {
  $transaction<T>(action: (tx: MediaBudgetTx) => Promise<T>): Promise<T>;
}
export interface MediaBudgetAttempt {
  allocate(mediaBytes: bigint, metadataBytes?: bigint): Promise<void>;
  allocateComponents(allocation: MediaComponentAllocation): Promise<void>;
  allocateBoundComponents(allocation: MediaBoundComponentAllocation): Promise<MediaBoundAllocationTicket>;
  begin(): Promise<void>;
  commit(tx: MediaBudgetTx): Promise<void>;
  unknown(): Promise<void>;
  failBeforePersistence(): Promise<void>;
}
export type PreparedMediaBudget =
  | { kind: 'disabled' }
  | { kind: 'existing'; state: MediaReceiptState; objectIdentity: string | null }
  | { kind: 'owner'; attempt: MediaBudgetAttempt };
/** No auth/storage access. Call only after original authorization and authorized replay inspection. */
export function createMediaBudgetAdapter(
  db: MediaBudgetTransactionPort,
  policy: MediaBudgetPolicy,
  clock: () => Date
) {
  return {
    async prepare(input: Omit<MediaRawReservationInput, 'attemptId'>): Promise<PreparedMediaBudget> {
      // Disabled path does not validate input, generate IDs, inspect time, invoke transactions or touch IO.
      if (!policy.enabled) return { kind: 'disabled' };
      const owned = { ...input, attemptId: randomUUID() };
      const row = await db.$transaction((tx) => reserveRawMediaBudget(tx, owned, policy, clock()));
      if (!row) throw Error('MEDIA_BUDGET_UNEXPECTED_DISABLED');
      if (
        row.attemptId !== owned.attemptId ||
        row.objectIdentity !== owned.objectIdentity ||
        row.state !== 'RESERVED'
      )
        return { kind: 'existing', state: row.state, objectIdentity: row.objectIdentity };
      // A safe FAILED retry has a private child key; callers keep their original logical key/API.
      const active = { ...owned, operationKey: row.operationKey };
      const expected = { ...active, storedBytes: 0n };
      return {
        kind: 'owner',
        attempt: {
          async allocate(mediaBytes, metadataBytes = 0n) {
            await db.$transaction((tx) =>
              allocateMediaStorage(tx, active, { mediaBytes, metadataBytes }, policy, clock())
            );
          },
          async allocateComponents(allocation) {
            const mediaBytes =
              allocation.kind === 'official' || allocation.kind === 'photo'
                ? allocation.originalBytes + allocation.previewBytes + allocation.thumbnailBytes
                : allocation.kind === 'avatar'
                  ? allocation.fullBytes + allocation.smallBytes
                  : allocation.mediaBytes;
            const metadataBytes = allocation.kind === 'knowledge' ? allocation.journalBytes : 0n;
            await db.$transaction((tx) =>
              allocateMediaStorage(tx, active, { mediaBytes, metadataBytes }, policy, clock(), allocation)
            );
          },
          async allocateBoundComponents(allocation) {
            validateBoundAllocation(allocation);
            const mediaBytes =
              allocation.kind === 'official' || allocation.kind === 'photo'
                ? allocation.originalBytes + allocation.previewBytes + allocation.thumbnailBytes
                : allocation.kind === 'avatar'
                  ? allocation.fullBytes + allocation.smallBytes
                  : allocation.mediaBytes;
            const metadataBytes = allocation.kind === 'knowledge' ? allocation.journalBytes : 0n;
            await db.$transaction((tx) =>
              allocateMediaStorage(tx, active, { mediaBytes, metadataBytes }, policy, clock(), allocation)
            );
            return sealBoundAllocation(active, allocation);
          },
          // Resolution means the unique claim transaction has committed. IO must start only after awaiting it.
          async begin() {
            await db.$transaction((tx) => beginMediaPersistence(tx, expected, clock()));
          },
          async commit(tx) {
            await commitMediaBudget(tx, expected, clock());
          },
          async unknown() {
            await db.$transaction((tx) => markMediaBudgetUnknown(tx, expected, clock()));
          },
          async failBeforePersistence() {
            await db.$transaction((tx) => failMediaBeforePersistence(tx, expected, clock()));
          }
        }
      };
    }
  };
}
