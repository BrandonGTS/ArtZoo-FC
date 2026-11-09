import { createHash } from 'node:crypto';
import { isMemberId, mediaBudgetDay, mediaBudgetFail, type MediaBudgetPolicy } from '@artzoo/domain';
import type { PrismaClient, Prisma } from './generated/prisma/client.js';
import type { MediaBudgetReceipt } from './media-budget.js';
import { MEDIA_RESERVATION_PROTOCOL } from './media-reservation-contract.js';
import {
  DAILY_ORPHAN_TTL_MS,
  DAILY_ORPHAN_BATCH_LIMIT,
  type DailyOrphanCursor,
  type DailyPhotoComponent
} from './media-orphan-contract.js';
import { matchesPhotoOrphan } from './media-photo-orphan-checks.js';
import { createMaintenanceState, runMaintenanceItem, type MaintenanceRunState } from './maintenance-run.js';
type Tx = Prisma.TransactionClient;
type Scope = 'daily' | 'wish';
type Candidate = MediaBudgetReceipt & { cursorId: string; componentCreatedAt: Date };
type Business = {
  id: string;
  ownerId: string;
  fingerprint: string;
  batchId: string;
  batchIndex: number;
  postId?: string | null;
  wishId?: string | null;
  commentId: string | null;
  removedAt: Date | null;
  createdAt: Date;
};
type Ack = {
  id: string;
  componentId: string;
  identityFingerprint: string;
  authorityFingerprint: string;
  state: string;
  createdAt: Date;
  acknowledgedAt: Date | null;
};
type Credit = {
  componentId: string;
  intentId: string;
  bytes: bigint;
  evidenceFingerprint: string;
  createdAt: Date;
};
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const time = (v: unknown): v is Date => v instanceof Date && Number.isFinite(v.getTime());
export interface MediaOrphanCompletionOptions {
  now?: () => Date;
  after?: DailyOrphanCursor;
  state?: MaintenanceRunState;
}
export interface MediaOrphanCompletionResult {
  enabled: boolean;
  scanned: number;
  tombstoned: number;
  retained: number;
  failed: number;
  nextCursor: DailyOrphanCursor | null;
}
async function complete(tx: Tx, old: Candidate, now: Date): Promise<boolean> {
  mediaBudgetDay(now);
  const scope = old.scope;
  if (
    !['daily', 'wish'].includes(scope) ||
    !isMemberId(old.accountId ?? '') ||
    !old.objectIdentity?.startsWith(scope + ':') ||
    !isMemberId(old.objectIdentity.slice(scope.length + 1)) ||
    !digest(old.cursorId) ||
    !time(old.componentCreatedAt)
  )
    return false;
  const id = old.objectIdentity.slice(scope.length + 1);
  await tx.$queryRaw`/*orphan-completion:owner*/ SELECT pg_advisory_xact_lock(hashtextextended(${scope + '-media:' + old.accountId},0))::text`;
  const [business] =
    scope === 'daily'
      ? await tx.$queryRaw<Business[]>`/*orphan-completion:daily*/ SELECT * FROM "DailyMedia" WHERE id=${id}`
      : await tx.$queryRaw<Business[]>`/*orphan-completion:wish*/ SELECT * FROM "WishMedia" WHERE id=${id}`;
  if (
    !business ||
    business.ownerId !== old.accountId ||
    business.fingerprint !== old.fingerprint ||
    business.commentId !== null ||
    (scope === 'daily' ? business.postId : business.wishId) !== null ||
    business.removedAt !== null ||
    !isMemberId(business.batchId) ||
    !Number.isSafeInteger(business.batchIndex) ||
    business.batchIndex < 0 ||
    old.operationKey !== business.ownerId + ':' + business.batchId + ':' + business.batchIndex
  )
    return false;
  const [global] = await tx.$queryRaw<
    { id: string }[]
  >`/*orphan-completion:global*/ SELECT id FROM "MediaBudgetState" WHERE id='global' FOR UPDATE`;
  if (!global) mediaBudgetFail('MEDIA_BUDGET_STATE_MISSING');
  const [receipt] = await tx.$queryRaw<
    MediaBudgetReceipt[]
  >`/*orphan-completion:receipt*/ SELECT * FROM "MediaUploadReceipt" WHERE scope=${scope} AND "operationKey"=${old.operationKey} FOR UPDATE`;
  if (
    !receipt ||
    receipt.scope !== scope ||
    receipt.state !== 'COMMITTED' ||
    receipt.reservationProtocol !== MEDIA_RESERVATION_PROTOCOL ||
    receipt.accountId !== old.accountId ||
    receipt.objectIdentity !== scope + ':' + id ||
    receipt.attemptId !== old.attemptId ||
    !isMemberId(receipt.attemptId ?? '') ||
    receipt.fingerprint !== old.fingerprint ||
    !digest(receipt.fingerprint) ||
    receipt.storedBytes !== old.storedBytes ||
    receipt.metadataReservedBytes !== 0n
  )
    return false;
  const components = await tx.$queryRaw<
    DailyPhotoComponent[]
  >`/*orphan-completion:components*/ SELECT * FROM "MediaStoredComponent" WHERE "receiptScope"=${scope} AND "receiptOperationKey"=${receipt.operationKey} ORDER BY part FOR UPDATE`;
  if (
    !matchesPhotoOrphan(
      scope as Scope,
      { createdAt: old.componentCreatedAt, componentId: old.cursorId },
      receipt,
      business.createdAt,
      components,
      now
    )
  )
    return false;
  const authority = hash([
    scope + '-never-mounted-v1',
    id,
    receipt.accountId,
    receipt.attemptId,
    receipt.operationKey,
    receipt.fingerprint
  ]);
  const eligibleAfter =
    Math.max(
      business.createdAt.getTime(),
      receipt.createdAt.getTime(),
      receipt.storageReservedAt!.getTime(),
      receipt.persistenceStartedAt!.getTime(),
      receipt.settledAt!.getTime(),
      ...components.map((c) => c.createdAt.getTime())
    ) + DAILY_ORPHAN_TTL_MS;
  for (const c of components) {
    const [intent] = await tx.$queryRaw<
      Ack[]
    >`/*orphan-completion:intent*/ SELECT * FROM "MediaRetirementIntent" WHERE "componentId"=${c.id} FOR UPDATE`;
    if (
      !intent ||
      intent.id !== hash(['media-retirement-v1', c.id, c.storageIdentityFingerprint, authority]) ||
      intent.componentId !== c.id ||
      intent.state !== 'ACKNOWLEDGED' ||
      intent.identityFingerprint !== c.storageIdentityFingerprint ||
      intent.authorityFingerprint !== authority ||
      !time(intent.createdAt) ||
      !time(intent.acknowledgedAt) ||
      intent.createdAt.getTime() <= eligibleAfter ||
      intent.acknowledgedAt < intent.createdAt ||
      intent.acknowledgedAt > now
    )
      return false;
    const [credit] = await tx.$queryRaw<
      Credit[]
    >`/*orphan-completion:credit*/ SELECT * FROM "MediaStorageCredit" WHERE "componentId"=${c.id} FOR UPDATE`;
    if (
      !credit ||
      credit.componentId !== c.id ||
      credit.intentId !== intent.id ||
      credit.bytes !== c.chargedBytes ||
      credit.evidenceFingerprint !==
        hash([scope + '-durable-unlink-v1', intent.id, c.id, c.generation, c.storageIdentityFingerprint]) ||
      !time(credit.createdAt) ||
      credit.createdAt.getTime() !== intent.acknowledgedAt.getTime()
    )
      return false;
  }
  // Keep the original unique upload key/fingerprint forever: deleting it would let OFF retries revive.
  const changed =
    scope === 'daily'
      ? await tx.$executeRaw`/*orphan-completion:mark-daily*/ UPDATE "DailyMedia" SET "removedAt"=${now} WHERE id=${id} AND "ownerId"=${receipt.accountId} AND fingerprint=${receipt.fingerprint} AND "postId" IS NULL AND "commentId" IS NULL AND "removedAt" IS NULL`
      : await tx.$executeRaw`/*orphan-completion:mark-wish*/ UPDATE "WishMedia" SET "removedAt"=${now} WHERE id=${id} AND "ownerId"=${receipt.accountId} AND fingerprint=${receipt.fingerprint} AND "wishId" IS NULL AND "commentId" IS NULL AND "removedAt" IS NULL`;
  if (changed !== 1) mediaBudgetFail('MEDIA_BUDGET_STATE_MISMATCH');
  return true;
}
/** Confirmed physical ACK only. No FS, credit, DELETE, audit mutation or legacy adoption; original owner/global lock order. */
export async function processMediaOrphanCompletion(
  db: PrismaClient,
  policy: MediaBudgetPolicy,
  options?: MediaOrphanCompletionOptions
): Promise<MediaOrphanCompletionResult> {
  const result: MediaOrphanCompletionResult = {
    enabled: false,
    scanned: 0,
    tombstoned: 0,
    retained: 0,
    failed: 0,
    nextCursor: null
  };
  if (policy.enabled !== true || policy.cleanupExecute !== true) return result;
  result.enabled = true;
  if (typeof db.$connect !== 'function' || typeof db.$disconnect !== 'function')
    mediaBudgetFail('MEDIA_BUDGET_ROOT_CLIENT_REQUIRED');
  const state = options?.state ?? createMaintenanceState();
  const before = state.failed;
  const after = options?.after;
  result.nextCursor = after ?? null;
  if (state.stopping()) return result;
  const clock = options?.now ?? (() => new Date());
  const now = clock();
  mediaBudgetDay(now);
  if (after && (!time(after.createdAt) || !digest(after.componentId)))
    mediaBudgetFail('MEDIA_BUDGET_INVALID_TIME');
  const cutoff = new Date(now.getTime() - DAILY_ORPHAN_TTL_MS);
  const txOptions = { maxWait: 5000, timeout: 15000 };
  const rows = await runMaintenanceItem(state, 'mediaOrphanCompletion.list', 'batch', () =>
    db.$transaction(
      async (tx) =>
        after
          ? tx.$queryRaw<
              Candidate[]
            >`/*orphan-completion:list-after*/ SELECT r.*,c.id AS "cursorId",c."createdAt" AS "componentCreatedAt" FROM "MediaStoredComponent" c JOIN "MediaUploadReceipt" r ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey" JOIN "MediaRetirementIntent" i ON i."componentId"=c.id WHERE r.scope IN ('daily','wish') AND c.namespace=r.scope AND c.policy='PHOTO_VARIANT' AND c.part='photo-original' AND r.state='COMMITTED' AND r."reservationProtocol"=${MEDIA_RESERVATION_PROTOCOL} AND i.state='ACKNOWLEDGED' AND c."createdAt"<${cutoff} AND (c."createdAt",c.id)>(${after.createdAt},${after.componentId}) ORDER BY c."createdAt",c.id LIMIT ${DAILY_ORPHAN_BATCH_LIMIT}`
          : tx.$queryRaw<
              Candidate[]
            >`/*orphan-completion:list*/ SELECT r.*,c.id AS "cursorId",c."createdAt" AS "componentCreatedAt" FROM "MediaStoredComponent" c JOIN "MediaUploadReceipt" r ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey" JOIN "MediaRetirementIntent" i ON i."componentId"=c.id WHERE r.scope IN ('daily','wish') AND c.namespace=r.scope AND c.policy='PHOTO_VARIANT' AND c.part='photo-original' AND r.state='COMMITTED' AND r."reservationProtocol"=${MEDIA_RESERVATION_PROTOCOL} AND i.state='ACKNOWLEDGED' AND c."createdAt"<${cutoff} ORDER BY c."createdAt",c.id LIMIT ${DAILY_ORPHAN_BATCH_LIMIT}`,
      txOptions
    )
  );
  if (rows) {
    if (rows.length > DAILY_ORPHAN_BATCH_LIMIT) mediaBudgetFail('MEDIA_ORPHAN_BATCH_INVALID');
    let acknowledged = true;
    let cursor = after ?? null;
    for (const candidate of rows) {
      if (!time(candidate.componentCreatedAt) || !digest(candidate.cursorId))
        mediaBudgetFail('MEDIA_ORPHAN_BATCH_INVALID');
      if (state.stopping()) {
        acknowledged = false;
        break;
      }
      result.scanned++;
      const done = await runMaintenanceItem(state, 'mediaOrphanCompletion.mark', 'item', () =>
        db.$transaction((tx) => complete(tx, candidate, clock()), txOptions)
      );
      if (done === undefined) {
        acknowledged = false;
        continue;
      }
      if (done) result.tombstoned++;
      else result.retained++;
      cursor = { createdAt: candidate.componentCreatedAt, componentId: candidate.cursorId };
    }
    if (acknowledged) result.nextCursor = rows.length < DAILY_ORPHAN_BATCH_LIMIT ? null : cursor;
  }
  result.failed = state.failed - before;
  return result;
}
