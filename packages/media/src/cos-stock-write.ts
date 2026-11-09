import type { Prisma } from '@artzoo/db';
import { mediaBudgetFail } from '@artzoo/domain';
import { verifiedBoundWrite, type BoundWriteProof, type BoundDescription } from './stock-bound-io.js';
import { verifiedCosWrite, type CosWriteProof } from './cos-object-storage.js';

export type MediaWriteProof = BoundWriteProof | CosWriteProof;
export interface MediaWriteNamespace {
  capture(
    id: string,
    part: BoundDescription['part'],
    sha256: string,
    bytes: bigint
  ): Promise<MediaWriteProof>;
}
type Scope =
  | 'avatar'
  | 'knowledge'
  | 'official-image'
  | 'daily'
  | 'wish'
  | 'lottery-image'
  | 'album-comment'
  | 'album-photo';
const scopes = {
  avatar: 'avatars',
  knowledge: 'knowledge',
  'official-image': 'official',
  daily: 'daily',
  wish: 'wishes',
  'lottery-image': 'lottery',
  'album-comment': 'album-comments',
  'album-photo': 'albums'
} as const;
/** Write-only bridge. No removal registry, retirement authority, or credit capability is extended. */
export async function verifiedMediaWrite(
  tx: Prisma.TransactionClient,
  proof: MediaWriteProof,
  scope: Scope,
  accountId: string | null,
  objectId: string
): Promise<BoundDescription | null> {
  const local = verifiedBoundWrite(proof);
  if (local) {
    const kind = scope === 'official-image' ? 'official' : scope;
    if (local.kind !== kind || local.objectId !== objectId.toLowerCase())
      mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
    // The recovery journal deliberately remains local while its three images may be COS.
    if (local.part === 'knowledge-journal') {
      if (scope !== 'knowledge') mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
      return local;
    }
    // A genuine local shadow is not evidence for an object whose immutable backend is COS.
    // Any reservation pins all parts, even if a remote upload never finished.
    const { findCosObjects } = await import('@artzoo/db');
    if (
      (
        await findCosObjects(tx, {
          scope: scopes[scope],
          objectId: objectId.toLowerCase(),
          accountId: scope === 'lottery-image' ? (accountId?.toLowerCase() ?? null) : null
        })
      ).length
    )
      mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
    return local;
  }
  const remote = verifiedCosWrite(proof);
  if (!remote) return null;
  if (
    remote.scope !== scopes[scope] ||
    remote.objectId !== objectId.toLowerCase() ||
    (scope === 'lottery-image' ? remote.accountId !== accountId?.toLowerCase() : remote.accountId !== null)
  )
    mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
  const prefix = scope === 'avatar' ? 'avatar-' : scope === 'official-image' ? 'official-' : 'photo-';
  const part = (prefix + remote.part) as BoundDescription['part'];
  const valid =
    scope === 'avatar'
      ? ['avatar-full', 'avatar-small']
      : scope === 'official-image'
        ? ['official-original', 'official-preview', 'official-thumbnail']
        : ['photo-original', 'photo-preview', 'photo-thumbnail'];
  if (!valid.includes(part)) mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
  // The exact immutable locator must still exist in the committing business transaction.
  const { findCosObject } = await import('@artzoo/db');
  const location = await findCosObject(tx, {
    scope: remote.scope,
    objectId: remote.objectId,
    part: remote.part,
    accountId: remote.accountId
  });
  if (
    !location ||
    location.bucket !== remote.bucket ||
    location.region !== remote.region ||
    location.objectKey !== remote.key ||
    location.bytes !== BigInt(remote.bytes) ||
    location.sha256 !== remote.sha256 ||
    location.etag !== remote.etag ||
    location.identityFingerprint !== remote.fingerprint
  )
    mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
  return {
    kind: scope === 'avatar' ? 'avatar' : scope === 'official-image' ? 'official' : scope,
    objectId,
    part,
    contentHash: remote.sha256,
    bytes: BigInt(remote.bytes),
    physicalFingerprint: remote.fingerprint
  };
}
