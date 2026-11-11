import type { Prisma } from '@artzoo/db';
import { mediaBudgetFail } from '@artzoo/domain';
import { verifiedBoundWrite, type BoundWriteProof, type BoundDescription } from './stock-bound-io.js';

export type MediaWriteProof = BoundWriteProof;
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
/** Write-only bridge. No removal registry, retirement authority, or credit capability is extended. */
export async function verifiedMediaWrite(
  _tx: Prisma.TransactionClient,
  proof: MediaWriteProof,
  scope: Scope,
  _accountId: string | null,
  objectId: string
): Promise<BoundDescription | null> {
  void _tx;
  void _accountId;
  const local = verifiedBoundWrite(proof);
  if (!local) return null;
  const kind = scope === 'official-image' ? 'official' : scope;
  if (local.kind !== kind || local.objectId !== objectId.toLowerCase())
    mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
  if (local.part === 'knowledge-journal' && scope !== 'knowledge')
    mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
  return local;
}
