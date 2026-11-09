import { MEDIA_RESERVATION_PROTOCOL } from './media-reservation-contract.js';
import { matchesPhotoOrphan } from './media-photo-orphan-checks.js';
import { createHash } from 'node:crypto';
import { isMemberId, mediaBudgetDay, mediaBudgetFail } from '@artzoo/domain';
import type { Prisma } from './generated/prisma/client.js';
import type { LotteryMountReceipt } from './media-lottery-orphan-contract.js';
import {
  LOTTERY_ORPHAN_TTL_MS,
  LOTTERY_ORPHAN_BATCH_LIMIT,
  LOTTERY_ORPHAN_BATCH_BYTES,
  type LotteryOrphanCursor,
  type LotteryOrphanCandidate,
  type LotteryOrphanBatch,
  type LotteryOrphanCandidateDescription,
  type LotteryOrphanDescription,
  type LotteryPhotoComponent
} from './media-lottery-orphan-contract.js';
type Tx = Prisma.TransactionClient;
const candidates = new WeakMap<object, LotteryOrphanCandidateDescription>();
const batches = new WeakMap<object, LotteryOrphanDescription>();
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function transaction(tx: Tx) {
  if (
    typeof (tx as { $connect?: unknown }).$connect === 'function' ||
    typeof (tx as { $disconnect?: unknown }).$disconnect === 'function'
  )
    mediaBudgetFail('MEDIA_BUDGET_TRANSACTION_REQUIRED');
}
function time(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
function lotteryObjectId(row: LotteryMountReceipt): string | null {
  const [prefix, owner, id, extra] = (row.objectIdentity ?? '').split(':');
  return prefix === 'lottery' &&
    extra === undefined &&
    owner === row.accountId &&
    isMemberId(owner ?? '') &&
    isMemberId(id ?? '')
    ? id!
    : null;
}
/** One bounded keyset page of newly typed original components; no disk/history/JSON scan. */
export async function listLotteryOrphanCandidatesTx(
  tx: Tx,
  now: Date,
  after?: LotteryOrphanCursor
): Promise<{ candidates: readonly LotteryOrphanCandidate[]; nextCursor: LotteryOrphanCursor | null }> {
  transaction(tx);
  mediaBudgetDay(now);
  if (after && (!time(after.createdAt) || !digest(after.componentId)))
    mediaBudgetFail('MEDIA_BUDGET_INVALID_TIME');
  const cutoff = new Date(now.getTime() - LOTTERY_ORPHAN_TTL_MS);
  const rows = after
    ? await tx.$queryRaw<
        (LotteryMountReceipt & { cursorId: string; componentCreatedAt: Date })[]
      >`/*lottery-orphan:list-after*/
      SELECT r.*,c.id AS "cursorId",c."createdAt" AS "componentCreatedAt"
      FROM "MediaStoredComponent" c JOIN "MediaUploadReceipt" r
      ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='lottery-image' AND c.policy='PHOTO_VARIANT' AND c.part='photo-original'
        AND r.scope='lottery-image' AND r.state='COMMITTED' AND r."reservationProtocol"=${MEDIA_RESERVATION_PROTOCOL} AND c."createdAt"<${cutoff}
        AND c."contentBindingSha256" IS NOT NULL AND c."storageIdentityFingerprint" IS NOT NULL
        AND (c."createdAt",c.id)>(${after.createdAt},${after.componentId})
      ORDER BY c."createdAt",c.id LIMIT ${LOTTERY_ORPHAN_BATCH_LIMIT}`
    : await tx.$queryRaw<
        (LotteryMountReceipt & { cursorId: string; componentCreatedAt: Date })[]
      >`/*lottery-orphan:list*/
      SELECT r.*,c.id AS "cursorId",c."createdAt" AS "componentCreatedAt"
      FROM "MediaStoredComponent" c JOIN "MediaUploadReceipt" r
      ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='lottery-image' AND c.policy='PHOTO_VARIANT' AND c.part='photo-original'
        AND r.scope='lottery-image' AND r.state='COMMITTED' AND r."reservationProtocol"=${MEDIA_RESERVATION_PROTOCOL} AND c."createdAt"<${cutoff}
        AND c."contentBindingSha256" IS NOT NULL AND c."storageIdentityFingerprint" IS NOT NULL
      ORDER BY c."createdAt",c.id LIMIT ${LOTTERY_ORPHAN_BATCH_LIMIT}`;
  if (rows.length > LOTTERY_ORPHAN_BATCH_LIMIT) mediaBudgetFail('MEDIA_ORPHAN_BATCH_INVALID');
  const result: LotteryOrphanCandidate[] = [];
  let bytes = 0n;
  let cursor: LotteryOrphanCursor | null = null;
  for (const row of rows) {
    if (
      !time(row.componentCreatedAt) ||
      !digest(row.cursorId) ||
      !lotteryObjectId(row) ||
      !row.accountId ||
      !isMemberId(row.accountId) ||
      typeof row.storedBytes !== 'bigint' ||
      row.storedBytes <= 0n ||
      row.storedBytes > LOTTERY_ORPHAN_BATCH_BYTES
    )
      mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
    if (bytes + row.storedBytes > LOTTERY_ORPHAN_BATCH_BYTES) break;
    const cap = Object.freeze({}) as LotteryOrphanCandidate;
    cursor = { createdAt: new Date(row.componentCreatedAt), componentId: row.cursorId };
    candidates.set(cap, {
      id: lotteryObjectId(row)!,
      receipt: structuredClone(row),
      cursor: structuredClone(cursor)
    });
    result.push(cap);
    bytes += row.storedBytes;
  }
  return {
    candidates: result,
    nextCursor: rows.length < LOTTERY_ORPHAN_BATCH_LIMIT && result.length === rows.length ? null : cursor
  };
}
export function verifiedLotteryOrphanBatch(value: unknown): LotteryOrphanDescription | null {
  const found = value && typeof value === 'object' ? batches.get(value) : undefined;
  return found ? structuredClone(found) : null;
}
/** Existing lottery:write -> global -> exact receipt -> components -> durable intents.
 * No account/session/parent locks, FS, stock credit or current-reference absence authority. */
export async function prepareLotteryOrphanTx(
  tx: Tx,
  candidate: LotteryOrphanCandidate,
  now: Date
): Promise<LotteryOrphanBatch | null> {
  transaction(tx);
  mediaBudgetDay(now);
  const known = candidates.get(candidate);
  if (!known) mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  const { id, receipt: old } = known;
  await tx.$queryRaw`/*lottery-orphan:owner-lock*/ SELECT pg_advisory_xact_lock(hashtextextended(${'lottery:write'},0))::text`;
  if (old.lotteryMountedAt !== null) return null;
  const [global] = await tx.$queryRaw<
    { id: string }[]
  >`/*lottery-orphan:global*/ SELECT id FROM "MediaBudgetState" WHERE id='global' FOR UPDATE`;
  if (!global) mediaBudgetFail('MEDIA_BUDGET_STATE_MISSING');
  const [receipt] = await tx.$queryRaw<
    LotteryMountReceipt[]
  >`/*lottery-orphan:receipt*/ SELECT * FROM "MediaUploadReceipt" WHERE scope='lottery-image' AND "operationKey"=${old.operationKey} FOR UPDATE`;
  if (
    !receipt ||
    receipt.state !== 'COMMITTED' ||
    receipt.reservationProtocol !== MEDIA_RESERVATION_PROTOCOL ||
    receipt.scope !== 'lottery-image' ||
    receipt.accountId !== old.accountId ||
    receipt.objectIdentity !== 'lottery:' + old.accountId + ':' + id ||
    lotteryObjectId(receipt) !== id ||
    receipt.lotteryMountedAt !== null ||
    receipt.attemptId !== old.attemptId ||
    receipt.fingerprint !== old.fingerprint ||
    receipt.storedBytes !== old.storedBytes ||
    receipt.metadataReservedBytes !== 0n ||
    !isMemberId(receipt.attemptId ?? '')
  )
    return null;
  const components = await tx.$queryRaw<
    LotteryPhotoComponent[]
  >`/*lottery-orphan:components*/ SELECT * FROM "MediaStoredComponent" WHERE "receiptScope"='lottery-image' AND "receiptOperationKey"=${receipt.operationKey} ORDER BY part FOR UPDATE`;
  if (!matchesPhotoOrphan('lottery-image', known.cursor, receipt, receipt.createdAt, components, now))
    return null;
  const authorityFingerprint = hash([
    'lottery-never-mounted-v1',
    id,
    receipt.accountId,
    receipt.attemptId,
    receipt.operationKey,
    receipt.fingerprint
  ]);
  const intents: LotteryOrphanDescription['intents'][number][] = [];
  for (const c of components) {
    const [intent] = await tx.$queryRaw<
      (LotteryOrphanDescription['intents'][number] & { state: string; acknowledgedAt: Date | null })[]
    >`/*media-stock:intent*/ SELECT * FROM "MediaRetirementIntent" WHERE "componentId"=${c.id} FOR UPDATE`;
    if (intent) {
      if (
        intent.identityFingerprint !== c.storageIdentityFingerprint ||
        intent.authorityFingerprint !== authorityFingerprint ||
        !['PREPARED', 'ACKNOWLEDGED'].includes(intent.state) ||
        !time(intent.createdAt) ||
        intent.createdAt > now
      )
        mediaBudgetFail('MEDIA_BUDGET_RETIREMENT_CONFLICT');
      intents.push({ ...intent });
    } else {
      const value = {
        id: hash(['media-retirement-v1', c.id, c.storageIdentityFingerprint, authorityFingerprint]),
        componentId: c.id,
        identityFingerprint: c.storageIdentityFingerprint,
        authorityFingerprint,
        createdAt: new Date(now)
      };
      await tx.$executeRaw`/*media-stock:insert-intent*/ INSERT INTO "MediaRetirementIntent" (id,"componentId","identityFingerprint","authorityFingerprint",state,"createdAt") VALUES (${value.id},${value.componentId},${value.identityFingerprint},${value.authorityFingerprint},'PREPARED',${now})`;
      intents.push(value);
    }
  }
  const cap = Object.freeze({}) as LotteryOrphanBatch;
  batches.set(cap, {
    id,
    accountId: receipt.accountId!,
    operationKey: receipt.operationKey,
    generation: receipt.attemptId!,
    fingerprint: receipt.fingerprint,
    components: structuredClone(components),
    intents: structuredClone(intents)
  });
  return cap;
}
