import { createHash, randomUUID } from 'node:crypto';
import { isMemberId, mediaBudgetFail, mediaBudgetDay, type MediaBudgetPolicy } from '@artzoo/domain';
import type { Prisma } from './generated/prisma/client.js';
import type {
  QuickIconMutationPlan,
  QuickIconMutationCaptureInput,
  QuickIconSettlementInput
} from './media-quick-icon-contract.js';
import {
  reserveRawMediaBudget,
  allocateMediaStorage,
  beginMediaPersistence,
  commitMediaBudget,
  type MediaBudgetReceipt
} from './media-budget.js';

type Tx = Prisma.TransactionClient;
type IconRow = {
  id: string;
  revision: number;
  iconBytes: Uint8Array | null;
  iconVersion: string | null;
  iconBudgetComponentId: string | null;
  iconSource: string;
  iconBudgetMutationXid: string | null;
};
type Capture = { tx: Tx; input: QuickIconMutationCaptureInput; before: IconRow };
type Component = {
  id: string;
  sourceKind: string;
  receiptScope: string | null;
  receiptOperationKey: string | null;
  namespace: string;
  objectKey: string;
  generation: string;
  part: string;
  policy: string;
  chargedBytes: bigint;
  contentBindingSha256: string | null;
  storageIdentityFingerprint: string | null;
};
type Intent = {
  id: string;
  componentId: string;
  identityFingerprint: string;
  authorityFingerprint: string;
  state: string;
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
const captures = new WeakMap<QuickIconMutationPlan, Capture>();
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const hash = (parts: unknown[]) =>
  sha(JSON.stringify(parts, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const validHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeRevision = (value: number) => Number.isSafeInteger(value) && value >= 0 && value < 2147483647;
function fail(): never {
  return mediaBudgetFail('MEDIA_BUDGET_QUICK_ICON_STATE');
}
function requireTransaction(tx: Tx) {
  if (
    typeof (tx as { $connect?: unknown }).$connect === 'function' ||
    typeof (tx as { $disconnect?: unknown }).$disconnect === 'function'
  )
    mediaBudgetFail('MEDIA_BUDGET_TRANSACTION_REQUIRED');
}
function identity(input: { actorId: string; key: string; fingerprint: string; id: string }) {
  if (
    !isMemberId(input.actorId) ||
    !isMemberId(input.id) ||
    !validHash(input.fingerprint) ||
    typeof input.key !== 'string' ||
    input.key.length < 1 ||
    input.key.length > 128
  )
    fail();
}
const select = {
  id: true,
  revision: true,
  iconBytes: true,
  iconVersion: true,
  iconBudgetComponentId: true,
  iconSource: true,
  iconBudgetMutationXid: true
} as const;
/** Capture a real catalog-locked original row, without taking budget/receipt locks early. */
export async function captureQuickIconMutationTx(
  tx: Tx,
  input: QuickIconMutationCaptureInput
): Promise<QuickIconMutationPlan | null> {
  requireTransaction(tx);
  identity(input);
  if (
    !['update', 'remove'].includes(input.kind) ||
    !safeRevision(input.linkRevision) ||
    !safeRevision(input.catalogRevision)
  )
    fail();
  const row = await tx.resourceLink.findUnique({ where: { id: input.id }, select }),
    state = await tx.quickLinkState.findUnique({ where: { id: 'global' }, select: { revision: true } });
  if (!row || row.revision !== input.linkRevision || state?.revision !== input.catalogRevision) fail();
  // Existing unaccounted/baseline/legacy bytes are never adopted by this operation.
  if (row.iconBudgetComponentId === null) return null;
  if (
    !row.iconBytes ||
    !validHash(row.iconVersion) ||
    !validHash(row.iconBudgetComponentId) ||
    row.iconBytes.length < 1 ||
    row.iconBytes.length > 65536 ||
    sha(row.iconBytes) !== row.iconVersion
  )
    fail();
  const plan = Object.freeze({}) as QuickIconMutationPlan;
  captures.set(plan, {
    tx,
    input: { ...input },
    before: { ...row, iconBytes: Uint8Array.from(row.iconBytes) }
  });
  return plan;
}
async function globalLock(tx: Tx) {
  const [global] = await tx.$queryRaw<
    {
      baselineBytes: bigint;
      committedBytes: bigint;
      reservedBytes: bigint;
      creditedBytes: bigint;
      baselineInitializedAt: Date | null;
    }[]
  >`
    /*media-stock:global*/ SELECT * FROM "MediaBudgetState" WHERE id='global' FOR UPDATE`;
  if (!global || !global.baselineInitializedAt) mediaBudgetFail('MEDIA_BUDGET_BASELINE_REQUIRED');
  for (const n of [global.baselineBytes, global.committedBytes, global.reservedBytes, global.creditedBytes])
    if (typeof n !== 'bigint' || n < 0n) fail();
  if (global.creditedBytes > global.baselineBytes + global.committedBytes) fail();
  return global;
}
async function currentCommand(tx: Tx, input: QuickIconSettlementInput, prior: Capture | undefined) {
  const command = await tx.quickLinkCommand.findUnique({
      where: { actorId_idempotencyKey: { actorId: input.actorId, idempotencyKey: input.key } }
    }),
    state = await tx.quickLinkState.findUnique({ where: { id: 'global' }, select: { revision: true } }),
    row = await tx.resourceLink.findUnique({ where: { id: input.id }, select });
  if (
    !command ||
    command.requestFingerprint !== input.fingerprint ||
    !command.result ||
    typeof command.result !== 'object' ||
    Array.isArray(command.result)
  )
    fail();
  const result = command.result as Record<string, unknown>;
  if (result.id !== input.id || !Number.isSafeInteger(result.revision) || state?.revision !== result.revision)
    fail();
  if (prior) {
    const old = prior.input;
    if (command.kind !== old.kind || result.revision !== old.catalogRevision + 1) fail();
    if (old.kind === 'remove') {
      if (row !== null) fail();
    } else if (
      !row ||
      !safeRevision(row.revision) ||
      row.revision <= old.linkRevision ||
      row.iconBudgetComponentId !== null
    )
      fail();
  } else if ('kind' in input) {
    // No captured old binding means no credit and no new allocation is needed.
    if (command.kind !== 'remove' && command.kind !== 'update') fail();
  }
  if (!('kind' in input)) {
    // The actual PostgreSQL transaction stamp is assigned only by the icon-write trigger.
    // A matching name-only command/hash cannot adopt old NULL or previous-TX bytes.
    const [transaction] = await tx.$queryRaw<
      { xid: string }[]
    >`/*media-quick-icon:xid*/ SELECT pg_current_xact_id()::text AS xid`;
    if (
      !transaction ||
      !/^[0-9]{1,20}$/.test(transaction.xid) ||
      row?.iconBudgetMutationXid !== transaction.xid
    )
      fail();
    if (
      !['create', 'update'].includes(command.kind) ||
      !row ||
      !row.iconBytes ||
      row.iconBytes.length !== input.storedBytes ||
      row.iconVersion !== input.version ||
      sha(row.iconBytes) !== input.version ||
      row.iconSource !== (input.manual ? 'manual' : 'auto') ||
      row.iconBudgetComponentId !== null
    )
      fail();
  } else if (row !== null && (row.iconBytes !== null || row.iconVersion !== null)) fail();
  return { command, result, row };
}
async function retireCaptured(
  tx: Tx,
  capture: Capture,
  input: QuickIconSettlementInput,
  revision: number,
  now: Date
) {
  const old = capture.before;
  const [candidate] = await tx.$queryRaw<
    Component[]
  >`/*media-stock:component*/ SELECT * FROM "MediaStoredComponent" WHERE id=${old.iconBudgetComponentId}`;
  if (
    !candidate ||
    candidate.sourceKind !== 'RECEIPT' ||
    candidate.policy !== 'QUICK_LINK_BYTEA' ||
    candidate.part !== 'quick-icon-bytea' ||
    !['quick-icon-manual', 'quick-icon-auto'].includes(candidate.namespace) ||
    candidate.receiptScope !== candidate.namespace ||
    !candidate.receiptOperationKey ||
    candidate.chargedBytes !== BigInt(old.iconBytes!.length) ||
    candidate.contentBindingSha256 !== old.iconVersion ||
    candidate.storageIdentityFingerprint !== null
  )
    mediaBudgetFail('MEDIA_BUDGET_COMPONENT_NOT_RETIRABLE');
  const [receipt] = await tx.$queryRaw<
    MediaBudgetReceipt[]
  >`/*media-stock:source-receipt*/ SELECT * FROM "MediaUploadReceipt" WHERE scope=${candidate.receiptScope} AND "operationKey"=${candidate.receiptOperationKey} FOR UPDATE`;
  const [component] = await tx.$queryRaw<
    Component[]
  >`/*media-stock:component-lock*/ SELECT * FROM "MediaStoredComponent" WHERE id=${candidate.id} FOR UPDATE`;
  if (
    !receipt ||
    !component ||
    receipt.state !== 'COMMITTED' ||
    !receipt.persistenceStartedAt ||
    !receipt.settledAt ||
    receipt.attemptId !== component.generation ||
    receipt.objectIdentity !== component.objectKey ||
    receipt.storedBytes !== component.chargedBytes ||
    receipt.metadataReservedBytes !== 0n ||
    component.objectKey !== `quick-icon:${old.id}:${old.iconVersion}:${component.generation}` ||
    (receipt.scope === 'quick-icon-manual'
      ? typeof receipt.accountId !== 'string' || !isMemberId(receipt.accountId)
      : receipt.accountId !== null) ||
    now.getTime() < receipt.settledAt.getTime() ||
    hash([component]) !== hash([candidate])
  )
    fail();
  const identityFingerprint = hash([
      'quick-icon-bytea-v1',
      old.id,
      old.iconVersion,
      old.iconBytes!.length,
      component.generation
    ]),
    authorityFingerprint = hash([
      'quick-icon-command-v1',
      input.actorId,
      input.key,
      input.fingerprint,
      old.id,
      capture.input.kind,
      capture.input.linkRevision,
      capture.input.catalogRevision,
      revision
    ]),
    intentId = hash(['quick-icon-retirement-v1', component.id, component.generation]),
    evidenceFingerprint = hash(['atomic-bytea-replacement-v1', identityFingerprint, authorityFingerprint]);
  const [existingIntent] = await tx.$queryRaw<
    Intent[]
  >`/*media-stock:intent*/ SELECT * FROM "MediaRetirementIntent" WHERE "componentId"=${component.id} FOR UPDATE`;
  if (
    existingIntent &&
    (existingIntent.id !== intentId ||
      existingIntent.identityFingerprint !== identityFingerprint ||
      existingIntent.authorityFingerprint !== authorityFingerprint)
  )
    fail();
  const [existingCredit] = await tx.$queryRaw<
    Credit[]
  >`/*media-stock:credit*/ SELECT * FROM "MediaStorageCredit" WHERE "componentId"=${component.id}`;
  if (existingCredit) {
    if (
      existingCredit.intentId !== intentId ||
      existingCredit.bytes !== component.chargedBytes ||
      existingCredit.evidenceFingerprint !== evidenceFingerprint ||
      existingIntent?.state !== 'ACKNOWLEDGED'
    )
      fail();
    return;
  }
  if (existingIntent?.state === 'ACKNOWLEDGED') fail();
  if (!existingIntent)
    await tx.$executeRaw`/*media-stock:insert-intent*/ INSERT INTO "MediaRetirementIntent" (id,"componentId","identityFingerprint","authorityFingerprint",state,"createdAt") VALUES (${intentId},${component.id},${identityFingerprint},${authorityFingerprint},'PREPARED',${now})`;
  await tx.$executeRaw`/*media-stock:insert-credit*/ INSERT INTO "MediaStorageCredit" ("componentId","intentId",bytes,"evidenceFingerprint","createdAt") VALUES (${component.id},${intentId},${component.chargedBytes},${evidenceFingerprint},${now})`;
  const global = await globalLock(tx),
    credited = global.creditedBytes + component.chargedBytes;
  if (credited > global.baselineBytes + global.committedBytes) fail();
  await tx.$executeRaw`/*media-stock:save-credit*/ UPDATE "MediaBudgetState" SET "creditedBytes"=${credited} WHERE id='global'`;
  await tx.$executeRaw`/*media-stock:ack-intent*/ UPDATE "MediaRetirementIntent" SET state='ACKNOWLEDGED',"acknowledgedAt"=${now} WHERE id=${intentId}`;
}
/** BYTEA removal, its command, credit and optional replacement allocation are one original TX.
 * No filesystem proof/JSON acknowledgement is accepted and no daily charge is ever refunded.
 */
export async function settleQuickIconMutationTx(
  tx: Tx,
  input: QuickIconSettlementInput,
  policy: MediaBudgetPolicy,
  clock: () => Date,
  prior?: QuickIconMutationPlan | null
): Promise<void> {
  if (!policy.enabled) return;
  requireTransaction(tx);
  identity(input);
  const capture = prior ? captures.get(prior) : undefined;
  if (
    prior &&
    (!capture ||
      capture.tx !== tx ||
      ['actorId', 'key', 'fingerprint', 'id'].some(
        (k) => capture.input[k as keyof QuickIconMutationCaptureInput] !== input[k as keyof typeof input]
      ))
  )
    mediaBudgetFail('MEDIA_BUDGET_QUICK_ICON_CAPABILITY_REQUIRED');
  const now = clock();
  mediaBudgetDay(now);
  if (
    !('kind' in input) &&
    (typeof input.manual !== 'boolean' ||
      !validHash(input.version) ||
      !Number.isSafeInteger(input.rawBytes) ||
      input.rawBytes < 1 ||
      !Number.isSafeInteger(input.storedBytes) ||
      input.storedBytes < 1 ||
      input.storedBytes > 65536)
  )
    fail();
  const actual = await currentCommand(tx, input, capture);
  await globalLock(tx);
  if (capture) await retireCaptured(tx, capture, input, actual.result.revision as number, now);
  if ('kind' in input) return;
  const attemptId = randomUUID(),
    writer = {
      scope: input.manual ? 'quick-icon-manual' : 'quick-icon-auto',
      operationKey: input.actorId + ':' + input.key,
      fingerprint: input.fingerprint,
      accountId: input.manual ? input.actorId : null,
      rawBytes: BigInt(input.rawBytes),
      storedBytes: BigInt(input.storedBytes),
      attemptId,
      objectIdentity: `quick-icon:${input.id}:${input.version}:${attemptId}`
    };
  const reserved = await reserveRawMediaBudget(tx, writer, policy, now);
  if (
    !reserved ||
    reserved.state !== 'RESERVED' ||
    reserved.attemptId !== attemptId ||
    reserved.objectIdentity !== writer.objectIdentity ||
    reserved.storedBytes !== 0n
  )
    mediaBudgetFail('MEDIA_BUDGET_ICON_RECEIPT_INVARIANT');
  await allocateMediaStorage(tx, writer, { mediaBytes: writer.storedBytes, metadataBytes: 0n }, policy, now, {
    kind: 'quick-icon',
    bytes: writer.storedBytes,
    contentSha256: input.version
  });
  await beginMediaPersistence(tx, writer, now);
  await commitMediaBudget(tx, writer, now);
  const [component] = await tx.$queryRaw<
    Component[]
  >`/*media-stock:receipt-components*/ SELECT * FROM "MediaStoredComponent" WHERE "receiptScope"=${writer.scope} AND "receiptOperationKey"=${writer.operationKey} ORDER BY part FOR UPDATE`;
  if (
    !component ||
    component.policy !== 'QUICK_LINK_BYTEA' ||
    component.contentBindingSha256 !== input.version ||
    component.chargedBytes !== writer.storedBytes ||
    component.generation !== attemptId
  )
    fail();
  const changed =
    await tx.$executeRaw`/*media-quick-icon:bind*/ UPDATE "ResourceLink" SET "iconBudgetComponentId"=${component.id} WHERE id=${input.id} AND "iconBudgetComponentId" IS NULL AND "iconVersion"=${input.version} AND octet_length("iconBytes")=${input.storedBytes}`;
  if (changed !== 1) fail();
}
