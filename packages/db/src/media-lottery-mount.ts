import { isMemberId, mediaBudgetDay, mediaBudgetFail } from '@artzoo/domain';
import type { Prisma } from './generated/prisma/client.js';
import type { LotteryMountReceipt, LotteryPhotoComponent } from './media-lottery-orphan-contract.js';
type Tx = Prisma.TransactionClient;
type MountComponent = Omit<LotteryPhotoComponent, 'storageIdentityFingerprint'> & {
  storageIdentityFingerprint: string | null;
};
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function keys(accountId: string, ids: readonly string[]) {
  if (!isMemberId(accountId) || ids.length > 20 || ids.some((id) => !isMemberId(id)))
    mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  return [...new Set(ids.map((id) => 'lottery:' + accountId.toLowerCase() + ':' + id.toLowerCase()))];
}
function transaction(tx: Tx) {
  if (
    typeof (tx as { $connect?: unknown }).$connect === 'function' ||
    typeof (tx as { $disconnect?: unknown }).$disconnect === 'function'
  )
    mediaBudgetFail('MEDIA_BUDGET_TRANSACTION_REQUIRED');
}
/** Caller holds existing lottery:write exclusive/shared lock; no new locks here.
 * OFF also protects permanently retired new typed generations. */
export async function lotteryMediaFencedTx(tx: Tx, accountId: string, ids: readonly string[]) {
  transaction(tx);
  const objects = keys(accountId, ids);
  if (!objects.length) return false;
  const [row] = await tx.$queryRaw<{ found: boolean }[]>`/*lottery-orphan:attachment-fence*/
    SELECT EXISTS(
      SELECT 1 FROM "MediaRetirementIntent" i
      JOIN "MediaStoredComponent" c ON c.id=i."componentId"
      JOIN "MediaUploadReceipt" r ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='lottery-image' AND c.policy='PHOTO_VARIANT'
        AND c."objectKey"=ANY(${objects}::text[]) AND r.scope='lottery-image'
        AND r."accountId"=${accountId} AND r.state='COMMITTED'
        AND r."objectIdentity"=c."objectKey" AND r."attemptId"=c.generation
    ) AS found`;
  if (!row || typeof row.found !== 'boolean') mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
  return row.found;
}
/** Same original publish transaction/lottery:write lock as the Lottery INSERT.
 * Legacy aggregate rows are not adopted. Started UNKNOWN/RESERVED readable bytes
 * may already be attached under old rules: stamp these too before same-generation completion. */
export async function markLotteryMediaMountedTx(
  tx: Tx,
  accountId: string,
  ids: readonly string[],
  now: Date
) {
  transaction(tx);
  mediaBudgetDay(now);
  const objects = keys(accountId, ids);
  if (!objects.length) return;
  const rows = await tx.$queryRaw<LotteryMountReceipt[]>`/*lottery-orphan:mount-receipts*/
    SELECT r.* FROM "MediaUploadReceipt" r
    WHERE r.scope='lottery-image' AND r."accountId"=${accountId} AND r."objectIdentity"=ANY(${objects}::text[])
      AND EXISTS(SELECT 1 FROM "MediaStoredComponent" c
        WHERE c."receiptScope"=r.scope AND c."receiptOperationKey"=r."operationKey"
          AND c.namespace='lottery-image' AND c.policy='PHOTO_VARIANT')
    ORDER BY r."operationKey" FOR UPDATE OF r`;
  if (rows.length > objects.length) mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  for (const receipt of rows) {
    if (
      receipt.scope !== 'lottery-image' ||
      receipt.accountId !== accountId ||
      !objects.includes(receipt.objectIdentity ?? '') ||
      !isMemberId(receipt.attemptId ?? '') ||
      !['RESERVED', 'UNKNOWN', 'COMMITTED'].includes(receipt.state) ||
      !(receipt.persistenceStartedAt instanceof Date) ||
      !Number.isFinite(receipt.persistenceStartedAt.getTime()) ||
      receipt.persistenceStartedAt > now ||
      receipt.metadataReservedBytes !== 0n ||
      !hash(receipt.fingerprint) ||
      !Object.hasOwn(receipt, 'lotteryMountedAt')
    )
      mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
    const parts = await tx.$queryRaw<MountComponent[]>`/*lottery-orphan:mount-components*/
      SELECT * FROM "MediaStoredComponent" WHERE "receiptScope"='lottery-image'
        AND "receiptOperationKey"=${receipt.operationKey} ORDER BY part FOR UPDATE`;
    if (
      parts.length !== 3 ||
      new Set(parts.map((p) => p.part)).size !== 3 ||
      parts.some(
        (p) =>
          p.sourceKind !== 'RECEIPT' ||
          p.baselineStateId !== null ||
          p.baselineFingerprint !== null ||
          p.namespace !== 'lottery-image' ||
          p.policy !== 'PHOTO_VARIANT' ||
          !['photo-original', 'photo-preview', 'photo-thumbnail'].includes(p.part) ||
          p.receiptScope !== receipt.scope ||
          p.receiptOperationKey !== receipt.operationKey ||
          p.objectKey !== receipt.objectIdentity ||
          p.generation !== receipt.attemptId ||
          !hash(p.id) ||
          !hash(p.contentBindingSha256) ||
          typeof p.chargedBytes !== 'bigint' ||
          p.chargedBytes <= 0n ||
          p.chargedBytes > (p.part === 'photo-original' ? 31457280n : 62914560n)
      ) ||
      parts.reduce((sum, p) => sum + p.chargedBytes, 0n) !== receipt.storedBytes
    )
      mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
    const [fence] = await tx.$queryRaw<{ found: boolean }[]>`/*lottery-orphan:mount-fence*/
      SELECT EXISTS(SELECT 1 FROM "MediaRetirementIntent" i JOIN "MediaStoredComponent" c ON c.id=i."componentId"
        WHERE c."receiptScope"='lottery-image' AND c."receiptOperationKey"=${receipt.operationKey}) AS found`;
    if (!fence || typeof fence.found !== 'boolean' || fence.found)
      mediaBudgetFail('MEDIA_BOUND_INTENT_REQUIRED');
    if (receipt.lotteryMountedAt !== null) {
      if (
        !(receipt.lotteryMountedAt instanceof Date) ||
        !Number.isFinite(receipt.lotteryMountedAt.getTime()) ||
        receipt.lotteryMountedAt > now
      )
        mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
      continue;
    }
    const changed = await tx.$executeRaw`/*lottery-orphan:mount*/
      UPDATE "MediaUploadReceipt" SET "lotteryMountedAt"=${now}
      WHERE scope='lottery-image' AND "operationKey"=${receipt.operationKey}
        AND "accountId"=${accountId} AND "objectIdentity"=${receipt.objectIdentity}
        AND "attemptId"=${receipt.attemptId} AND "lotteryMountedAt" IS NULL`;
    if (changed !== 1) mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  }
}
