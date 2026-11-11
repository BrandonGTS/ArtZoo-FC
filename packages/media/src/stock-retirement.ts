import { createHash } from 'node:crypto';
import { mediaBudgetFail, mediaByteCount, mediaBudgetDay, isMemberId } from '@artzoo/domain';
import {
  verifiedBoundAllocation,
  verifiedOfficialUnusedBatch,
  verifiedDailyOrphanBatch,
  verifiedWishOrphanBatch,
  verifiedLotteryOrphanBatch,
  verifiedKnowledgeOrphanBatch,
  verifiedAlbumCommentOrphanBatch
} from '@artzoo/db';
import type {
  MediaBudgetTx,
  MediaBudgetReceipt,
  Prisma,
  PrismaClient,
  MediaBoundAllocationTicket,
  OfficialUnusedBatch,
  DailyOrphanBatch,
  WishOrphanBatch,
  LotteryOrphanBatch,
  KnowledgeOrphanBatch,
  AlbumCommentOrphanBatch,
  DailyPhotoComponent
} from '@artzoo/db';
import {
  boundHash,
  verifiedBoundWrite,
  verifiedBoundRemoval,
  type MediaRetirementNamespace,
  type BoundWriteProof,
  type BoundDescription
} from './stock-bound-io.js';
import { verifiedMediaWrite, type MediaWriteProof } from './media-write.js';
export type { MediaWriteProof, MediaWriteNamespace } from './media-write.js';
export { BoundNamespace } from './stock-bound-io.js';
export type { MediaRetirementNamespace } from './stock-bound-io.js';
export type { BoundWriteProof } from './stock-bound-io.js';
type Component = {
  id: string;
  sourceKind: 'RECEIPT' | 'BASELINE';
  receiptScope: string | null;
  receiptOperationKey: string | null;
  baselineStateId: string | null;
  baselineFingerprint: string | null;
  namespace: string;
  objectKey: string;
  generation: string;
  part: string;
  policy: string;
  chargedBytes: bigint;
  createdAt: Date;
  contentBindingSha256: string | null;
  storageIdentityFingerprint: string | null;
};
type Intent = {
  id: string;
  componentId: string;
  identityFingerprint: string;
  authorityFingerprint: string;
  state: 'PREPARED' | 'ACKNOWLEDGED';
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
const hash = (parts: unknown[]) =>
  createHash('sha256')
    .update(JSON.stringify(parts, (_k, v) => (typeof v === 'bigint' ? { bigint: v.toString() } : v)))
    .digest('hex');
const validHash = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
/** Internal phase57 primitives. Deliberately NOT exported from @artzoo/db. */
function requireTransaction(tx: MediaBudgetTx) {
  if (
    typeof (tx as { $connect?: unknown }).$connect === 'function' ||
    typeof (tx as { $disconnect?: unknown }).$disconnect === 'function'
  )
    mediaBudgetFail('MEDIA_BUDGET_TRANSACTION_REQUIRED');
}
async function stockGlobal(tx: MediaBudgetTx) {
  requireTransaction(tx);
  const [global] = await tx.$queryRaw<
    {
      baselineBytes: bigint;
      committedBytes: bigint;
      reservedBytes: bigint;
      creditedBytes: bigint;
      baselineFingerprint: string | null;
    }[]
  >`/*media-stock:global*/ SELECT * FROM "MediaBudgetState" WHERE id='global' FOR UPDATE`;
  if (!global) mediaBudgetFail('MEDIA_BUDGET_STATE_MISSING');
  for (const value of [
    global.baselineBytes,
    global.committedBytes,
    global.reservedBytes,
    global.creditedBytes
  ])
    mediaByteCount(value);
  if (global.creditedBytes > global.baselineBytes + global.committedBytes)
    mediaBudgetFail('MEDIA_BUDGET_STATE_MISMATCH');
  return global;
}
async function committedComponent(tx: MediaBudgetTx, id: string) {
  if (!validHash(id)) mediaBudgetFail('MEDIA_BUDGET_COMPONENT_REQUIRED');
  // global serializes all component operations; read receipt BEFORE locking component.
  const [candidate] = await tx.$queryRaw<
    Component[]
  >`/*media-stock:component*/ SELECT * FROM "MediaStoredComponent" WHERE id=${id}`;
  if (
    !candidate ||
    !candidate.contentBindingSha256 ||
    !candidate.storageIdentityFingerprint ||
    candidate.policy === 'AGGREGATE_NEVER'
  )
    mediaBudgetFail('MEDIA_BUDGET_COMPONENT_NOT_RETIRABLE');
  if (candidate.sourceKind === 'RECEIPT') {
    const [row] = await tx.$queryRaw<
      MediaBudgetReceipt[]
    >`/*media-stock:source-receipt*/ SELECT * FROM "MediaUploadReceipt" WHERE scope=${candidate.receiptScope} AND "operationKey"=${candidate.receiptOperationKey} FOR UPDATE`;
    if (
      !row ||
      row.state !== 'COMMITTED' ||
      row.objectIdentity !== candidate.objectKey ||
      row.attemptId !== candidate.generation ||
      !row.persistenceStartedAt ||
      !row.settledAt
    )
      mediaBudgetFail('MEDIA_BUDGET_COMPONENT_UNSETTLED');
    const [total] = await tx.$queryRaw<
      { bytes: bigint }[]
    >`/*media-stock:source-total*/ SELECT COALESCE(SUM("chargedBytes"),0)::bigint AS bytes FROM "MediaStoredComponent" WHERE "receiptScope"=${row.scope} AND "receiptOperationKey"=${row.operationKey}`;
    if (!total || total.bytes !== row.storedBytes) mediaBudgetFail('MEDIA_BUDGET_STATE_MISMATCH');
  } else {
    // No baseline adoption/retirable baseline registrar exists in this phase.
    mediaBudgetFail('MEDIA_BUDGET_BASELINE_COMPONENT_UNAVAILABLE');
  }
  const [locked] = await tx.$queryRaw<
    Component[]
  >`/*media-stock:component-lock*/ SELECT * FROM "MediaStoredComponent" WHERE id=${id} FOR UPDATE`;
  if (!locked || hash([locked]) !== hash([candidate])) mediaBudgetFail('MEDIA_BUDGET_STATE_MISMATCH');
  mediaByteCount(locked.chargedBytes, true);
  return locked;
}
interface VerifiedAuthority {
  componentId: string;
  generation: string;
  identityFingerprint: string;
  authorityFingerprint: string;
}
interface VerifiedEvidence {
  intentId: string;
  componentId: string;
  generation: string;
  identityFingerprint: string;
  authorityFingerprint: string;
  evidenceFingerprint: string;
}
// No product producer exists yet. A later reviewed storage/DB adapter must establish both capabilities.
// Neither JSON, a TypeScript cast, a persisted intent nor ENOENT can populate these private maps.
const authorities = new WeakMap<object, VerifiedAuthority>();
const evidences = new WeakMap<object, VerifiedEvidence>();
type MediaRetirementAuthority = object & { readonly __mediaRetirementAuthority: unique symbol };
type MediaRetirementEvidence = object & { readonly __mediaRetirementEvidence: unique symbol };
async function prepareMediaRetirement(tx: MediaBudgetTx, authority: MediaRetirementAuthority, now: Date) {
  const verified = authorities.get(authority);
  if (!verified || !validHash(verified.identityFingerprint) || !validHash(verified.authorityFingerprint))
    mediaBudgetFail('MEDIA_BUDGET_RETIREMENT_AUTHORITY_REQUIRED');
  mediaBudgetDay(now);
  await stockGlobal(tx);
  const component = await committedComponent(tx, verified.componentId);
  if (
    component.generation !== verified.generation ||
    component.storageIdentityFingerprint !== verified.identityFingerprint
  )
    mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
  if (now < component.createdAt) mediaBudgetFail('MEDIA_BUDGET_INVALID_TIME');
  const [old] = await tx.$queryRaw<
    Intent[]
  >`/*media-stock:intent*/ SELECT * FROM "MediaRetirementIntent" WHERE "componentId"=${component.id} FOR UPDATE`;
  if (old) {
    if (
      old.identityFingerprint !== verified.identityFingerprint ||
      old.authorityFingerprint !== verified.authorityFingerprint
    )
      mediaBudgetFail('MEDIA_BUDGET_RETIREMENT_CONFLICT');
    return old;
  }
  const intent: Intent = {
    id: hash([
      'media-retirement-v1',
      component.id,
      verified.identityFingerprint,
      verified.authorityFingerprint
    ]),
    componentId: component.id,
    identityFingerprint: verified.identityFingerprint,
    authorityFingerprint: verified.authorityFingerprint,
    state: 'PREPARED',
    createdAt: now,
    acknowledgedAt: null
  };
  await tx.$executeRaw`/*media-stock:insert-intent*/ INSERT INTO "MediaRetirementIntent" (id,"componentId","identityFingerprint","authorityFingerprint",state,"createdAt") VALUES (${intent.id},${intent.componentId},${intent.identityFingerprint},${intent.authorityFingerprint},'PREPARED',${now})`;
  return intent;
}
async function acknowledgeMediaRetirement(tx: MediaBudgetTx, evidence: MediaRetirementEvidence, now: Date) {
  const verified = evidences.get(evidence);
  if (!verified || !validHash(verified.evidenceFingerprint))
    mediaBudgetFail('MEDIA_BUDGET_RETIREMENT_EVIDENCE_REQUIRED');
  mediaBudgetDay(now);
  const global = await stockGlobal(tx),
    component = await committedComponent(tx, verified.componentId);
  if (
    component.generation !== verified.generation ||
    component.storageIdentityFingerprint !== verified.identityFingerprint
  )
    mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
  const [intent] = await tx.$queryRaw<
    Intent[]
  >`/*media-stock:intent*/ SELECT * FROM "MediaRetirementIntent" WHERE "componentId"=${component.id} FOR UPDATE`;
  if (
    !intent ||
    intent.id !== verified.intentId ||
    intent.identityFingerprint !== verified.identityFingerprint ||
    intent.authorityFingerprint !== verified.authorityFingerprint ||
    now < intent.createdAt
  )
    mediaBudgetFail('MEDIA_BUDGET_RETIREMENT_CONFLICT');
  const [existing] = await tx.$queryRaw<
    Credit[]
  >`/*media-stock:credit*/ SELECT * FROM "MediaStorageCredit" WHERE "componentId"=${component.id}`;
  if (existing) {
    if (
      intent.state !== 'ACKNOWLEDGED' ||
      !intent.acknowledgedAt ||
      existing.intentId !== intent.id ||
      existing.bytes !== component.chargedBytes ||
      existing.evidenceFingerprint !== verified.evidenceFingerprint
    )
      mediaBudgetFail('MEDIA_BUDGET_RETIREMENT_CONFLICT');
    return existing;
  }
  if (intent.state !== 'PREPARED' || intent.acknowledgedAt !== null)
    mediaBudgetFail('MEDIA_BUDGET_STATE_MISMATCH');
  const credited = mediaByteCount(global.creditedBytes + component.chargedBytes);
  if (credited > global.baselineBytes + global.committedBytes) mediaBudgetFail('MEDIA_BUDGET_STATE_MISMATCH');
  const credit: Credit = {
    componentId: component.id,
    intentId: intent.id,
    bytes: component.chargedBytes,
    evidenceFingerprint: verified.evidenceFingerprint,
    createdAt: now
  };
  await tx.$executeRaw`/*media-stock:insert-credit*/ INSERT INTO "MediaStorageCredit" ("componentId","intentId",bytes,"evidenceFingerprint","createdAt") VALUES (${credit.componentId},${credit.intentId},${credit.bytes},${credit.evidenceFingerprint},${now})`;
  await tx.$executeRaw`/*media-stock:save-credit*/ UPDATE "MediaBudgetState" SET "creditedBytes"=${credited} WHERE id='global'`;
  const changed =
    await tx.$executeRaw`/*media-stock:ack-intent*/ UPDATE "MediaRetirementIntent" SET state='ACKNOWLEDGED',"acknowledgedAt"=${now} WHERE id=${intent.id} AND state='PREPARED'`;
  if (changed !== 1) mediaBudgetFail('MEDIA_BUDGET_STATE_MISMATCH');
  return credit;
}

type Tx = Prisma.TransactionClient;
type DB = Pick<
  PrismaClient,
  '$queryRaw' | '$transaction' | 'avatarAsset' | 'memberProfile' | 'knowledgeImage'
>;
const physical = (c: Component, d: BoundDescription) => boundHash([c.generation, d.physicalFingerprint]);
function matches(c: Component, d: BoundDescription) {
  if (d.kind === 'lottery-image') {
    const owner = c.objectKey.split(':')[1];
    return (
      c.namespace === 'lottery-image' &&
      isMemberId(owner ?? '') &&
      c.objectKey === 'lottery:' + owner + ':' + d.objectId &&
      c.part === d.part &&
      c.contentBindingSha256 === d.contentHash &&
      c.chargedBytes === d.bytes
    );
  }
  return (
    c.part === d.part &&
    c.contentBindingSha256 === d.contentHash &&
    c.chargedBytes === d.bytes &&
    c.objectKey === d.kind + ':' + d.objectId
  );
}
async function bindWrite(
  tx: Tx,
  allocation: MediaBoundAllocationTicket,
  proofs: readonly MediaWriteProof[],
  scope:
    | 'avatar'
    | 'knowledge'
    | 'official-image'
    | 'daily'
    | 'wish'
    | 'lottery-image'
    | 'album-comment'
    | 'album-photo',
  accountId: string | null,
  objectId: string
) {
  const owner = verifiedBoundAllocation(allocation),
    descriptions = await Promise.all(
      proofs.map((proof) => verifiedMediaWrite(tx, proof, scope, accountId, objectId))
    );
  if (
    !owner ||
    owner.scope !== scope ||
    owner.accountId !== accountId ||
    owner.objectIdentity !==
      (scope === 'lottery-image'
        ? 'lottery:' + accountId + ':' + objectId
        : (scope === 'official-image' ? 'official' : scope) + ':' + objectId) ||
    descriptions.some((d) => !d)
  )
    mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  const expected = owner.parts.filter((p) => p.contentBindingSha256 !== null);
  if (
    expected.length !== descriptions.length ||
    new Set(descriptions.map((d) => d!.part)).size !== descriptions.length
  )
    mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
  await stockGlobal(tx);
  const [receipt] = await tx.$queryRaw<
    MediaBudgetReceipt[]
  >`/*media-stock:binding-receipt*/ SELECT * FROM "MediaUploadReceipt" WHERE scope=${owner.scope} AND "operationKey"=${owner.operationKey} FOR UPDATE`;
  if (
    !receipt ||
    receipt.state !== 'COMMITTED' ||
    receipt.attemptId !== owner.attemptId ||
    receipt.objectIdentity !== owner.objectIdentity ||
    receipt.accountId !== accountId ||
    receipt.fingerprint !== owner.fingerprint
  )
    mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  for (const part of expected) {
    const [c] = await tx.$queryRaw<
      Component[]
    >`/*media-stock:component-lock*/ SELECT * FROM "MediaStoredComponent" WHERE id=${part.id} FOR UPDATE`;
    const d = descriptions.find((d) => d!.part === part.part)!;
    if (
      !c ||
      c.receiptScope !== owner.scope ||
      c.receiptOperationKey !== owner.operationKey ||
      c.generation !== owner.attemptId ||
      !matches(c, d) ||
      c.contentBindingSha256 !== part.contentBindingSha256 ||
      c.chargedBytes !== part.chargedBytes
    )
      mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
    const fingerprint = physical(c, d);
    if (c.storageIdentityFingerprint !== null) {
      if (c.storageIdentityFingerprint !== fingerprint) mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
      continue;
    }
    const changed =
      await tx.$executeRaw`/*media-stock:bind-component*/ UPDATE "MediaStoredComponent" SET "storageIdentityFingerprint"=${fingerprint} WHERE id=${c.id} AND generation=${c.generation} AND "contentBindingSha256"=${c.contentBindingSha256} AND "storageIdentityFingerprint" IS NULL`;
    if (changed !== 1) mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
  }
}
// New Daily writes only; the business row, committed receipt and all three real write proofs agree.
export async function bindDailyPhotoWrite(
  tx: Tx,
  allocation: MediaBoundAllocationTicket,
  accountId: string,
  id: string,
  proofs: readonly MediaWriteProof[]
) {
  requireTransaction(tx);
  const owner = verifiedBoundAllocation(allocation);
  if (
    !owner ||
    owner.scope !== 'daily' ||
    owner.parts.length !== 3 ||
    proofs.length !== 3 ||
    owner.parts.some((p) => !['photo-original', 'photo-preview', 'photo-thumbnail'].includes(p.part))
  )
    mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  const [row] = await tx.$queryRaw<
    {
      ownerId: string;
      fingerprint: string;
      postId: string | null;
      commentId: string | null;
      removedAt: Date | null;
    }[]
  >`/*daily-orphan:bind-business*/ SELECT * FROM "DailyMedia" WHERE id=${id}`;
  if (
    !row ||
    row.ownerId !== accountId ||
    row.fingerprint !== owner.fingerprint ||
    row.postId !== null ||
    row.commentId !== null ||
    row.removedAt !== null
  )
    mediaBudgetFail('MEDIA_BOUND_BUSINESS_REQUIRED');
  await bindWrite(tx, allocation, proofs, 'daily', accountId, id);
}
// New Wish writes only; the business row, committed receipt and all three real write proofs agree.
export async function bindWishPhotoWrite(
  tx: Tx,
  allocation: MediaBoundAllocationTicket,
  accountId: string,
  id: string,
  proofs: readonly MediaWriteProof[]
) {
  requireTransaction(tx);
  const owner = verifiedBoundAllocation(allocation);
  if (
    !owner ||
    owner.scope !== 'wish' ||
    owner.parts.length !== 3 ||
    proofs.length !== 3 ||
    owner.parts.some((p) => !['photo-original', 'photo-preview', 'photo-thumbnail'].includes(p.part))
  )
    mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  const [row] = await tx.$queryRaw<
    {
      ownerId: string;
      fingerprint: string;
      wishId: string | null;
      commentId: string | null;
      removedAt: Date | null;
    }[]
  >`/*wish-orphan:bind-business*/ SELECT * FROM "WishMedia" WHERE id=${id}`;
  if (
    !row ||
    row.ownerId !== accountId ||
    row.fingerprint !== owner.fingerprint ||
    row.wishId !== null ||
    row.commentId !== null ||
    row.removedAt !== null
  )
    mediaBudgetFail('MEDIA_BOUND_BUSINESS_REQUIRED');
  await bindWrite(tx, allocation, proofs, 'wish', accountId, id);
}
export async function bindKnowledgePhotoWrite(
  tx: Tx,
  allocation: MediaBoundAllocationTicket,
  accountId: string,
  id: string,
  photoProofs: readonly MediaWriteProof[],
  journalProof: BoundWriteProof
) {
  requireTransaction(tx);
  const owner = verifiedBoundAllocation(allocation),
    image = await tx.knowledgeImage.findUnique({ where: { id } });
  const journal = verifiedBoundWrite(journalProof);
  const photos = owner?.parts.filter((p) => p.part.startsWith('photo-'));
  if (
    !owner ||
    owner.scope !== 'knowledge' ||
    owner.parts.length !== 4 ||
    photos?.length !== 3 ||
    photoProofs.length !== 3 ||
    !image ||
    image.uploaderId !== accountId ||
    image.digest !== owner.fingerprint ||
    image.articleId !== null ||
    image.commentId !== null ||
    image.orphanMountedAt !== null ||
    !journal ||
    journal.part !== 'knowledge-journal' ||
    journal.requestFingerprint !== image.digest ||
    journal.originalBytes !== BigInt(image.bytes) ||
    journal.mediaBytes !== photos.reduce((n, p) => n + p.chargedBytes, 0n)
  )
    mediaBudgetFail('MEDIA_BOUND_BUSINESS_REQUIRED');
  await bindWrite(tx, allocation, [...photoProofs, journalProof], 'knowledge', accountId, id);
}
/** Only future photo uploads enroll components. No legacy aggregate adoption or historical backfill. */
export async function bindAlbumPhotoWrite(
  tx: Tx,
  allocation: MediaBoundAllocationTicket,
  accountId: string,
  id: string,
  proofs: readonly MediaWriteProof[]
) {
  requireTransaction(tx);
  const owner = verifiedBoundAllocation(allocation),
    row = await tx.albumPhoto.findUnique({ where: { id } });
  if (
    !owner ||
    owner.scope !== 'album-photo' ||
    owner.parts.length !== 3 ||
    proofs.length !== 3 ||
    owner.parts.some((p) => !['photo-original', 'photo-preview', 'photo-thumbnail'].includes(p.part)) ||
    !row ||
    row.uploaderId !== accountId ||
    row.removedAt !== null ||
    row.uploadAlbumId !== null ||
    owner.fingerprint !==
      createHash('sha256')
        .update(row.digest)
        .update('\0')
        .update(JSON.stringify(row.periodActivityId))
        .digest('hex') ||
    owner.parts.find((p) => p.part === 'photo-original')?.chargedBytes !== BigInt(row.bytes)
  )
    mediaBudgetFail('MEDIA_BOUND_BUSINESS_REQUIRED');
  await bindWrite(tx, allocation, proofs, 'album-photo', accountId, id);
}
export async function bindAlbumCommentPhotoWrite(
  tx: Tx,
  allocation: MediaBoundAllocationTicket,
  accountId: string,
  id: string,
  proofs: readonly MediaWriteProof[]
) {
  requireTransaction(tx);
  const owner = verifiedBoundAllocation(allocation),
    row = await tx.albumCommentMedia.findUnique({ where: { id } });
  if (
    !owner ||
    owner.scope !== 'album-comment' ||
    owner.parts.length !== 3 ||
    proofs.length !== 3 ||
    owner.parts.some((p) => !['photo-original', 'photo-preview', 'photo-thumbnail'].includes(p.part)) ||
    !row ||
    row.ownerId !== accountId ||
    row.fingerprint !== owner.fingerprint ||
    row.commentId !== null ||
    row.removedAt !== null ||
    row.orphanMountedAt !== null
  )
    mediaBudgetFail('MEDIA_BOUND_BUSINESS_REQUIRED');
  await bindWrite(tx, allocation, proofs, 'album-comment', accountId, id);
}
/** Lottery has no media business row; its exact committed receipt owns the asset.
 * Called in the original final upload transaction after commit and before final auth refresh. */
export async function bindLotteryPhotoWrite(
  tx: Tx,
  allocation: MediaBoundAllocationTicket,
  accountId: string,
  id: string,
  proofs: readonly MediaWriteProof[]
) {
  requireTransaction(tx);
  const owner = verifiedBoundAllocation(allocation);
  if (
    !owner ||
    owner.scope !== 'lottery-image' ||
    owner.parts.length !== 3 ||
    proofs.length !== 3 ||
    owner.parts.some((p) => !['photo-original', 'photo-preview', 'photo-thumbnail'].includes(p.part))
  )
    mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  await bindWrite(tx, allocation, proofs, 'lottery-image', accountId, id);
}
/** New unattached system asset: caller commits and binds all three real writes in this same TX. */
export async function bindOfficialWrite(
  tx: Tx,
  allocation: MediaBoundAllocationTicket,
  id: string,
  proofs: readonly MediaWriteProof[]
) {
  requireTransaction(tx);
  const owner = verifiedBoundAllocation(allocation);
  if (
    !owner ||
    owner.scope !== 'official-image' ||
    owner.accountId !== null ||
    owner.parts.length !== 3 ||
    proofs.length !== 3
  )
    mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  await bindWrite(tx, allocation, proofs, 'official-image', null, id);
}
export async function bindAvatarWrite(
  tx: Tx,
  allocation: MediaBoundAllocationTicket,
  accountId: string,
  id: string,
  proofs: readonly MediaWriteProof[]
) {
  requireTransaction(tx);
  const asset = await tx.avatarAsset.findUnique({ where: { id } }),
    profile = await tx.memberProfile.findUnique({ where: { accountId } });
  const descriptions = await Promise.all(
    proofs.map((proof) => verifiedMediaWrite(tx, proof, 'avatar', accountId, id))
  );
  const full = descriptions.find((d) => d?.part === 'avatar-full'),
    small = descriptions.find((d) => d?.part === 'avatar-small');
  if (
    !asset ||
    asset.accountId !== accountId ||
    profile?.avatarId !== id ||
    !full ||
    !small ||
    BigInt(asset.bytes) !== full.bytes ||
    BigInt(asset.smallBytes) !== small.bytes
  )
    mediaBudgetFail('MEDIA_BOUND_BUSINESS_REQUIRED');
  await bindWrite(tx, allocation, proofs, 'avatar', accountId, id);
}
export async function bindKnowledgeJournalWrite(
  tx: Tx,
  allocation: MediaBoundAllocationTicket,
  accountId: string,
  id: string,
  proof: BoundWriteProof
) {
  requireTransaction(tx);
  const owner = verifiedBoundAllocation(allocation),
    image = await tx.knowledgeImage.findUnique({ where: { id } });
  const d = verifiedBoundWrite(proof),
    media = owner?.parts.find((p) => p.part === 'knowledge-media');
  if (
    !owner ||
    !image ||
    image.uploaderId !== accountId ||
    image.digest !== owner.fingerprint ||
    !d ||
    d.requestFingerprint !== image.digest ||
    d.originalBytes !== BigInt(image.bytes) ||
    d.mediaBytes !== media?.chargedBytes
  )
    mediaBudgetFail('MEDIA_BOUND_BUSINESS_REQUIRED');
  await bindWrite(tx, allocation, [proof], 'knowledge', accountId, id);
}
async function readBound(
  db: Pick<PrismaClient, '$queryRaw'>,
  scope: 'avatar' | 'knowledge',
  accountId: string,
  id: string
) {
  const rows = await db.$queryRaw<
    Component[]
  >`/*media-stock:read-bound*/ SELECT c.* FROM "MediaStoredComponent" c JOIN "MediaUploadReceipt" r ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey" WHERE r.scope=${scope} AND r."objectIdentity"=${scope + ':' + id} AND r."accountId"=${accountId} AND r.state='COMMITTED' AND c."contentBindingSha256" IS NOT NULL AND c."storageIdentityFingerprint" IS NOT NULL ORDER BY c.part`;
  return rows.filter((c) =>
    scope === 'avatar' ? c.policy === 'AVATAR_VARIANT' : c.policy === 'KNOWLEDGE_JOURNAL'
  );
}
interface Pending {
  component: Component;
  namespace?: MediaRetirementNamespace;
  ticket: object;
  description: BoundDescription;
  intent?: Intent;
  evidence?: MediaRetirementEvidence;
  started?: boolean;
}
async function inspectParts(namespace: MediaRetirementNamespace, components: Component[], id: string) {
  const parts: Pending[] = [];
  try {
    for (const component of components) {
      const ticket = await namespace.inspect(
          id,
          component.part as 'avatar-full' | 'avatar-small' | 'knowledge-journal',
          component.contentBindingSha256!,
          component.chargedBytes
        ),
        description = namespace.describe(ticket)!;
      parts.push({ component, ticket, description });
      if (
        !matches(component, description) ||
        physical(component, description) !== component.storageIdentityFingerprint
      )
        mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
    }
    return parts;
  } catch (error) {
    for (const p of parts) await namespace.close(p.ticket).catch(() => undefined);
    throw error;
  }
}
async function prepareParts(tx: Tx, parts: Pending[], authorityFingerprint: string, now: Date) {
  for (const p of parts) {
    const authority = Object.freeze({}) as MediaRetirementAuthority;
    authorities.set(authority, {
      componentId: p.component.id,
      generation: p.component.generation,
      identityFingerprint: p.component.storageIdentityFingerprint!,
      authorityFingerprint
    });
    p.intent = await prepareMediaRetirement(tx, authority, now);
  }
}
async function finishParts(
  db: Pick<PrismaClient, '$queryRaw' | '$transaction'>,
  namespace: MediaRetirementNamespace,
  parts: Pending[],
  now: () => Date
) {
  if (!parts.length || parts.some((p) => !p.intent)) mediaBudgetFail('MEDIA_BOUND_INTENT_REQUIRED');
  // Independent connection reads prove the intent transaction durably committed before any unlink.
  const durable = [];
  for (const p of parts) {
    const [row] = await db.$queryRaw<
      Intent[]
    >`/*media-stock:durable-intent*/ SELECT * FROM "MediaRetirementIntent" WHERE id=${p.intent!.id}`;
    if (
      !row ||
      row.componentId !== p.component.id ||
      row.identityFingerprint !== p.intent!.identityFingerprint ||
      row.authorityFingerprint !== p.intent!.authorityFingerprint
    )
      mediaBudgetFail('MEDIA_BOUND_INTENT_REQUIRED');
    durable.push(row);
  }
  if (durable.every((row) => row.state === 'ACKNOWLEDGED')) {
    for (const p of parts) {
      const [credit] = await db.$queryRaw<
        Credit[]
      >`/*media-stock:credit*/ SELECT * FROM "MediaStorageCredit" WHERE "componentId"=${p.component.id}`;
      if (!credit || credit.intentId !== p.intent!.id || credit.bytes !== p.component.chargedBytes)
        mediaBudgetFail('MEDIA_BOUND_INTENT_REQUIRED');
    }
    return;
  }
  if (
    durable.some((row) => row.state !== 'PREPARED') ||
    (parts.some((p) => p.started) && !parts.every((p) => p.evidence))
  )
    mediaBudgetFail('MEDIA_BOUND_UNCERTAIN');
  try {
    if (!parts.every((p) => p.evidence)) {
      const proofs: object[] = [];
      // Mark the whole batch before unlink: partial success can never trigger a second cleanup attempt.
      for (const p of parts) p.started = true;
      for (const p of parts) {
        const proof = await (p.namespace ?? namespace).remove(p.ticket),
          d = verifiedBoundRemoval(proof);
        if (
          !d ||
          !matches(p.component, d) ||
          physical(p.component, d) !== p.component.storageIdentityFingerprint
        )
          mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
        proofs.push(proof);
      }
      for (const [index, p] of parts.entries()) {
        if (!verifiedBoundRemoval(proofs[index]!)) mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
        const cap = Object.freeze({}) as MediaRetirementEvidence;
        evidences.set(cap, {
          intentId: p.intent!.id,
          componentId: p.component.id,
          generation: p.component.generation,
          identityFingerprint: p.intent!.identityFingerprint,
          authorityFingerprint: p.intent!.authorityFingerprint,
          evidenceFingerprint: boundHash([
            'durable-unlink-v1',
            p.intent!.id,
            p.component.id,
            p.component.generation,
            p.component.storageIdentityFingerprint
          ])
        });
        p.evidence = cap;
      }
    }
    // A lost ACK can only retry these same process-local real proofs. No re-delete / ENOENT remint.
    await db.$transaction(async (tx) => {
      for (const p of parts) await acknowledgeMediaRetirement(tx, p.evidence!, now());
    });
  } finally {
    for (const p of parts) await (p.namespace ?? namespace).close(p.ticket).catch(() => undefined);
  }
}
/** Only the original successful avatar replacement may use this short-lived plan. No reconstructed old objects. */
export async function inspectSupersededAvatar(
  db: DB,
  namespace: MediaRetirementNamespace,
  accountId: string,
  oldId: string
) {
  const asset = await db.avatarAsset.findUnique({ where: { id: oldId } }),
    components = await readBound(db, 'avatar', accountId, oldId);
  if (
    !asset ||
    asset.accountId !== accountId ||
    components.length !== 2 ||
    !components.some((c) => c.part === 'avatar-full' && c.chargedBytes === BigInt(asset.bytes)) ||
    !components.some((c) => c.part === 'avatar-small' && c.chargedBytes === BigInt(asset.smallBytes))
  )
    return null;
  const parts = await inspectParts(namespace, components, oldId);
  let removal: { tx: Tx; newId: string; revision: number } | null = null;
  return {
    async removeRecord(tx: Tx, newId: string) {
      requireTransaction(tx);
      const old = await tx.avatarAsset.findUnique({ where: { id: oldId } }),
        profile = await tx.memberProfile.findUnique({ where: { accountId } });
      const removed = await tx.avatarAsset.deleteMany({ where: { id: oldId, accountId, profile: null } });
      if (
        removed.count === 1 &&
        old?.accountId === accountId &&
        old.bytes === asset.bytes &&
        old.smallBytes === asset.smallBytes &&
        profile?.avatarId === newId
      )
        removal = { tx, newId, revision: profile.revision };
      return removed;
    },
    async prepare(tx: Tx, now: Date) {
      requireTransaction(tx);
      if (!removal || removal.tx !== tx) mediaBudgetFail('MEDIA_BOUND_BUSINESS_REQUIRED');
      await prepareParts(
        tx,
        parts,
        boundHash(['avatar-replaced-v1', accountId, oldId, removal.newId, removal.revision]),
        now
      );
    },
    async finish(clock: () => Date) {
      await finishParts(db, namespace, parts, clock);
    },
    async close() {
      for (const p of parts) await namespace.close(p.ticket).catch(() => undefined);
    }
  };
}
/** Current committed upload only: rollback/replay/UNKNOWN/reconciliation do not obtain this plan. */
export async function inspectKnowledgeJournal(
  namespace: MediaRetirementNamespace,
  id: string,
  preparedHash: string,
  amount: bigint
) {
  const ticket = await namespace.inspect(id, 'knowledge-journal', preparedHash, amount),
    description = namespace.describe(ticket)!;
  let pending: Pending[] = [];
  return {
    async prepare(tx: Tx, accountId: string, now: Date) {
      requireTransaction(tx);
      const image = await tx.knowledgeImage.findUnique({ where: { id } }),
        rows = await readBound(tx, 'knowledge', accountId, id);
      if (
        !image ||
        image.uploaderId !== accountId ||
        rows.length !== 1 ||
        !matches(rows[0]!, description) ||
        physical(rows[0]!, description) !== rows[0]!.storageIdentityFingerprint
      )
        mediaBudgetFail('MEDIA_BOUND_BUSINESS_REQUIRED');
      pending = [{ component: rows[0]!, ticket, description }];
      await prepareParts(
        tx,
        pending,
        boundHash([
          'knowledge-upload-committed-v1',
          id,
          accountId,
          image.digest,
          image.batchId,
          image.batchIndex
        ]),
        now
      );
    },
    async finish(db: DB, clock: () => Date) {
      await finishParts(db, namespace, pending, clock);
    },
    async close() {
      await namespace.close(ticket).catch(() => undefined);
    }
  };
}

const officialPending = new WeakMap<object, Pending[]>();

/** Process-local batch only. The same private evidence/ACK kernel credits all three parts atomically. */
async function retireOfficialUnusedBatchRun(
  db: Pick<PrismaClient, '$queryRaw' | '$transaction'>,
  namespaces: { original: MediaRetirementNamespace; derived: MediaRetirementNamespace },
  batch: OfficialUnusedBatch,
  clock: () => Date
) {
  const description = verifiedOfficialUnusedBatch(batch);
  if (!description || !description.candidates.length) mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  const existing = officialPending.get(batch);
  if (existing) {
    await finishParts(db, namespaces.original, existing, clock);
    return;
  }
  const pending: Pending[] = [];
  try {
    for (const candidate of description.candidates) {
      if (candidate.components.length !== 3 || candidate.intents.length !== 3)
        mediaBudgetFail('MEDIA_BOUND_INTENT_REQUIRED');
      for (const component of candidate.components) {
        const intent = candidate.intents.find((intent) => intent.componentId === component.id);
        if (!intent || intent.identityFingerprint !== component.storageIdentityFingerprint)
          mediaBudgetFail('MEDIA_BOUND_INTENT_REQUIRED');
        const namespace = component.part === 'official-original' ? namespaces.original : namespaces.derived;
        const ticket = await namespace.inspect(
          candidate.id,
          component.part,
          component.contentBindingSha256,
          component.chargedBytes
        );
        const d = namespace.describe(ticket)!;
        const c: Component = {
          ...component,
          sourceKind: 'RECEIPT',
          receiptScope: 'official-image',
          receiptOperationKey: candidate.operationKey,
          baselineStateId: null,
          baselineFingerprint: null,
          namespace: 'official-image',
          objectKey: 'official:' + candidate.id,
          policy: 'OFFICIAL_VARIANT',
          createdAt: new Date(intent.createdAt)
        };
        const part: Pending = {
          component: c,
          ticket,
          description: d,
          namespace,
          intent: { ...intent, state: 'PREPARED', acknowledgedAt: null }
        };
        pending.push(part);
        if (!matches(c, d) || physical(c, d) !== c.storageIdentityFingerprint)
          mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
      }
    }
    officialPending.set(batch, pending);
    await finishParts(db, namespaces.original, pending, clock);
  } finally {
    for (const part of pending) await part.namespace!.close(part.ticket).catch(() => undefined);
  }
}

const officialRunning = new WeakMap<object, Promise<void>>();
export async function retireOfficialUnusedBatch(
  db: Pick<PrismaClient, '$queryRaw' | '$transaction'>,
  namespaces: { original: MediaRetirementNamespace; derived: MediaRetirementNamespace },
  batch: OfficialUnusedBatch,
  clock: () => Date
): Promise<void> {
  // A nested Prisma itx can expose $transaction; independent visible reads and ACK require the root client.
  if (
    typeof (db as { $connect?: unknown }).$connect !== 'function' ||
    typeof (db as { $disconnect?: unknown }).$disconnect !== 'function'
  )
    mediaBudgetFail('MEDIA_BUDGET_ROOT_CLIENT_REQUIRED');
  if (!verifiedOfficialUnusedBatch(batch)) mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  const existing = officialRunning.get(batch);
  if (existing) return existing;
  const running = retireOfficialUnusedBatchRun(db, namespaces, batch, clock);
  officialRunning.set(batch, running);
  try {
    await running;
  } finally {
    if (officialRunning.get(batch) === running) officialRunning.delete(batch);
  }
}

// Scope-verified photo, process-local recovery. Each proved unlink is retained immediately; a failed
// remaining part is reopened and identity-checked on retry. ENOENT never creates proof.
type DailyPending = {
  component: DailyPhotoComponent;
  intent: Intent;
  evidence?: MediaRetirementEvidence;
};
const dailyPending = new WeakMap<object, DailyPending[]>();
const dailyRunning = new WeakMap<object, Promise<boolean>>();
async function retirePhotoOrphan(
  db: Pick<PrismaClient, '$queryRaw' | '$transaction'>,
  namespaces: { original: MediaRetirementNamespace; derived: MediaRetirementNamespace },
  batch:
    DailyOrphanBatch | WishOrphanBatch | LotteryOrphanBatch | KnowledgeOrphanBatch | AlbumCommentOrphanBatch,
  policy: import('@artzoo/domain').MediaBudgetPolicy,
  clock: () => Date,
  scope: 'daily' | 'wish' | 'lottery-image' | 'knowledge' | 'album-comment'
): Promise<boolean> {
  // No DB/storage/clock/capability access when either explicit execution gate is OFF.
  if (policy.enabled !== true || policy.cleanupExecute !== true) return false;
  if (
    typeof (db as { $connect?: unknown }).$connect !== 'function' ||
    typeof (db as { $disconnect?: unknown }).$disconnect !== 'function'
  )
    mediaBudgetFail('MEDIA_BUDGET_ROOT_CLIENT_REQUIRED');
  const candidate =
    scope === 'knowledge'
      ? verifiedKnowledgeOrphanBatch(batch)
      : scope === 'album-comment'
        ? verifiedAlbumCommentOrphanBatch(batch)
        : scope === 'lottery-image'
          ? verifiedLotteryOrphanBatch(batch)
          : scope === 'daily'
            ? verifiedDailyOrphanBatch(batch)
            : verifiedWishOrphanBatch(batch);
  if (!candidate) mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  const active = dailyRunning.get(batch);
  if (active) return active;
  const run = (async () => {
    let parts = dailyPending.get(batch);
    if (!parts) {
      parts = candidate.components.map((component) => {
        const intent = candidate.intents.find((i) => i.componentId === component.id);
        if (!intent || intent.identityFingerprint !== component.storageIdentityFingerprint)
          mediaBudgetFail('MEDIA_BOUND_INTENT_REQUIRED');
        return { component, intent: { ...intent, state: 'PREPARED', acknowledgedAt: null } as Intent };
      });
      dailyPending.set(batch, parts);
    }
    // Independent root reads must confirm the entire permanent fence before any IO.
    const durable: Intent[] = [];
    for (const p of parts) {
      const [intent] = await db.$queryRaw<
        Intent[]
      >`/*media-stock:durable-intent*/ SELECT * FROM "MediaRetirementIntent" WHERE id=${p.intent.id}`;
      if (
        !intent ||
        intent.componentId !== p.component.id ||
        intent.identityFingerprint !== p.intent.identityFingerprint ||
        intent.authorityFingerprint !== p.intent.authorityFingerprint
      )
        mediaBudgetFail('MEDIA_BOUND_INTENT_REQUIRED');
      durable.push(intent);
    }
    if (durable.every((i) => i.state === 'ACKNOWLEDGED')) {
      for (const p of parts) {
        const [credit] = await db.$queryRaw<
          Credit[]
        >`/*media-stock:credit*/ SELECT * FROM "MediaStorageCredit" WHERE "componentId"=${p.component.id}`;
        if (!credit || credit.intentId !== p.intent.id || credit.bytes !== p.component.chargedBytes)
          mediaBudgetFail('MEDIA_BOUND_INTENT_REQUIRED');
      }
      return true;
    }
    if (durable.some((i) => i.state !== 'PREPARED')) mediaBudgetFail('MEDIA_BOUND_UNCERTAIN');
    if (scope === 'lottery-image') {
      for (const p of parts) {
        if (p.evidence) continue;
        const namespace = p.component.part === 'photo-original' ? namespaces.original : namespaces.derived;
        const ticket = await namespace.inspect(
          candidate.id,
          p.component.part,
          p.component.contentBindingSha256,
          p.component.chargedBytes
        );
        try {
          const before = namespace.describe(ticket);
          if (
            !before ||
            !matches(p.component, before) ||
            physical(p.component, before) !== p.component.storageIdentityFingerprint
          )
            mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
        } finally {
          await namespace.close(ticket);
        }
      }
    }
    for (const p of parts) {
      if (p.evidence) continue;
      const namespace = p.component.part === 'photo-original' ? namespaces.original : namespaces.derived;
      const ticket = await namespace.inspect(
        candidate.id,
        p.component.part,
        p.component.contentBindingSha256,
        p.component.chargedBytes
      );
      try {
        const before = namespace.describe(ticket);
        if (
          !before ||
          !matches(p.component, before) ||
          physical(p.component, before) !== p.component.storageIdentityFingerprint
        )
          mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
        const removed = verifiedBoundRemoval(await namespace.remove(ticket));
        if (
          !removed ||
          !matches(p.component, removed) ||
          physical(p.component, removed) !== p.component.storageIdentityFingerprint
        )
          mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
        const cap = Object.freeze({}) as MediaRetirementEvidence;
        evidences.set(cap, {
          intentId: p.intent.id,
          componentId: p.component.id,
          generation: p.component.generation,
          identityFingerprint: p.intent.identityFingerprint,
          authorityFingerprint: p.intent.authorityFingerprint,
          evidenceFingerprint: boundHash([
            scope + '-durable-unlink-v1',
            p.intent.id,
            p.component.id,
            p.component.generation,
            p.component.storageIdentityFingerprint
          ])
        });
        p.evidence = cap;
      } finally {
        await namespace.close(ticket).catch(() => undefined);
      }
    }
    // Three real live proofs are required. ACK loss can retry credit without re-deleting.
    await db.$transaction(async (tx) => {
      for (const p of parts!) await acknowledgeMediaRetirement(tx, p.evidence!, clock());
    });
    return true;
  })();
  dailyRunning.set(batch, run);
  try {
    return await run;
  } finally {
    if (dailyRunning.get(batch) === run) dailyRunning.delete(batch);
  }
}

export function retireDailyOrphan(
  db: Pick<PrismaClient, '$queryRaw' | '$transaction'>,
  namespaces: { original: MediaRetirementNamespace; derived: MediaRetirementNamespace },
  batch: DailyOrphanBatch,
  policy: import('@artzoo/domain').MediaBudgetPolicy,
  clock: () => Date
): Promise<boolean> {
  return retirePhotoOrphan(db, namespaces, batch, policy, clock, 'daily');
}
export function retireWishOrphan(
  db: Pick<PrismaClient, '$queryRaw' | '$transaction'>,
  namespaces: { original: MediaRetirementNamespace; derived: MediaRetirementNamespace },
  batch: WishOrphanBatch,
  policy: import('@artzoo/domain').MediaBudgetPolicy,
  clock: () => Date
): Promise<boolean> {
  return retirePhotoOrphan(db, namespaces, batch, policy, clock, 'wish');
}

export function retireLotteryOrphan(
  db: Pick<PrismaClient, '$queryRaw' | '$transaction'>,
  namespaces: { original: MediaRetirementNamespace; derived: MediaRetirementNamespace },
  batch: LotteryOrphanBatch,
  policy: import('@artzoo/domain').MediaBudgetPolicy,
  clock: () => Date
): Promise<boolean> {
  return retirePhotoOrphan(db, namespaces, batch, policy, clock, 'lottery-image');
}

export function retireKnowledgeOrphan(
  db: Pick<PrismaClient, '$queryRaw' | '$transaction'>,
  namespaces: { original: MediaRetirementNamespace; derived: MediaRetirementNamespace },
  batch: KnowledgeOrphanBatch,
  policy: import('@artzoo/domain').MediaBudgetPolicy,
  clock: () => Date
) {
  return retirePhotoOrphan(db, namespaces, batch, policy, clock, 'knowledge');
}
export async function retireAlbumCommentOrphan(
  db: Pick<PrismaClient, '$queryRaw' | '$transaction'>,
  namespaces: { original: MediaRetirementNamespace; derived: MediaRetirementNamespace },
  batch: AlbumCommentOrphanBatch,
  policy: import('@artzoo/domain').MediaBudgetPolicy,
  clock: () => Date
) {
  if (policy.enabled !== true || policy.cleanupExecute !== true) return false;
  const candidate = verifiedAlbumCommentOrphanBatch(batch);
  if (!candidate) mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  if (!(await retirePhotoOrphan(db, namespaces, batch, policy, clock, 'album-comment'))) return false;
  // Retain the original unique key as a tombstone; never delete the receipt/fence/audit ledger.
  await db.$transaction(async (tx) => {
    const row = await tx.albumCommentMedia.findUnique({ where: { id: candidate.id } });
    if (!row || row.ownerId !== candidate.accountId) mediaBudgetFail('MEDIA_BOUND_BUSINESS_REQUIRED');
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'album:' + row.albumId},0))::text`;
    const changed = await tx.albumCommentMedia.updateMany({
      where: {
        id: row.id,
        ownerId: candidate.accountId,
        commentId: null,
        orphanMountedAt: null,
        removedAt: null
      },
      data: { removedAt: clock() }
    });
    if (changed.count !== 1 && row.removedAt === null) mediaBudgetFail('MEDIA_BOUND_BUSINESS_REQUIRED');
  });
  return true;
}

/** Called only by the authorized current delete transaction, after marking its exact current rows.
 * The old aggregate and all historical soft-deletions stay outside this path.
 * - eligible: three committed stored components; files are verified against them before removal.
 * - unbound: uploaded while the media budget was off, so no component exists; removed directly by id.
 * - retained: still a live cover, or components exist but cannot be verified (bytes are kept). */
async function albumPhotoRemovalCandidate(tx: Tx, id: string, albumId: string) {
  requireTransaction(tx);
  if (!isMemberId(id) || !isMemberId(albumId)) mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  const photo = await tx.albumPhoto.findUnique({ where: { id }, include: { album: true } });
  if (!photo || photo.albumId !== albumId || (!photo.removedAt && !photo.album.removedAt))
    return { status: 'retained' as const };
  // Covers are actual binary references. Comments/likes/audits/notifications are retained metadata.
  if (await tx.album.count({ where: { coverPhotoId: id, removedAt: null } }))
    return { status: 'retained' as const };
  const [known] = await tx.$queryRaw<{ count: bigint }[]>`/*album-removal:any-component*/
    SELECT COUNT(*)::bigint AS count FROM "MediaStoredComponent"
    WHERE "receiptScope"='album-photo' AND "objectKey"=${'album-photo:' + id}`;
  if (!known?.count) return { status: 'unbound' as const };
  const rows = await tx.$queryRaw<Component[]>`/*album-removal:components*/
    SELECT c.* FROM "MediaStoredComponent" c JOIN "MediaUploadReceipt" r
    ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
    WHERE c."receiptScope"='album-photo' AND c."objectKey"=${'album-photo:' + id}
      AND r.state='COMMITTED' AND r."accountId"=${photo.uploaderId}
    ORDER BY c.part`;
  // Never split/adopt old aggregate/baseline/unbound/UNKNOWN writes.
  if (
    rows.length !== 3 ||
    rows.some(
      (c) =>
        c.sourceKind !== 'RECEIPT' ||
        c.policy !== 'PHOTO_VARIANT' ||
        !c.contentBindingSha256 ||
        !c.storageIdentityFingerprint
    ) ||
    new Set(rows.map((c) => c.part)).size !== 3 ||
    rows.some((c) => !['photo-original', 'photo-preview', 'photo-thumbnail'].includes(c.part)) ||
    rows.find((c) => c.part === 'photo-original')?.chargedBytes !== BigInt(photo.bytes)
  )
    return { status: 'retained' as const };
  return { status: 'eligible' as const, photo, rows };
}
/** Read-only eligibility. Never creates a retirement fence or performs storage IO. */
export async function inspectAlbumPhotoRemoval(tx: Tx, id: string, albumId: string) {
  return (await albumPhotoRemovalCandidate(tx, id, albumId)).status;
}
/** prepared: durable fences written, verified removal follows. direct: caller removes the files by id. */
export async function prepareAlbumPhotoRemoval(tx: Tx, id: string, albumId: string) {
  const candidate = await albumPhotoRemovalCandidate(tx, id, albumId);
  if (candidate.status === 'unbound') return 'direct' as const;
  if (candidate.status !== 'eligible') return candidate.status;
  const { photo, rows } = candidate;
  const authorityFingerprint = boundHash([
    'album-photo-deleted-v1',
    id,
    albumId,
    (photo.removedAt ?? photo.album.removedAt)!.toISOString(),
    photo.revision
  ]);
  for (const c of rows) {
    const authority = Object.freeze({}) as MediaRetirementAuthority;
    authorities.set(authority, {
      componentId: c.id,
      generation: c.generation,
      identityFingerprint: c.storageIdentityFingerprint!,
      authorityFingerprint
    });
    await prepareMediaRetirement(tx, authority, (photo.removedAt ?? photo.album.removedAt)!);
  }
  return 'prepared' as const;
}
export interface AlbumReclamationResult {
  status: 'complete' | 'pending' | 'retained';
  completed: number;
  pending: number;
  remainingIds: string[];
}
// Same-process actual evidence survives a failed DB ACK. There is no background job or history scan.
const albumRemovalEvidence = new Map<string, MediaRetirementEvidence>();
const albumRemovalRunning = new Map<string, Promise<void>>();
async function retireAlbumPhotoRemoval(
  db: Pick<PrismaClient, '$queryRaw' | '$transaction'>,
  namespaces: { original: MediaRetirementNamespace; derived: MediaRetirementNamespace },
  id: string,
  clock: () => Date,
  assertActive?: () => void
) {
  const active = albumRemovalRunning.get(id);
  if (active) return active;
  const run = (async () => {
    const rows = await db.$queryRaw<Component[]>`/*album-removal:components*/
      SELECT c.* FROM "MediaStoredComponent" c JOIN "MediaUploadReceipt" r
      ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c."receiptScope"='album-photo' AND c."objectKey"=${'album-photo:' + id}
        AND r.state='COMMITTED' ORDER BY c.part`;
    if (
      rows.length !== 3 ||
      new Set(rows.map((c) => c.part)).size !== 3 ||
      rows.some(
        (c) =>
          c.sourceKind !== 'RECEIPT' ||
          c.policy !== 'PHOTO_VARIANT' ||
          !['photo-original', 'photo-preview', 'photo-thumbnail'].includes(c.part) ||
          !c.contentBindingSha256 ||
          !c.storageIdentityFingerprint
      )
    )
      mediaBudgetFail('MEDIA_BOUND_INTENT_REQUIRED');
    const pending: { component: Component; intent: Intent }[] = [];
    // All three permanent fences must be committed before any remote IO.
    for (const component of rows) {
      const [intent] = await db.$queryRaw<
        Intent[]
      >`/*media-stock:durable-component-intent*/ SELECT * FROM "MediaRetirementIntent" WHERE "componentId"=${component.id}`;
      if (
        !intent ||
        intent.identityFingerprint !== component.storageIdentityFingerprint ||
        !validHash(intent.authorityFingerprint)
      )
        mediaBudgetFail('MEDIA_BOUND_INTENT_REQUIRED');
      if (intent.state === 'ACKNOWLEDGED') {
        const [credit] = await db.$queryRaw<
          Credit[]
        >`/*media-stock:credit*/ SELECT * FROM "MediaStorageCredit" WHERE "componentId"=${component.id}`;
        if (!credit || credit.intentId !== intent.id || credit.bytes !== component.chargedBytes)
          mediaBudgetFail('MEDIA_BOUND_INTENT_REQUIRED');
      } else if (intent.state === 'PREPARED' && intent.acknowledgedAt === null)
        pending.push({ component, intent });
      else mediaBudgetFail('MEDIA_BOUND_UNCERTAIN');
    }
    for (const { component: c, intent } of pending) {
      assertActive?.();
      let evidence = albumRemovalEvidence.get(intent.id);
      if (!evidence) {
        const ns = c.part === 'photo-original' ? namespaces.original : namespaces.derived;
        const ticket = await ns.inspect(
          id,
          c.part as BoundDescription['part'],
          c.contentBindingSha256!,
          c.chargedBytes,
          assertActive
        );
        try {
          const before = ns.describe(ticket);
          if (!before || !matches(c, before) || physical(c, before) !== c.storageIdentityFingerprint)
            mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
          const removed = verifiedBoundRemoval(await ns.remove(ticket));
          if (!removed || !matches(c, removed) || physical(c, removed) !== c.storageIdentityFingerprint)
            mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
          evidence = Object.freeze({}) as MediaRetirementEvidence;
          evidences.set(evidence, {
            intentId: intent.id,
            componentId: c.id,
            generation: c.generation,
            identityFingerprint: intent.identityFingerprint,
            authorityFingerprint: intent.authorityFingerprint,
            evidenceFingerprint: boundHash([
              'album-photo-durable-removal-v1',
              intent.id,
              c.id,
              c.generation,
              c.storageIdentityFingerprint
            ])
          });
          albumRemovalEvidence.set(intent.id, evidence);
        } finally {
          await ns.close(ticket).catch(() => undefined);
        }
      }
      // Confirmed individual parts can credit independently. A failed later part never loses this ACK.
      await db.$transaction(async (tx) => {
        await acknowledgeMediaRetirement(tx, evidence!, clock());
      });
      albumRemovalEvidence.delete(intent.id);
    }
  })();
  albumRemovalRunning.set(id, run);
  try {
    await run;
  } finally {
    if (albumRemovalRunning.get(id) === run) albumRemovalRunning.delete(id);
  }
}
/** Exact targets only. This never creates intents, finds old removals, lists buckets, or guesses keys. */
export async function retireAlbumPhotoRemovals(
  db: Pick<PrismaClient, '$queryRaw' | '$transaction'>,
  namespaces: { original: MediaRetirementNamespace; derived: MediaRetirementNamespace },
  ids: readonly string[],
  clock: () => Date,
  budget?: { assertActive: () => void; maxPhotos: number }
): Promise<AlbumReclamationResult> {
  if (
    typeof (db as { $connect?: unknown }).$connect !== 'function' ||
    typeof (db as { $disconnect?: unknown }).$disconnect !== 'function'
  )
    mediaBudgetFail('MEDIA_BUDGET_ROOT_CLIENT_REQUIRED');
  if (ids.length > 1000 || new Set(ids).size !== ids.length || ids.some((id) => !isMemberId(id)))
    mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  let completed = 0,
    attempted = 0;
  const remainingIds: string[] = [];
  for (const id of ids) {
    try {
      if (budget && attempted >= budget.maxPhotos) throw Error('MEDIA_REMOVAL_BUDGET');
      budget?.assertActive();
      attempted++;
      await retireAlbumPhotoRemoval(db, namespaces, id, clock, budget?.assertActive);
      completed++;
    } catch {
      remainingIds.push(id);
    }
  }
  return {
    status: remainingIds.length ? 'pending' : 'complete',
    completed,
    pending: remainingIds.length,
    remainingIds
  };
}
