import { createHash } from 'node:crypto';
import { isMemberId, mediaBudgetDay, mediaBudgetFail } from '@artzoo/domain';
import type { Prisma, PrismaClient } from './generated/prisma/client.js';
import type { MediaBudgetReceipt } from './media-budget.js';
import { verifiedBoundAllocation, type MediaBoundAllocationTicket } from './media-stock-components.js';
import type {
  OfficialLiveCandidate,
  OfficialUnusedBatch,
  OfficialCandidateDescription,
  OfficialUnusedDescription,
  OfficialStockComponent
} from './official-media-contract.js';

type Tx = Prisma.TransactionClient;
type Component = OfficialStockComponent & {
  sourceKind: string;
  receiptScope: string;
  receiptOperationKey: string;
  namespace: string;
  objectKey: string;
  policy: string;
  createdAt: Date;
};
type Intent = OfficialUnusedDescription['candidates'][number]['intents'][number];
const live = new WeakMap<object, OfficialCandidateDescription>();
const unused = new WeakMap<object, OfficialUnusedDescription>();
const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const parts = ['official-original', 'official-preview', 'official-thumbnail'] as const;
function transaction(tx: Tx) {
  if (
    typeof (tx as { $connect?: unknown }).$connect === 'function' ||
    typeof (tx as { $disconnect?: unknown }).$disconnect === 'function'
  )
    mediaBudgetFail('MEDIA_BUDGET_TRANSACTION_REQUIRED');
}
function copyCandidate(value: OfficialCandidateDescription): OfficialCandidateDescription {
  return { ...value, components: value.components.map((component) => ({ ...component })) };
}
export function verifiedOfficialLiveCandidate(candidate: unknown): OfficialCandidateDescription | null {
  const value = candidate && typeof candidate === 'object' ? live.get(candidate) : undefined;
  return value ? copyCandidate(value) : null;
}
export function verifiedOfficialUnusedBatch(batch: unknown): OfficialUnusedDescription | null {
  const value = batch && typeof batch === 'object' ? unused.get(batch) : undefined;
  return value
    ? {
        candidates: value.candidates.map((candidate) => ({
          ...copyCandidate(candidate),
          intents: candidate.intents.map((intent) => ({ ...intent, createdAt: new Date(intent.createdAt) }))
        }))
      }
    : null;
}
async function lockCandidate(tx: Tx, id: string) {
  transaction(tx);
  if (!isMemberId(id)) mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  await tx.$queryRaw`/*official-stock:candidate-lock*/ SELECT pg_advisory_xact_lock(hashtextextended(${'official-media-candidate:' + id.toLowerCase()},0))::text`;
}
/** Every writer, including budget OFF, participates in the same permanent attachment fence. */
export async function guardOfficialCandidateAttachmentTx(tx: Tx, id: string): Promise<void> {
  await lockCandidate(tx, id);
  const [fenced] = await tx.$queryRaw<
    { found: boolean }[]
  >`/*official-stock:attach-fence*/ SELECT EXISTS(SELECT 1 FROM "MediaRetirementIntent" i JOIN "MediaStoredComponent" c ON c.id=i."componentId" WHERE c.namespace='official-image' AND lower(c."objectKey")=${'official:' + id.toLowerCase()}) AS found`;
  if (!fenced || fenced.found) mediaBudgetFail('MEDIA_BOUND_CANDIDATE_RETIRED');
}
async function validateCandidate(tx: Tx, candidate: OfficialCandidateDescription) {
  transaction(tx);
  const [receipt] = await tx.$queryRaw<
    MediaBudgetReceipt[]
  >`/*official-stock:receipt*/ SELECT * FROM "MediaUploadReceipt" WHERE scope='official-image' AND "operationKey"=${candidate.operationKey}`;
  const rows = await tx.$queryRaw<
    Component[]
  >`/*official-stock:components*/ SELECT * FROM "MediaStoredComponent" WHERE "receiptScope"='official-image' AND "receiptOperationKey"=${candidate.operationKey} ORDER BY part`;
  if (
    !receipt ||
    receipt.state !== 'COMMITTED' ||
    receipt.accountId !== null ||
    receipt.attemptId !== candidate.generation ||
    receipt.objectIdentity !== 'official:' + candidate.id ||
    receipt.fingerprint !== candidate.fingerprint ||
    !receipt.persistenceStartedAt ||
    !receipt.settledAt ||
    rows.length !== 3 ||
    candidate.components.length !== 3 ||
    new Set(rows.map((row) => row.part)).size !== 3
  )
    mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  for (const part of parts) {
    const row = rows.find((row) => row.part === part),
      expected = candidate.components.find((row) => row.part === part);
    if (
      !row ||
      !expected ||
      row.id !== expected.id ||
      row.sourceKind !== 'RECEIPT' ||
      row.namespace !== 'official-image' ||
      row.policy !== 'OFFICIAL_VARIANT' ||
      row.objectKey !== 'official:' + candidate.id ||
      row.generation !== candidate.generation ||
      row.chargedBytes !== expected.chargedBytes ||
      row.chargedBytes <= 0n ||
      row.contentBindingSha256 !== expected.contentBindingSha256 ||
      !digest(row.contentBindingSha256) ||
      !digest(row.storageIdentityFingerprint) ||
      (expected.storageIdentityFingerprint &&
        row.storageIdentityFingerprint !== expected.storageIdentityFingerprint)
    )
      mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
  }
  if (rows.reduce((sum, row) => sum + row.chargedBytes, 0n) !== receipt.storedBytes)
    mediaBudgetFail('MEDIA_BUDGET_STATE_MISMATCH');
  return rows;
}
/** Root client only at runtime ($connect/$disconnect): genuine ticket + committed binding + independent short TX ACK mint live authority. */
export async function confirmOfficialCandidate(
  db: Pick<PrismaClient, '$transaction'>,
  allocation: MediaBoundAllocationTicket
): Promise<OfficialLiveCandidate> {
  // Prisma 7 itx can expose nested $transaction; only root lifecycle methods distinguish an independent client.
  if (
    typeof (db as { $connect?: unknown }).$connect !== 'function' ||
    typeof (db as { $disconnect?: unknown }).$disconnect !== 'function'
  )
    mediaBudgetFail('MEDIA_BUDGET_ROOT_CLIENT_REQUIRED');
  const owner = verifiedBoundAllocation(allocation);
  if (
    !owner ||
    owner.scope !== 'official-image' ||
    owner.accountId !== null ||
    !owner.objectIdentity.startsWith('official:') ||
    owner.parts.length !== 3 ||
    owner.parts.some((part) => !digest(part.contentBindingSha256))
  )
    mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  const candidate: OfficialCandidateDescription = {
    id: owner.objectIdentity.slice('official:'.length),
    operationKey: owner.operationKey,
    generation: owner.attemptId,
    fingerprint: owner.fingerprint,
    components: owner.parts.map((part) => ({
      ...part,
      part: part.part as OfficialStockComponent['part'],
      generation: owner.attemptId,
      contentBindingSha256: part.contentBindingSha256!,
      storageIdentityFingerprint: ''
    }))
  };
  if (!isMemberId(candidate.id) || candidate.id !== candidate.id.toLowerCase())
    mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
  const validated = await db.$transaction(async (tx) => {
    const rows = await validateCandidate(tx, candidate);
    return rows.map((row) => ({
      id: row.id,
      part: row.part,
      generation: row.generation,
      chargedBytes: row.chargedBytes,
      contentBindingSha256: row.contentBindingSha256,
      storageIdentityFingerprint: row.storageIdentityFingerprint
    }));
  });
  const cap = Object.freeze({}) as OfficialLiveCandidate;
  live.set(cap, { ...candidate, components: validated });
  return cap;
}
/** Called only at the original business TX tail. Historical references always keep the asset. */
export async function prepareOfficialUnusedBatchTx(
  tx: Tx,
  candidates: readonly OfficialLiveCandidate[],
  now: Date
): Promise<OfficialUnusedBatch | null> {
  transaction(tx);
  mediaBudgetDay(now);
  const descriptions: OfficialCandidateDescription[] = [];
  for (const cap of candidates) {
    const candidate = live.get(cap);
    if (!candidate) mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
    if (!descriptions.some((item) => item.id === candidate.id)) descriptions.push(candidate);
  }
  descriptions.sort((a, b) => a.id.localeCompare(b.id));
  for (const candidate of descriptions) await lockCandidate(tx, candidate.id);
  const eligible: { candidate: OfficialCandidateDescription; rows: Component[] }[] = [];
  for (const candidate of descriptions) {
    const [reference] = await tx.$queryRaw<
      { found: boolean }[]
    >`/*official-stock:references*/ SELECT (EXISTS(SELECT 1 FROM "OfficialEventImage" WHERE lower(id)=${candidate.id}) OR EXISTS(SELECT 1 FROM "OfficialEvent" WHERE lower("imageId")=${candidate.id})) AS found`;
    if (!reference) mediaBudgetFail('MEDIA_BOUND_BUSINESS_REQUIRED');
    if (reference.found) continue;
    const rows = await validateCandidate(tx, candidate);
    if (rows.some((row) => now < row.createdAt)) mediaBudgetFail('MEDIA_BUDGET_INVALID_TIME');
    eligible.push({ candidate, rows });
  }
  if (!eligible.length) return null;
  // Candidate locks precede global; no further event/business locks are acquired below.
  const [global] = await tx.$queryRaw<
    { id: string }[]
  >`/*official-stock:global*/ SELECT id FROM "MediaBudgetState" WHERE id='global' FOR UPDATE`;
  if (!global) mediaBudgetFail('MEDIA_BUDGET_STATE_MISSING');
  const result: OfficialUnusedDescription['candidates'][number][] = [];
  for (const { candidate, rows } of eligible) {
    const authorityFingerprint = hash([
      'official-unused-v1',
      candidate.id,
      candidate.generation,
      candidate.fingerprint
    ]);
    const intents: Intent[] = [];
    for (const row of rows) {
      const [old] = await tx.$queryRaw<
        Intent[]
      >`/*media-stock:intent*/ SELECT * FROM "MediaRetirementIntent" WHERE "componentId"=${row.id} FOR UPDATE`;
      if (old) {
        if (
          old.identityFingerprint !== row.storageIdentityFingerprint ||
          old.authorityFingerprint !== authorityFingerprint
        )
          mediaBudgetFail('MEDIA_BUDGET_RETIREMENT_CONFLICT');
        intents.push({
          id: old.id,
          componentId: old.componentId,
          identityFingerprint: old.identityFingerprint,
          authorityFingerprint: old.authorityFingerprint,
          createdAt: new Date(old.createdAt)
        });
      } else {
        const intent: Intent = {
          id: hash(['media-retirement-v1', row.id, row.storageIdentityFingerprint, authorityFingerprint]),
          componentId: row.id,
          identityFingerprint: row.storageIdentityFingerprint,
          authorityFingerprint,
          createdAt: new Date(now)
        };
        await tx.$executeRaw`/*media-stock:insert-intent*/ INSERT INTO "MediaRetirementIntent" (id,"componentId","identityFingerprint","authorityFingerprint",state,"createdAt") VALUES (${intent.id},${intent.componentId},${intent.identityFingerprint},${intent.authorityFingerprint},'PREPARED',${now})`;
        intents.push(intent);
      }
    }
    result.push({ ...copyCandidate(candidate), intents });
  }
  const cap = Object.freeze({}) as OfficialUnusedBatch;
  unused.set(cap, { candidates: result });
  return cap;
}
