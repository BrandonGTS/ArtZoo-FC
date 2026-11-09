import { matchesPhotoOrphan } from './media-photo-orphan-checks.js';
import { MEDIA_RESERVATION_PROTOCOL } from './media-reservation-contract.js';
import { createHash } from 'node:crypto';
import { isMemberId, mediaBudgetDay, mediaBudgetFail } from '@artzoo/domain';
import type { Prisma } from './generated/prisma/client.js';
import type { MediaBudgetReceipt } from './media-budget.js';
import {
  KNOWLEDGE_ORPHAN_TTL_MS,
  KNOWLEDGE_ORPHAN_BATCH_LIMIT,
  KNOWLEDGE_ORPHAN_BATCH_BYTES,
  type KnowledgeOrphanCursor,
  type KnowledgeOrphanCandidate,
  type KnowledgeOrphanBatch,
  type KnowledgeOrphanCandidateDescription,
  type KnowledgeOrphanDescription,
  type KnowledgePhotoComponent
} from './media-knowledge-orphan-contract.js';
type Tx = Prisma.TransactionClient;
const candidates = new WeakMap<object, KnowledgeOrphanCandidateDescription>();
const batches = new WeakMap<object, KnowledgeOrphanDescription>();
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
/** Caller holds the original uploader Account writer lock.
 * Also checks budget OFF: disabling quota cannot revive a permanently fenced object.
 * Takes no new account, business, advisory or row locks. */
export async function knowledgeMediaFencedTx(
  tx: Tx,
  accountId: string,
  ids: readonly string[]
): Promise<boolean> {
  transaction(tx);
  if (!isMemberId(accountId) || ids.length > 10 || ids.some((id) => !isMemberId(id)))
    mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  if (!ids.length) return false;
  const keys = ids.map((id) => 'knowledge:' + id.toLowerCase());
  const [row] = await tx.$queryRaw<{ found: boolean }[]>`/*knowledge-orphan:attachment-fence*/
    SELECT EXISTS(
      SELECT 1 FROM "MediaRetirementIntent" i
      JOIN "MediaStoredComponent" c ON c.id=i."componentId"
      JOIN "MediaUploadReceipt" r ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='knowledge' AND c.policy='PHOTO_VARIANT'
        AND c."objectKey"=ANY(${keys}::text[]) AND r.scope='knowledge'
        AND r."accountId"=${accountId} AND r.state='COMMITTED'
        AND r."objectIdentity"=c."objectKey" AND r."attemptId"=c.generation
    ) AS found`;
  if (!row || typeof row.found !== 'boolean') mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
  return row.found;
}
/** One bounded keyset page of newly typed original components; no disk/history/JSON scan. */
export async function listKnowledgeOrphanCandidatesTx(
  tx: Tx,
  now: Date,
  after?: KnowledgeOrphanCursor
): Promise<{ candidates: readonly KnowledgeOrphanCandidate[]; nextCursor: KnowledgeOrphanCursor | null }> {
  transaction(tx);
  mediaBudgetDay(now);
  if (after && (!time(after.createdAt) || !digest(after.componentId)))
    mediaBudgetFail('MEDIA_BUDGET_INVALID_TIME');
  const cutoff = new Date(now.getTime() - KNOWLEDGE_ORPHAN_TTL_MS);
  const rows = after
    ? await tx.$queryRaw<
        (MediaBudgetReceipt & { cursorId: string; componentCreatedAt: Date })[]
      >`/*knowledge-orphan:list-after*/
      SELECT r.*,c.id AS "cursorId",c."createdAt" AS "componentCreatedAt"
      FROM "MediaStoredComponent" c JOIN "MediaUploadReceipt" r
      ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='knowledge' AND c.policy='PHOTO_VARIANT' AND c.part='photo-original'
        AND r.scope='knowledge' AND r.state='COMMITTED' AND r."reservationProtocol"=${MEDIA_RESERVATION_PROTOCOL} AND c."createdAt"<${cutoff}
        AND c."contentBindingSha256" IS NOT NULL AND c."storageIdentityFingerprint" IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM "MediaRetirementIntent" done WHERE done."componentId"=c.id AND done.state='ACKNOWLEDGED')
        AND (c."createdAt",c.id)>(${after.createdAt},${after.componentId})
      ORDER BY c."createdAt",c.id LIMIT ${KNOWLEDGE_ORPHAN_BATCH_LIMIT}`
    : await tx.$queryRaw<
        (MediaBudgetReceipt & { cursorId: string; componentCreatedAt: Date })[]
      >`/*knowledge-orphan:list*/
      SELECT r.*,c.id AS "cursorId",c."createdAt" AS "componentCreatedAt"
      FROM "MediaStoredComponent" c JOIN "MediaUploadReceipt" r
      ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace='knowledge' AND c.policy='PHOTO_VARIANT' AND c.part='photo-original'
        AND r.scope='knowledge' AND r.state='COMMITTED' AND r."reservationProtocol"=${MEDIA_RESERVATION_PROTOCOL} AND c."createdAt"<${cutoff}
        AND c."contentBindingSha256" IS NOT NULL AND c."storageIdentityFingerprint" IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM "MediaRetirementIntent" done WHERE done."componentId"=c.id AND done.state='ACKNOWLEDGED')
      ORDER BY c."createdAt",c.id LIMIT ${KNOWLEDGE_ORPHAN_BATCH_LIMIT}`;
  if (rows.length > KNOWLEDGE_ORPHAN_BATCH_LIMIT) mediaBudgetFail('MEDIA_ORPHAN_BATCH_INVALID');
  const result: KnowledgeOrphanCandidate[] = [];
  let bytes = 0n;
  let cursor: KnowledgeOrphanCursor | null = null;
  for (const row of rows) {
    if (
      !time(row.componentCreatedAt) ||
      !digest(row.cursorId) ||
      !row.objectIdentity?.startsWith('knowledge:') ||
      !isMemberId(row.objectIdentity.slice('knowledge:'.length)) ||
      !row.accountId ||
      !isMemberId(row.accountId) ||
      typeof row.storedBytes !== 'bigint' ||
      row.storedBytes <= 0n ||
      row.storedBytes > KNOWLEDGE_ORPHAN_BATCH_BYTES
    )
      mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
    if (bytes + row.storedBytes > KNOWLEDGE_ORPHAN_BATCH_BYTES) break;
    const cap = Object.freeze({}) as KnowledgeOrphanCandidate;
    cursor = { createdAt: new Date(row.componentCreatedAt), componentId: row.cursorId };
    candidates.set(cap, {
      id: row.objectIdentity.slice('knowledge:'.length),
      receipt: structuredClone(row),
      cursor: structuredClone(cursor)
    });
    result.push(cap);
    bytes += row.storedBytes;
  }
  return {
    candidates: result,
    nextCursor: rows.length < KNOWLEDGE_ORPHAN_BATCH_LIMIT && result.length === rows.length ? null : cursor
  };
}
export function verifiedKnowledgeOrphanBatch(value: unknown): KnowledgeOrphanDescription | null {
  const found = value && typeof value === 'object' ? batches.get(value) : undefined;
  return found ? structuredClone(found) : null;
}
/** Owner lock -> business recheck -> global -> receipt -> components -> durable intents.
 * No FS operation, new account/post locks, or stock/knowledge credit occurs here. */
export async function prepareKnowledgeOrphanTx(
  tx: Tx,
  candidate: KnowledgeOrphanCandidate,
  now: Date
): Promise<KnowledgeOrphanBatch | null> {
  transaction(tx);
  mediaBudgetDay(now);
  const known = candidates.get(candidate);
  if (!known) mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  const { id, receipt: old } = known;
  await tx.$queryRaw`/*knowledge-orphan:owner-lock*/ SELECT id FROM "Account" WHERE id=${old.accountId} FOR NO KEY UPDATE`;
  const [media] = await tx.$queryRaw<
    {
      id: string;
      uploaderId: string;
      digest: string;
      articleId: string | null;
      commentId: string | null;
      orphanMountedAt: Date | null;
      createdAt: Date;
    }[]
  >`/*knowledge-orphan:business*/ SELECT * FROM "KnowledgeImage" WHERE id=${id} FOR UPDATE`;
  if (
    !media ||
    media.uploaderId !== old.accountId ||
    media.digest !== old.fingerprint ||
    media.articleId !== null ||
    media.commentId !== null ||
    media.orphanMountedAt !== null
  )
    return null;
  const [global] = await tx.$queryRaw<
    { id: string }[]
  >`/*knowledge-orphan:global*/ SELECT id FROM "MediaBudgetState" WHERE id='global' FOR UPDATE`;
  if (!global) mediaBudgetFail('MEDIA_BUDGET_STATE_MISSING');
  const [receipt] = await tx.$queryRaw<
    MediaBudgetReceipt[]
  >`/*knowledge-orphan:receipt*/ SELECT * FROM "MediaUploadReceipt" WHERE scope='knowledge' AND "operationKey"=${old.operationKey} FOR UPDATE`;
  if (
    !receipt ||
    receipt.state !== 'COMMITTED' ||
    receipt.scope !== 'knowledge' ||
    receipt.accountId !== old.accountId ||
    receipt.objectIdentity !== 'knowledge:' + id ||
    receipt.attemptId !== old.attemptId ||
    receipt.fingerprint !== old.fingerprint ||
    receipt.storedBytes !== old.storedBytes ||
    receipt.reservationProtocol !== MEDIA_RESERVATION_PROTOCOL ||
    receipt.metadataReservedBytes <= 0n ||
    !isMemberId(receipt.attemptId ?? '')
  )
    return null;
  const components = await tx.$queryRaw<
    (KnowledgePhotoComponent | (Omit<KnowledgePhotoComponent, 'part'> & { part: 'knowledge-journal' }))[]
  >`/*knowledge-orphan:components*/ SELECT * FROM "MediaStoredComponent" WHERE "receiptScope"='knowledge' AND "receiptOperationKey"=${receipt.operationKey} ORDER BY part FOR UPDATE`;
  const journal = components.filter((c) => c.part === 'knowledge-journal');
  const photos = components.filter((c): c is KnowledgePhotoComponent =>
    ['photo-original', 'photo-preview', 'photo-thumbnail'].includes(c.part)
  );
  if (components.length !== 4 || journal.length !== 1 || photos.length !== 3) return null;
  const j = journal[0]!;
  if (
    j.policy !== 'KNOWLEDGE_JOURNAL' ||
    j.namespace !== 'knowledge' ||
    j.receiptScope !== 'knowledge' ||
    j.receiptOperationKey !== receipt.operationKey ||
    j.objectKey !== receipt.objectIdentity ||
    j.generation !== receipt.attemptId ||
    j.chargedBytes !== receipt.metadataReservedBytes ||
    !digest(j.contentBindingSha256) ||
    !digest(j.storageIdentityFingerprint)
  )
    return null;
  const [journalAck] = await tx.$queryRaw<{ found: boolean }[]>`SELECT EXISTS(
    SELECT 1 FROM "MediaRetirementIntent" i JOIN "MediaStorageCredit" c ON c."intentId"=i.id
    WHERE i."componentId"=${j.id} AND i.state='ACKNOWLEDGED' AND i."acknowledgedAt" IS NOT NULL
      AND c."componentId"=i."componentId" AND c.bytes=${j.chargedBytes}
      AND i."identityFingerprint"=${j.storageIdentityFingerprint}) AS found`;
  if (
    journalAck?.found !== true ||
    !matchesPhotoOrphan(
      'knowledge',
      known.cursor,
      { ...receipt, storedBytes: receipt.storedBytes - receipt.metadataReservedBytes },
      media.createdAt,
      photos,
      now
    )
  )
    return null;
  const authorityFingerprint = hash([
    'knowledge-never-mounted-v1',
    id,
    receipt.accountId,
    receipt.attemptId,
    receipt.operationKey,
    receipt.fingerprint
  ]);
  const intents: KnowledgeOrphanDescription['intents'][number][] = [];
  for (const c of photos) {
    const [intent] = await tx.$queryRaw<
      (KnowledgeOrphanDescription['intents'][number] & { state: string; acknowledgedAt: Date | null })[]
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
  const cap = Object.freeze({}) as KnowledgeOrphanBatch;
  batches.set(cap, {
    id,
    accountId: receipt.accountId!,
    operationKey: receipt.operationKey,
    generation: receipt.attemptId!,
    fingerprint: receipt.fingerprint,
    components: structuredClone(photos),
    intents: structuredClone(intents)
  });
  return cap;
}
