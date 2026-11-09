import { createHash } from 'node:crypto';
import { mediaBudgetFail, mediaByteCount, mediaBudgetDay } from '@artzoo/domain';
import type { MediaBudgetTx, MediaBudgetReceipt } from './media-budget.js';

/** Narrow, server-generated quotes. No paths, caller-defined policy, proof boolean or arbitrary component keys. */
export interface OfficialComponentAllocation {
  kind: 'official';
  originalBytes: bigint;
  previewBytes: bigint;
  thumbnailBytes: bigint;
  contentHashes: { original: string; preview: string; thumbnail: string };
}
export interface PhotoComponentAllocation {
  kind: 'photo';
  scope: 'daily' | 'wish' | 'lottery-image' | 'album-comment' | 'album-photo';
  originalBytes: bigint;
  previewBytes: bigint;
  thumbnailBytes: bigint;
  contentHashes: { original: string; preview: string; thumbnail: string };
}
export type MediaComponentAllocation =
  | PhotoComponentAllocation
  | OfficialComponentAllocation
  | { kind: 'avatar'; fullBytes: bigint; smallBytes: bigint; contentHashes?: { full: string; small: string } }
  | {
      kind: 'knowledge';
      mediaBytes: bigint;
      journalBytes: bigint;
      preparedSha256?: string;
      photo?: Omit<PhotoComponentAllocation, 'kind' | 'scope'>;
    };
/** Internal storage allocation extension; existing adapter public component API stays unchanged. */
export type MediaStoredComponentAllocation =
  MediaComponentAllocation | { kind: 'quick-icon'; bytes: bigint; contentSha256: string };
export type MediaBoundComponentAllocation =
  | PhotoComponentAllocation
  | OfficialComponentAllocation
  | { kind: 'avatar'; fullBytes: bigint; smallBytes: bigint; contentHashes: { full: string; small: string } }
  | {
      kind: 'knowledge';
      mediaBytes: bigint;
      journalBytes: bigint;
      preparedSha256: string;
      photo?: Omit<PhotoComponentAllocation, 'kind' | 'scope'>;
    };
type ComponentPart = {
  part: string;
  policy: string;
  chargedBytes: bigint;
  contentBindingSha256?: string | null;
};
interface Component extends ComponentPart {
  id: string;
  sourceKind: 'RECEIPT' | 'BASELINE';
  receiptScope: string | null;
  receiptOperationKey: string | null;
  baselineStateId: string | null;
  baselineFingerprint: string | null;
  namespace: string;
  objectKey: string;
  generation: string;
  createdAt: Date;
  contentBindingSha256: string | null;
  storageIdentityFingerprint: string | null;
}
const hash = (parts: unknown[]) =>
  createHash('sha256')
    .update(
      JSON.stringify(parts, (_key, value) =>
        typeof value === 'bigint' ? { bigint: value.toString() } : value
      )
    )
    .digest('hex');
const validHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function quoteMediaComponents(
  scope: string,
  mediaBytes: bigint,
  metadataBytes: bigint,
  allocation?: MediaStoredComponentAllocation
): ComponentPart[] {
  mediaByteCount(mediaBytes, true);
  mediaByteCount(metadataBytes);
  if (!allocation)
    return [
      {
        part: 'aggregate',
        policy: 'AGGREGATE_NEVER',
        chargedBytes: mediaByteCount(mediaBytes + metadataBytes, true)
      }
    ];
  if (
    allocation.kind === 'photo' &&
    scope === allocation.scope &&
    (scope === 'daily' ||
      scope === 'wish' ||
      scope === 'lottery-image' ||
      scope === 'album-comment' ||
      scope === 'album-photo')
  ) {
    validateBoundAllocation(allocation);
    if (
      metadataBytes !== 0n ||
      allocation.originalBytes + allocation.previewBytes + allocation.thumbnailBytes !== mediaBytes
    )
      mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    return (['original', 'preview', 'thumbnail'] as const).map((variant) => ({
      part: 'photo-' + variant,
      policy: 'PHOTO_VARIANT',
      chargedBytes: allocation[`${variant}Bytes`],
      contentBindingSha256: allocation.contentHashes[variant]
    }));
  }
  if (allocation.kind === 'official' && scope === 'official-image') {
    validateBoundAllocation(allocation);
    if (
      metadataBytes !== 0n ||
      allocation.originalBytes + allocation.previewBytes + allocation.thumbnailBytes !== mediaBytes
    )
      mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    return (['original', 'preview', 'thumbnail'] as const).map((variant) => ({
      part: 'official-' + variant,
      policy: 'OFFICIAL_VARIANT',
      chargedBytes: allocation[`${variant}Bytes`],
      contentBindingSha256: allocation.contentHashes[variant]
    }));
  }
  if (allocation.kind === 'quick-icon' && (scope === 'quick-icon-manual' || scope === 'quick-icon-auto')) {
    mediaByteCount(allocation.bytes, true);
    if (allocation.bytes !== mediaBytes || metadataBytes !== 0n || !validHash(allocation.contentSha256))
      mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    return [
      {
        part: 'quick-icon-bytea',
        policy: 'QUICK_LINK_BYTEA',
        chargedBytes: allocation.bytes,
        contentBindingSha256: allocation.contentSha256
      }
    ];
  }
  if (allocation.kind === 'avatar' && scope === 'avatar') {
    if (
      allocation.contentHashes &&
      (!validHash(allocation.contentHashes.full) || !validHash(allocation.contentHashes.small))
    )
      mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    mediaByteCount(allocation.fullBytes, true);
    mediaByteCount(allocation.smallBytes, true);
    if (metadataBytes !== 0n || allocation.fullBytes + allocation.smallBytes !== mediaBytes)
      mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    return [
      {
        part: 'avatar-full',
        policy: 'AVATAR_VARIANT',
        chargedBytes: allocation.fullBytes,
        contentBindingSha256: allocation.contentHashes?.full ?? null
      },
      {
        part: 'avatar-small',
        policy: 'AVATAR_VARIANT',
        chargedBytes: allocation.smallBytes,
        contentBindingSha256: allocation.contentHashes?.small ?? null
      }
    ];
  }
  if (allocation.kind === 'knowledge' && scope === 'knowledge') {
    if (allocation.preparedSha256 !== undefined && !validHash(allocation.preparedSha256))
      mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    mediaByteCount(allocation.mediaBytes, true);
    mediaByteCount(allocation.journalBytes, true);
    if (allocation.photo) {
      validatePhotoPayload(allocation.photo);
      if (
        allocation.photo.originalBytes + allocation.photo.previewBytes + allocation.photo.thumbnailBytes !==
        allocation.mediaBytes
      )
        mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    }
    if (allocation.mediaBytes !== mediaBytes || allocation.journalBytes !== metadataBytes)
      mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    return [
      ...(allocation.photo
        ? (['original', 'preview', 'thumbnail'] as const).map((variant) => ({
            part: 'photo-' + variant,
            policy: 'PHOTO_VARIANT',
            chargedBytes: allocation.photo![`${variant}Bytes`],
            contentBindingSha256: allocation.photo!.contentHashes[variant]
          }))
        : [{ part: 'knowledge-media', policy: 'AGGREGATE_NEVER', chargedBytes: mediaBytes }]),
      {
        part: 'knowledge-journal',
        policy: 'KNOWLEDGE_JOURNAL',
        chargedBytes: metadataBytes,
        contentBindingSha256: allocation.preparedSha256 ?? null
      }
    ];
  }
  mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
}
/** Internal: caller already owns global -> daily -> receipt, and has verified the original writer. */
export async function registerReceiptComponents(
  tx: MediaBudgetTx,
  row: MediaBudgetReceipt,
  parts: ComponentPart[],
  now: Date,
  create: boolean
) {
  if (!row.attemptId || !row.objectIdentity) mediaBudgetFail('MEDIA_BUDGET_NOT_WRITER');
  const found = await tx.$queryRaw<
    Component[]
  >`/*media-stock:receipt-components*/ SELECT * FROM "MediaStoredComponent" WHERE "receiptScope"=${row.scope} AND "receiptOperationKey"=${row.operationKey} ORDER BY part FOR UPDATE`;
  const expected = parts.map((part) => ({
    ...part,
    contentBindingSha256: part.contentBindingSha256 ?? null,
    storageIdentityFingerprint: null,
    id: hash(['media-component-v1', row.scope, row.objectIdentity, row.attemptId, part.part]),
    sourceKind: 'RECEIPT' as const,
    receiptScope: row.scope,
    receiptOperationKey: row.operationKey,
    baselineStateId: null,
    baselineFingerprint: null,
    namespace: row.scope,
    objectKey: row.objectIdentity!,
    generation: row.attemptId!,
    createdAt: now
  }));
  if (found.length) {
    if (found.length !== expected.length) mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    for (const wanted of expected) {
      const actual = found.find((item) => item.id === wanted.id);
      if (
        !actual ||
        Object.entries(wanted).some(
          ([key, value]) => key !== 'createdAt' && actual[key as keyof Component] !== value
        )
      )
        mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    }
    return;
  }
  // A pre57 allocated receipt is opaque: repeated allocate cannot adopt or split it retroactively.
  if (!create) {
    if (parts.some((part) => part.policy !== 'AGGREGATE_NEVER'))
      mediaBudgetFail('MEDIA_BUDGET_LEGACY_COMPONENT_REQUIRED');
    return;
  }
  for (const item of expected) {
    await tx.$executeRaw`/*media-stock:insert-component*/ INSERT INTO "MediaStoredComponent" (id,"sourceKind","receiptScope","receiptOperationKey","baselineStateId","baselineFingerprint",namespace,"objectKey",generation,part,policy,"chargedBytes","contentBindingSha256","createdAt") VALUES (${item.id},${item.sourceKind},${item.receiptScope},${item.receiptOperationKey},NULL,NULL,${item.namespace},${item.objectKey},${item.generation},${item.part},${item.policy},${item.chargedBytes},${item.contentBindingSha256},${now})`;
  }
}

/** New scalar baselines are explicitly opaque. No historical object scan/adoption is implied. */
export async function registerBaselineAggregate(
  tx: MediaBudgetTx,
  input: { bytes: bigint; fingerprint: string; now: Date }
) {
  if (input.bytes === 0n) return;
  const id = hash(['media-baseline-component-v1', input.fingerprint]);
  await tx.$executeRaw`/*media-stock:insert-baseline*/ INSERT INTO "MediaStoredComponent" (id,"sourceKind","baselineStateId","baselineFingerprint",namespace,"objectKey",generation,part,policy,"chargedBytes","createdAt") VALUES (${id},'BASELINE','global',${input.fingerprint},'baseline',${'baseline:' + input.fingerprint},${input.fingerprint},'aggregate','AGGREGATE_NEVER',${input.bytes},${input.now})`;
}

export type MediaBoundAllocationTicket = object & { readonly __mediaBoundAllocation: unique symbol };
export interface MediaBoundAllocationDescription {
  scope: string;
  operationKey: string;
  accountId: string | null;
  attemptId: string;
  objectIdentity: string;
  fingerprint: string;
  rawBytes: bigint;
  parts: { id: string; part: string; chargedBytes: bigint; contentBindingSha256: string | null }[];
}
const boundAllocations = new WeakMap<object, MediaBoundAllocationDescription>();
function validatePhotoPayload(allocation: Omit<PhotoComponentAllocation, 'kind' | 'scope'>) {
  for (const variant of ['original', 'preview', 'thumbnail'] as const) {
    mediaByteCount(allocation[`${variant}Bytes`], true);
    if (
      !allocation.contentHashes ||
      !validHash(allocation.contentHashes[variant]) ||
      allocation[`${variant}Bytes`] > (variant === 'original' ? 31457280n : 62914560n)
    )
      mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
  }
}
export function validateBoundAllocation(allocation: MediaBoundComponentAllocation) {
  if (!allocation || typeof allocation !== 'object') mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
  if (allocation.kind === 'photo') {
    if (
      allocation.scope !== 'daily' &&
      allocation.scope !== 'wish' &&
      allocation.scope !== 'lottery-image' &&
      allocation.scope !== 'album-comment' &&
      allocation.scope !== 'album-photo'
    )
      mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    validatePhotoPayload(allocation);
    return;
  }
  if (allocation.kind === 'official') {
    for (const variant of ['original', 'preview', 'thumbnail'] as const) {
      mediaByteCount(allocation[`${variant}Bytes`], true);
      if (!allocation.contentHashes || !validHash(allocation.contentHashes[variant]))
        mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    }
    if (
      allocation.originalBytes > 5242880n ||
      allocation.previewBytes > 62914560n ||
      allocation.thumbnailBytes > 62914560n
    )
      mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    return;
  }
  if (allocation.kind === 'avatar') {
    mediaByteCount(allocation.fullBytes, true);
    mediaByteCount(allocation.smallBytes, true);
    if (
      !allocation.contentHashes ||
      !validHash(allocation.contentHashes.full) ||
      !validHash(allocation.contentHashes.small)
    )
      mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    return;
  }
  if (allocation.kind === 'knowledge') {
    mediaByteCount(allocation.mediaBytes, true);
    mediaByteCount(allocation.journalBytes, true);
    if (!validHash(allocation.preparedSha256)) mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    if (allocation.photo) {
      validatePhotoPayload(allocation.photo);
      if (
        allocation.photo.originalBytes + allocation.photo.previewBytes + allocation.photo.thumbnailBytes !==
        allocation.mediaBytes
      )
        mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
    }
    return;
  }
  mediaBudgetFail('MEDIA_BUDGET_COMPONENT_CONFLICT');
}
/** Package-internal mint: only adapter owner calls this after allocation transaction resolves. */
export function sealBoundAllocation(
  row: {
    scope: string;
    operationKey: string;
    accountId: string | null;
    attemptId: string;
    objectIdentity: string;
    fingerprint: string;
    rawBytes: bigint;
  },
  allocation: MediaBoundComponentAllocation
): MediaBoundAllocationTicket {
  validateBoundAllocation(allocation);
  const media =
    allocation.kind === 'official' || allocation.kind === 'photo'
      ? allocation.originalBytes + allocation.previewBytes + allocation.thumbnailBytes
      : allocation.kind === 'avatar'
        ? allocation.fullBytes + allocation.smallBytes
        : allocation.mediaBytes;
  const metadata = allocation.kind === 'knowledge' ? allocation.journalBytes : 0n;
  const parts = quoteMediaComponents(row.scope, media, metadata, allocation).map((part) => ({
    id: hash(['media-component-v1', row.scope, row.objectIdentity, row.attemptId, part.part]),
    part: part.part,
    chargedBytes: part.chargedBytes,
    contentBindingSha256: part.contentBindingSha256 ?? null
  }));
  const ticket = Object.freeze({}) as MediaBoundAllocationTicket;
  boundAllocations.set(ticket, { ...row, parts });
  return ticket;
}
/** Public verifier only: JSON/casts cannot create an owner allocation capability. */
export function verifiedBoundAllocation(ticket: object): MediaBoundAllocationDescription | null {
  const value = boundAllocations.get(ticket);
  return value ? { ...value, parts: value.parts.map((part) => ({ ...part })) } : null;
}
