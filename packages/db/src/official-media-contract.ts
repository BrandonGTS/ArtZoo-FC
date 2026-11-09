import type { Prisma, PrismaClient } from './generated/prisma/client.js';
import type { MediaBoundAllocationTicket } from './media-stock-components.js';

declare const liveBrand: unique symbol;
declare const unusedBrand: unique symbol;
/** DB-private origin. A JSON DTO, XID, boolean or callback cannot implement it. */
export type OfficialLiveCandidate = object & { readonly [liveBrand]: never };
export type OfficialUnusedBatch = object & { readonly [unusedBrand]: never };
export interface OfficialStockComponent {
  id: string;
  part: 'official-original' | 'official-preview' | 'official-thumbnail';
  generation: string;
  chargedBytes: bigint;
  contentBindingSha256: string;
  storageIdentityFingerprint: string;
}
export interface OfficialCandidateDescription {
  id: string;
  operationKey: string;
  generation: string;
  fingerprint: string;
  components: readonly OfficialStockComponent[];
}
export interface OfficialUnusedDescription {
  candidates: readonly (OfficialCandidateDescription & {
    intents: readonly {
      id: string;
      componentId: string;
      identityFingerprint: string;
      authorityFingerprint: string;
      createdAt: Date;
    }[];
  })[];
}
/** Pure interface only: there is no successful runtime stub in this module. */
export interface OfficialStockPort {
  confirmOfficialCandidate(
    db: Pick<PrismaClient, '$transaction'>,
    allocation: MediaBoundAllocationTicket
  ): Promise<OfficialLiveCandidate>;
  prepareOfficialUnusedBatchTx(
    tx: Prisma.TransactionClient,
    candidates: readonly OfficialLiveCandidate[],
    now: Date
  ): Promise<OfficialUnusedBatch | null>;
  guardOfficialCandidateAttachmentTx(tx: Prisma.TransactionClient, id: string): Promise<void>;
  verifiedOfficialLiveCandidate(candidate: unknown): OfficialCandidateDescription | null;
  verifiedOfficialUnusedBatch(batch: unknown): OfficialUnusedDescription | null;
}
