import type { MediaBudgetReceipt } from './media-budget.js';
import {
  DAILY_PHOTO_PARTS,
  DAILY_ORPHAN_TTL_MS,
  type DailyOrphanCursor,
  type DailyPhotoComponent
} from './media-orphan-contract.js';
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const time = (v: unknown): v is Date => v instanceof Date && Number.isFinite(v.getTime());
/** Pure validation only: no SQL, capability mint, proof adoption, credit or IO. */
export function matchesPhotoOrphan(
  scope: 'daily' | 'wish' | 'lottery-image' | 'knowledge' | 'album-comment',
  cursor: DailyOrphanCursor,
  receipt: MediaBudgetReceipt,
  mediaCreatedAt: Date,
  components: readonly DailyPhotoComponent[],
  now: Date
): boolean {
  if (
    components.length !== 3 ||
    new Set(components.map((c) => c.part)).size !== 3 ||
    components.some(
      (c) =>
        c.sourceKind !== 'RECEIPT' ||
        c.baselineStateId !== null ||
        c.baselineFingerprint !== null ||
        c.namespace !== scope ||
        c.policy !== 'PHOTO_VARIANT' ||
        c.receiptScope !== scope ||
        c.receiptOperationKey !== receipt.operationKey ||
        c.objectKey !== receipt.objectIdentity ||
        c.generation !== receipt.attemptId ||
        !digest(c.id) ||
        !DAILY_PHOTO_PARTS.includes(c.part) ||
        !digest(c.contentBindingSha256) ||
        !digest(c.storageIdentityFingerprint) ||
        typeof c.chargedBytes !== 'bigint' ||
        c.chargedBytes <= 0n ||
        c.chargedBytes > (c.part === 'photo-original' ? 31457280n : 62914560n)
    ) ||
    components.reduce((sum, c) => sum + c.chargedBytes, 0n) !== receipt.storedBytes ||
    !components.some(
      (c) =>
        c.id === cursor.componentId &&
        time(c.createdAt) &&
        c.createdAt.getTime() === cursor.createdAt.getTime()
    )
  )
    return false;
  const times = [
    receipt.createdAt,
    receipt.storageReservedAt,
    receipt.persistenceStartedAt,
    receipt.settledAt,
    mediaCreatedAt,
    ...components.map((c) => c.createdAt)
  ];
  if (
    times.some((t) => !time(t) || t.getTime() > now.getTime()) ||
    !time(receipt.createdAt) ||
    !time(receipt.storageReservedAt) ||
    !time(receipt.persistenceStartedAt) ||
    !time(receipt.settledAt) ||
    receipt.storageReservedAt < receipt.createdAt ||
    receipt.persistenceStartedAt < receipt.storageReservedAt ||
    receipt.settledAt < receipt.persistenceStartedAt ||
    now.getTime() - Math.max(...times.map((t) => t!.getTime())) <= DAILY_ORPHAN_TTL_MS
  )
    return false;
  return true;
}
