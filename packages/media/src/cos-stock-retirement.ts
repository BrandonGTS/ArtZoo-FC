import { verifiedCosRemoval } from './cos-object-storage.js';
import { verifiedBoundRemoval, type BoundDescription } from './stock-bound-io.js';

/** No caller description, cast, persisted intent or 404 can manufacture physical removal evidence. */
export function verifiedMediaRemoval(proof: object): BoundDescription | null {
  const local = verifiedBoundRemoval(proof);
  if (local) return local;
  const remote = verifiedCosRemoval(proof);
  if (!remote) return null;
  const kinds = {
    avatars: 'avatar',
    daily: 'daily',
    wishes: 'wish',
    lottery: 'lottery-image',
    knowledge: 'knowledge',
    'album-comments': 'album-comment',
    official: 'official',
    albums: 'album-photo'
  } as const;
  if (!Object.hasOwn(kinds, remote.scope)) return null;
  const kind = kinds[remote.scope as keyof typeof kinds];
  const prefix = kind === 'avatar' ? 'avatar-' : kind === 'official' ? 'official-' : 'photo-';
  const part = prefix + remote.part;
  const valid =
    kind === 'avatar'
      ? ['avatar-full', 'avatar-small']
      : kind === 'official'
        ? ['official-original', 'official-preview', 'official-thumbnail']
        : ['photo-original', 'photo-preview', 'photo-thumbnail'];
  if (!valid.includes(part)) return null;
  return {
    kind,
    objectId: remote.objectId,
    part: part as BoundDescription['part'],
    contentHash: remote.sha256,
    bytes: BigInt(remote.bytes),
    physicalFingerprint: remote.fingerprint
  };
}
