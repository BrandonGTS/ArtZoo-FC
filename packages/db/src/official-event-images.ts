import { isMemberId } from '@artzoo/domain';
import type { Prisma } from './generated/prisma/client.js';
import type { OfficialLiveCandidate, OfficialUnusedBatch } from './official-media-contract.js';
import { guardOfficialCandidateAttachmentTx } from './official-media-retirement.js';
export interface OfficialImageSource {
  url: string;
  pageUrl: string;
  kind: 'API' | 'NEWS' | 'TOPIC_METADATA' | 'TOPIC_SECTION' | 'MANUAL';
}
export interface OfficialPreparedImage {
  id: string;
  sourceUrl: string;
  sourcePageUrl: string;
  sourceKind: OfficialImageSource['kind'];
  fingerprint: string;
  mime: string;
  width: number;
  height: number;
  frames: number;
  originalBytes: number;
  /** Private DB-origin capability; stage defines this nonenumerably. Never a public image DTO. */
  readonly stockCandidate?: OfficialLiveCandidate;
}
export interface OfficialImagePorts {
  stage(source: OfficialImageSource, options?: { signal?: AbortSignal }): Promise<OfficialPreparedImage>;
  discard(id: string): Promise<void>;
  discardUnused?(batch: OfficialUnusedBatch): Promise<void>;
}
/** Metadata is inserted only in the owning event transaction; prior versions are retained. */
export async function attachOfficialEventImageTx(
  tx: Prisma.TransactionClient,
  eventId: string,
  image: OfficialPreparedImage,
  now = new Date()
): Promise<string> {
  if (
    !isMemberId(image.id) ||
    !/^[a-f0-9]{64}$/.test(image.fingerprint) ||
    image.originalBytes < 1 ||
    image.originalBytes > 5242880
  )
    throw new Error('Invalid official image receipt');
  await guardOfficialCandidateAttachmentTx(tx, image.id);
  const [existing] = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "OfficialEventImage" WHERE "eventId"=${eventId} AND fingerprint=${image.fingerprint} AND "sourceUrl"=${image.sourceUrl}`;
  if (existing) return existing.id;
  await tx.$executeRaw`INSERT INTO "OfficialEventImage" (id,"eventId","sourceUrl","sourcePageUrl","sourceKind",fingerprint,mime,width,height,frames,"originalBytes","createdAt")
 VALUES (${image.id},${eventId},${image.sourceUrl},${image.sourcePageUrl},${image.sourceKind},${image.fingerprint},${image.mime},${image.width},${image.height},${image.frames},${image.originalBytes},${now})`;
  return image.id;
}
