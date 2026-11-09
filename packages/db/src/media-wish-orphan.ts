import { MEDIA_RESERVATION_PROTOCOL } from './media-reservation-contract.js';
import { matchesPhotoOrphan } from './media-photo-orphan-checks.js';
import { createHash } from 'node:crypto';
import { isMemberId, mediaBudgetDay, mediaBudgetFail } from '@artzoo/domain';
import type { Prisma } from './generated/prisma/client.js';
import type { MediaBudgetReceipt } from './media-budget.js';
import {
  WISH_ORPHAN_TTL_MS,
  WISH_ORPHAN_BATCH_LIMIT,
  WISH_ORPHAN_BATCH_BYTES,
  type WishOrphanCursor,
  type WishOrphanCandidate,
  type WishOrphanBatch,
  type WishOrphanCandidateDescription,
  type WishOrphanDescription,
  type WishPhotoComponent
} from './media-wish-orphan-contract.js';
type Tx = Prisma.TransactionClient;
const candidates = new WeakMap<object, WishOrphanCandidateDescription>();
const batches = new WeakMap<object, WishOrphanDescription>();
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
/** Caller holds the original wish-media:owner writer/shared-read lock.
 * Also checks budget OFF: disabling quota cannot revive a permanently fenced object.
 * Takes no new account, business, advisory or row locks. */
export async function wishMediaFencedTx(tx: Tx, accountId: string, ids: readonly string[]): Promise<boolean> {
  transaction(tx);
  if (!isMemberId(accountId) || ids.length > 10 || ids.some((id) => !isMemberId(id)))
    mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  if (!ids.length) return false;
  const keys = ids.map((id) => 'wish:' + id.toLowerCase());
  const [row] = await tx.$queryRaw<{ found: boolean }[]>`/*wish-orphan:attachment-fence*/
    SELECT EXISTS(
      SELECT 1 FROM "MediaRetirementIntent" i
      JOIN "MediaStoredComponent" c ON c.id=i."componentId"
      JOIN "MediaUploadReceipt" r ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='wish' AND c.policy='PHOTO_VARIANT'
        AND c."objectKey"=ANY(${keys}::text[]) AND r.scope='wish'
        AND r."accountId"=${accountId} AND r.state='COMMITTED'
        AND r."objectIdentity"=c."objectKey" AND r."attemptId"=c.generation
    ) AS found`;
  if (!row || typeof row.found !== 'boolean') mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
  return row.found;
}
/** One bounded keyset page of newly typed original components; no disk/history/JSON scan. */
export async function listWishOrphanCandidatesTx(
  tx: Tx,
  now: Date,
  after?: WishOrphanCursor
): Promise<{ candidates: readonly WishOrphanCandidate[]; nextCursor: WishOrphanCursor | null }> {
  transaction(tx);
  mediaBudgetDay(now);
  if (after && (!time(after.createdAt) || !digest(after.componentId)))
    mediaBudgetFail('MEDIA_BUDGET_INVALID_TIME');
  const cutoff = new Date(now.getTime() - WISH_ORPHAN_TTL_MS);
  const rows = after
    ? await tx.$queryRaw<
        (MediaBudgetReceipt & { cursorId: string; componentCreatedAt: Date })[]
      >`/*wish-orphan:list-after*/
      SELECT r.*,c.id AS "cursorId",c."createdAt" AS "componentCreatedAt"
      FROM "MediaStoredComponent" c JOIN "MediaUploadReceipt" r
      ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='wish' AND c.policy='PHOTO_VARIANT' AND c.part='photo-original'
        AND r.scope='wish' AND r.state='COMMITTED' AND r."reservationProtocol"=${MEDIA_RESERVATION_PROTOCOL} AND c."createdAt"<${cutoff}
        AND c."contentBindingSha256" IS NOT NULL AND c."storageIdentityFingerprint" IS NOT NULL
        AND (c."createdAt",c.id)>(${after.createdAt},${after.componentId})
      ORDER BY c."createdAt",c.id LIMIT ${WISH_ORPHAN_BATCH_LIMIT}`
    : await tx.$queryRaw<
        (MediaBudgetReceipt & { cursorId: string; componentCreatedAt: Date })[]
      >`/*wish-orphan:list*/
      SELECT r.*,c.id AS "cursorId",c."createdAt" AS "componentCreatedAt"
      FROM "MediaStoredComponent" c JOIN "MediaUploadReceipt" r
      ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='wish' AND c.policy='PHOTO_VARIANT' AND c.part='photo-original'
        AND r.scope='wish' AND r.state='COMMITTED' AND r."reservationProtocol"=${MEDIA_RESERVATION_PROTOCOL} AND c."createdAt"<${cutoff}
        AND c."contentBindingSha256" IS NOT NULL AND c."storageIdentityFingerprint" IS NOT NULL
      ORDER BY c."createdAt",c.id LIMIT ${WISH_ORPHAN_BATCH_LIMIT}`;
  if (rows.length > WISH_ORPHAN_BATCH_LIMIT) mediaBudgetFail('MEDIA_ORPHAN_BATCH_INVALID');
  const result: WishOrphanCandidate[] = [];
  let bytes = 0n;
  let cursor: WishOrphanCursor | null = null;
  for (const row of rows) {
    if (
      !time(row.componentCreatedAt) ||
      !digest(row.cursorId) ||
      !row.objectIdentity?.startsWith('wish:') ||
      !isMemberId(row.objectIdentity.slice(5)) ||
      !row.accountId ||
      !isMemberId(row.accountId) ||
      typeof row.storedBytes !== 'bigint' ||
      row.storedBytes <= 0n ||
      row.storedBytes > WISH_ORPHAN_BATCH_BYTES
    )
      mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
    if (bytes + row.storedBytes > WISH_ORPHAN_BATCH_BYTES) break;
    const cap = Object.freeze({}) as WishOrphanCandidate;
    cursor = { createdAt: new Date(row.componentCreatedAt), componentId: row.cursorId };
    candidates.set(cap, {
      id: row.objectIdentity.slice(5),
      receipt: structuredClone(row),
      cursor: structuredClone(cursor)
    });
    result.push(cap);
    bytes += row.storedBytes;
  }
  return {
    candidates: result,
    nextCursor: rows.length < WISH_ORPHAN_BATCH_LIMIT && result.length === rows.length ? null : cursor
  };
}
export function verifiedWishOrphanBatch(value: unknown): WishOrphanDescription | null {
  const found = value && typeof value === 'object' ? batches.get(value) : undefined;
  return found ? structuredClone(found) : null;
}
/** Owner lock -> business recheck -> global -> receipt -> components -> durable intents.
 * No FS operation, new account/post locks, or stock/wish credit occurs here. */
export async function prepareWishOrphanTx(
  tx: Tx,
  candidate: WishOrphanCandidate,
  now: Date
): Promise<WishOrphanBatch | null> {
  transaction(tx);
  mediaBudgetDay(now);
  const known = candidates.get(candidate);
  if (!known) mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  const { id, receipt: old } = known;
  await tx.$queryRaw`/*wish-orphan:owner-lock*/ SELECT pg_advisory_xact_lock(hashtextextended(${'wish-media:' + old.accountId},0))::text`;
  const [media] = await tx.$queryRaw<
    {
      id: string;
      ownerId: string;
      fingerprint: string;
      wishId: string | null;
      commentId: string | null;
      removedAt: Date | null;
      createdAt: Date;
    }[]
  >`/*wish-orphan:business*/ SELECT * FROM "WishMedia" WHERE id=${id}`;
  if (
    !media ||
    media.ownerId !== old.accountId ||
    media.fingerprint !== old.fingerprint ||
    media.wishId !== null ||
    media.commentId !== null ||
    media.removedAt !== null
  )
    return null;
  const [global] = await tx.$queryRaw<
    { id: string }[]
  >`/*wish-orphan:global*/ SELECT id FROM "MediaBudgetState" WHERE id='global' FOR UPDATE`;
  if (!global) mediaBudgetFail('MEDIA_BUDGET_STATE_MISSING');
  const [receipt] = await tx.$queryRaw<
    MediaBudgetReceipt[]
  >`/*wish-orphan:receipt*/ SELECT * FROM "MediaUploadReceipt" WHERE scope='wish' AND "operationKey"=${old.operationKey} FOR UPDATE`;
  if (
    !receipt ||
    receipt.state !== 'COMMITTED' ||
    receipt.reservationProtocol !== MEDIA_RESERVATION_PROTOCOL ||
    receipt.scope !== 'wish' ||
    receipt.accountId !== old.accountId ||
    receipt.objectIdentity !== 'wish:' + id ||
    receipt.attemptId !== old.attemptId ||
    receipt.fingerprint !== old.fingerprint ||
    receipt.storedBytes !== old.storedBytes ||
    receipt.metadataReservedBytes !== 0n ||
    !isMemberId(receipt.attemptId ?? '')
  )
    return null;
  const components = await tx.$queryRaw<
    WishPhotoComponent[]
  >`/*wish-orphan:components*/ SELECT * FROM "MediaStoredComponent" WHERE "receiptScope"='wish' AND "receiptOperationKey"=${receipt.operationKey} ORDER BY part FOR UPDATE`;
  if (!matchesPhotoOrphan('wish', known.cursor, receipt, media.createdAt, components, now)) return null;
  const authorityFingerprint = hash([
    'wish-never-mounted-v1',
    id,
    receipt.accountId,
    receipt.attemptId,
    receipt.operationKey,
    receipt.fingerprint
  ]);
  const intents: WishOrphanDescription['intents'][number][] = [];
  for (const c of components) {
    const [intent] = await tx.$queryRaw<
      (WishOrphanDescription['intents'][number] & { state: string; acknowledgedAt: Date | null })[]
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
  const cap = Object.freeze({}) as WishOrphanBatch;
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
