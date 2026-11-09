import { matchesPhotoOrphan } from './media-photo-orphan-checks.js';
import { MEDIA_RESERVATION_PROTOCOL } from './media-reservation-contract.js';
import { createHash } from 'node:crypto';
import { isMemberId, mediaBudgetDay, mediaBudgetFail } from '@artzoo/domain';
import type { Prisma } from './generated/prisma/client.js';
import type { MediaBudgetReceipt } from './media-budget.js';
import {
  ALBUM_COMMENT_ORPHAN_TTL_MS,
  ALBUM_COMMENT_ORPHAN_BATCH_LIMIT,
  ALBUM_COMMENT_ORPHAN_BATCH_BYTES,
  type AlbumCommentOrphanCursor,
  type AlbumCommentOrphanCandidate,
  type AlbumCommentOrphanBatch,
  type AlbumCommentOrphanCandidateDescription,
  type AlbumCommentOrphanDescription,
  type AlbumCommentPhotoComponent
} from './media-album-comment-orphan-contract.js';
type Tx = Prisma.TransactionClient;
const candidates = new WeakMap<object, AlbumCommentOrphanCandidateDescription>();
const batches = new WeakMap<object, AlbumCommentOrphanDescription>();
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
/** Caller holds the original album:id writer/shared-read lock.
 * Also checks budget OFF: disabling quota cannot revive a permanently fenced object.
 * Takes no new account, business, advisory or row locks. */
export async function albumCommentMediaFencedTx(
  tx: Tx,
  accountId: string,
  ids: readonly string[]
): Promise<boolean> {
  transaction(tx);
  if (!isMemberId(accountId) || ids.length > 10 || ids.some((id) => !isMemberId(id)))
    mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  if (!ids.length) return false;
  const keys = ids.map((id) => 'album-comment:' + id.toLowerCase());
  const [row] = await tx.$queryRaw<{ found: boolean }[]>`/*album-comment-orphan:attachment-fence*/
    SELECT EXISTS(
      SELECT 1 FROM "MediaRetirementIntent" i
      JOIN "MediaStoredComponent" c ON c.id=i."componentId"
      JOIN "MediaUploadReceipt" r ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='album-comment' AND c.policy='PHOTO_VARIANT'
        AND c."objectKey"=ANY(${keys}::text[]) AND r.scope='album-comment'
        AND r."accountId"=${accountId} AND r.state='COMMITTED'
        AND r."objectIdentity"=c."objectKey" AND r."attemptId"=c.generation
    ) AS found`;
  if (!row || typeof row.found !== 'boolean') mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
  return row.found;
}
/** One bounded keyset page of newly typed original components; no disk/history/JSON scan. */
export async function listAlbumCommentOrphanCandidatesTx(
  tx: Tx,
  now: Date,
  after?: AlbumCommentOrphanCursor
): Promise<{
  candidates: readonly AlbumCommentOrphanCandidate[];
  nextCursor: AlbumCommentOrphanCursor | null;
}> {
  transaction(tx);
  mediaBudgetDay(now);
  if (after && (!time(after.createdAt) || !digest(after.componentId)))
    mediaBudgetFail('MEDIA_BUDGET_INVALID_TIME');
  const cutoff = new Date(now.getTime() - ALBUM_COMMENT_ORPHAN_TTL_MS);
  const rows = after
    ? await tx.$queryRaw<
        (MediaBudgetReceipt & { cursorId: string; componentCreatedAt: Date })[]
      >`/*album-comment-orphan:list-after*/
      SELECT r.*,c.id AS "cursorId",c."createdAt" AS "componentCreatedAt"
      FROM "MediaStoredComponent" c JOIN "MediaUploadReceipt" r
      ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='album-comment' AND c.policy='PHOTO_VARIANT' AND c.part='photo-original'
        AND r.scope='album-comment' AND r.state='COMMITTED' AND r."reservationProtocol"=${MEDIA_RESERVATION_PROTOCOL} AND c."createdAt"<${cutoff}
        AND c."contentBindingSha256" IS NOT NULL AND c."storageIdentityFingerprint" IS NOT NULL
        AND (c."createdAt",c.id)>(${after.createdAt},${after.componentId})
      ORDER BY c."createdAt",c.id LIMIT ${ALBUM_COMMENT_ORPHAN_BATCH_LIMIT}`
    : await tx.$queryRaw<
        (MediaBudgetReceipt & { cursorId: string; componentCreatedAt: Date })[]
      >`/*album-comment-orphan:list*/
      SELECT r.*,c.id AS "cursorId",c."createdAt" AS "componentCreatedAt"
      FROM "MediaStoredComponent" c JOIN "MediaUploadReceipt" r
      ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='album-comment' AND c.policy='PHOTO_VARIANT' AND c.part='photo-original'
        AND r.scope='album-comment' AND r.state='COMMITTED' AND r."reservationProtocol"=${MEDIA_RESERVATION_PROTOCOL} AND c."createdAt"<${cutoff}
        AND c."contentBindingSha256" IS NOT NULL AND c."storageIdentityFingerprint" IS NOT NULL
      ORDER BY c."createdAt",c.id LIMIT ${ALBUM_COMMENT_ORPHAN_BATCH_LIMIT}`;
  if (rows.length > ALBUM_COMMENT_ORPHAN_BATCH_LIMIT) mediaBudgetFail('MEDIA_ORPHAN_BATCH_INVALID');
  const result: AlbumCommentOrphanCandidate[] = [];
  let bytes = 0n;
  let cursor: AlbumCommentOrphanCursor | null = null;
  for (const row of rows) {
    if (
      !time(row.componentCreatedAt) ||
      !digest(row.cursorId) ||
      !row.objectIdentity?.startsWith('album-comment:') ||
      !isMemberId(row.objectIdentity.slice('album-comment:'.length)) ||
      !row.accountId ||
      !isMemberId(row.accountId) ||
      typeof row.storedBytes !== 'bigint' ||
      row.storedBytes <= 0n ||
      row.storedBytes > ALBUM_COMMENT_ORPHAN_BATCH_BYTES
    )
      mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
    if (bytes + row.storedBytes > ALBUM_COMMENT_ORPHAN_BATCH_BYTES) break;
    const cap = Object.freeze({}) as AlbumCommentOrphanCandidate;
    cursor = { createdAt: new Date(row.componentCreatedAt), componentId: row.cursorId };
    candidates.set(cap, {
      id: row.objectIdentity.slice('album-comment:'.length),
      receipt: structuredClone(row),
      cursor: structuredClone(cursor)
    });
    result.push(cap);
    bytes += row.storedBytes;
  }
  return {
    candidates: result,
    nextCursor:
      rows.length < ALBUM_COMMENT_ORPHAN_BATCH_LIMIT && result.length === rows.length ? null : cursor
  };
}
export function verifiedAlbumCommentOrphanBatch(value: unknown): AlbumCommentOrphanDescription | null {
  const found = value && typeof value === 'object' ? batches.get(value) : undefined;
  return found ? structuredClone(found) : null;
}
/** Owner lock -> business recheck -> global -> receipt -> components -> durable intents.
 * No FS operation, new account/post locks, or stock/album-comment credit occurs here. */
export async function prepareAlbumCommentOrphanTx(
  tx: Tx,
  candidate: AlbumCommentOrphanCandidate,
  now: Date
): Promise<AlbumCommentOrphanBatch | null> {
  transaction(tx);
  mediaBudgetDay(now);
  const known = candidates.get(candidate);
  if (!known) mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  const { id, receipt: old } = known;
  const [scopeRow] = await tx.$queryRaw<
    { albumId: string }[]
  >`SELECT "albumId" FROM "AlbumCommentMedia" WHERE id=${id}`;
  if (!scopeRow) return null;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'album:' + scopeRow.albumId},0))::text`;
  const [album] = await tx.$queryRaw<
    { removedAt: Date | null }[]
  >`SELECT "removedAt" FROM "Album" WHERE id=${scopeRow.albumId}`;
  if (!album || album.removedAt !== null) return null;
  const [media] = await tx.$queryRaw<
    {
      id: string;
      ownerId: string;
      fingerprint: string;
      albumId: string;
      commentId: string | null;
      orphanMountedAt: Date | null;
      removedAt: Date | null;
      createdAt: Date;
    }[]
  >`/*album-comment-orphan:business*/ SELECT * FROM "AlbumCommentMedia" WHERE id=${id} FOR UPDATE`;
  if (
    !media ||
    media.ownerId !== old.accountId ||
    media.albumId !== scopeRow.albumId ||
    media.fingerprint !== old.fingerprint ||
    media.orphanMountedAt !== null ||
    media.commentId !== null ||
    media.removedAt !== null
  )
    return null;
  const [global] = await tx.$queryRaw<
    { id: string }[]
  >`/*album-comment-orphan:global*/ SELECT id FROM "MediaBudgetState" WHERE id='global' FOR UPDATE`;
  if (!global) mediaBudgetFail('MEDIA_BUDGET_STATE_MISSING');
  const [receipt] = await tx.$queryRaw<
    MediaBudgetReceipt[]
  >`/*album-comment-orphan:receipt*/ SELECT * FROM "MediaUploadReceipt" WHERE scope='album-comment' AND "operationKey"=${old.operationKey} FOR UPDATE`;
  if (
    !receipt ||
    receipt.state !== 'COMMITTED' ||
    receipt.scope !== 'album-comment' ||
    receipt.accountId !== old.accountId ||
    receipt.objectIdentity !== 'album-comment:' + id ||
    receipt.attemptId !== old.attemptId ||
    receipt.fingerprint !== old.fingerprint ||
    receipt.storedBytes !== old.storedBytes ||
    receipt.reservationProtocol !== MEDIA_RESERVATION_PROTOCOL ||
    receipt.metadataReservedBytes !== 0n ||
    !isMemberId(receipt.attemptId ?? '')
  )
    return null;
  const components = await tx.$queryRaw<
    AlbumCommentPhotoComponent[]
  >`/*album-comment-orphan:components*/ SELECT * FROM "MediaStoredComponent" WHERE "receiptScope"='album-comment' AND "receiptOperationKey"=${receipt.operationKey} ORDER BY part FOR UPDATE`;
  if (!matchesPhotoOrphan('album-comment', known.cursor, receipt, media.createdAt, components, now))
    return null;
  const authorityFingerprint = hash([
    'album-comment-never-mounted-v1',
    id,
    receipt.accountId,
    receipt.attemptId,
    receipt.operationKey,
    receipt.fingerprint
  ]);
  const intents: AlbumCommentOrphanDescription['intents'][number][] = [];
  for (const c of components) {
    const [intent] = await tx.$queryRaw<
      (AlbumCommentOrphanDescription['intents'][number] & { state: string; acknowledgedAt: Date | null })[]
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
  const cap = Object.freeze({}) as AlbumCommentOrphanBatch;
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
