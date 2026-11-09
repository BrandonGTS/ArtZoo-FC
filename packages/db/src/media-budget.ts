import { createHash } from 'node:crypto';
import type { Prisma } from './generated/prisma/client.js';
import {
  addMediaBytes,
  mediaBudgetDay,
  mediaBudgetFail,
  mediaByteCount,
  validateMediaReservation,
  validateMediaWriter,
  type MediaBudgetPolicy,
  type MediaReservationInput,
  type MediaWriterReservationInput,
  type MediaRawReservationInput,
  type MediaReceiptRetryLinks
} from '@artzoo/domain';
import {
  quoteMediaComponents,
  registerReceiptComponents,
  registerBaselineAggregate,
  type MediaStoredComponentAllocation
} from './media-stock-components.js';
import {
  MEDIA_RESERVATION_PROTOCOL,
  MEDIA_RESERVATION_TTL_MS,
  MEDIA_RESERVATION_BATCH_LIMIT,
  MEDIA_RESERVATION_BATCH_BYTES,
  MEDIA_RESERVATION_SCOPES,
  type MediaReservationCandidate,
  type MediaReservationCandidatePage,
  type MediaReservationListInput,
  type MediaReservationExpiryResult,
  type MediaReservationReconcileInput,
  type MediaReservationReconciliation
} from './media-reservation-contract.js';
export type MediaBudgetTx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
export type MediaReceiptState = 'RESERVED' | 'COMMITTED' | 'FAILED' | 'UNKNOWN';
export interface MediaBudgetReceipt extends MediaReservationInput, MediaReceiptRetryLinks {
  day: string | null;
  state: MediaReceiptState;
  createdAt: Date;
  updatedAt: Date;
  persistenceStartedAt: Date | null;
  settledAt: Date | null;
  attemptId: string | null;
  objectIdentity: string | null;
  storageReservedAt: Date | null;
  metadataReservedBytes: bigint;
  reservationProtocol: string | null;
}
interface GlobalRow {
  baselineBytes: bigint;
  committedBytes: bigint;
  creditedBytes: bigint;
  reservedBytes: bigint;
  baselineFingerprint: string | null;
  baselineInitializedAt: Date | null;
}
interface DailyRow {
  committedBytes: bigint;
  reservedBytes: bigint;
}
async function globalRow(tx: MediaBudgetTx): Promise<GlobalRow> {
  // Pinned Prisma7.10.1 supports nested $transaction on itx clients; only root connection methods distinguish it.
  if (
    typeof (tx as { $connect?: unknown }).$connect === 'function' ||
    typeof (tx as { $disconnect?: unknown }).$disconnect === 'function'
  )
    mediaBudgetFail('MEDIA_BUDGET_TRANSACTION_REQUIRED');
  await tx.$executeRaw`/*media-budget:init-global*/ INSERT INTO "MediaBudgetState" (id) VALUES ('global') ON CONFLICT (id) DO NOTHING`;
  const [row] = await tx.$queryRaw<
    GlobalRow[]
  >`/*media-budget:global*/ SELECT * FROM "MediaBudgetState" WHERE id='global' FOR UPDATE`;
  if (!row) mediaBudgetFail('MEDIA_BUDGET_STATE_MISSING');
  [row.baselineBytes, row.committedBytes, row.reservedBytes, row.creditedBytes].forEach((v) =>
    mediaByteCount(v)
  );
  if (row.creditedBytes > row.baselineBytes + row.committedBytes)
    mediaBudgetFail('MEDIA_BUDGET_STATE_MISMATCH');
  return row;
}
async function receipt(tx: MediaBudgetTx, scope: string, key: string, locked = false) {
  const rows = locked
    ? await tx.$queryRaw<
        MediaBudgetReceipt[]
      >`/*media-budget:receipt-lock*/ SELECT * FROM "MediaUploadReceipt" WHERE scope=${scope} AND "operationKey"=${key} FOR UPDATE`
    : await tx.$queryRaw<
        MediaBudgetReceipt[]
      >`/*media-budget:receipt*/ SELECT * FROM "MediaUploadReceipt" WHERE scope=${scope} AND "operationKey"=${key}`;
  return rows[0];
}
async function dailyRow(
  tx: MediaBudgetTx,
  accountId: string | null,
  day: string | null
): Promise<DailyRow | null> {
  if ((accountId === null) !== (day === null)) mediaBudgetFail('MEDIA_BUDGET_DAY_MISMATCH');
  if (accountId === null) return null;
  await tx.$executeRaw`/*media-budget:init-day*/ INSERT INTO "MediaDailyBudget" ("accountId",day) VALUES (${accountId},${day}) ON CONFLICT ("accountId",day) DO NOTHING`;
  const [row] = await tx.$queryRaw<
    DailyRow[]
  >`/*media-budget:day*/ SELECT * FROM "MediaDailyBudget" WHERE "accountId"=${accountId} AND day=${day} FOR UPDATE`;
  if (!row) mediaBudgetFail('MEDIA_BUDGET_STATE_MISSING');
  mediaByteCount(row.committedBytes);
  mediaByteCount(row.reservedBytes);
  return row;
}
function validateReceipt(row: MediaBudgetReceipt) {
  validateMediaReservation(row);
  mediaBudgetDay(row.createdAt);
  if (!['RESERVED', 'COMMITTED', 'FAILED', 'UNKNOWN'].includes(row.state))
    mediaBudgetFail('MEDIA_BUDGET_RETRY_STATE_INVALID');
  const key = (value: unknown) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value);
  if (
    (row.retryRootKey !== null && !key(row.retryRootKey)) ||
    (row.retryHeadKey !== null && !/^retry:[a-f0-9]{64}$/.test(row.retryHeadKey)) ||
    row.retryRootKey === row.operationKey ||
    row.retryHeadKey === row.operationKey ||
    (row.retryRootKey !== null && row.retryHeadKey !== null) ||
    (row.retryRootKey !== null && !/^retry:[a-f0-9]{64}$/.test(row.operationKey)) ||
    (row.retryHeadKey !== null && (row.state !== 'FAILED' || row.persistenceStartedAt !== null))
  )
    mediaBudgetFail('MEDIA_BUDGET_RETRY_STATE_INVALID');
  if (row.day !== (row.accountId === null ? null : mediaBudgetDay(row.createdAt)))
    mediaBudgetFail('MEDIA_BUDGET_DAY_MISMATCH');
  if (
    row.state === 'FAILED' &&
    (row.persistenceStartedAt !== null ||
      !(row.settledAt instanceof Date) ||
      !Number.isFinite(row.settledAt.getTime()) ||
      row.settledAt.getTime() < row.createdAt.getTime())
  )
    mediaBudgetFail('MEDIA_BUDGET_RETRY_STATE_INVALID');
}
function validateHead(root: MediaBudgetReceipt, head: MediaBudgetReceipt) {
  validateReceipt(root);
  validateReceipt(head);
  if (
    root.retryRootKey !== null ||
    root.state !== 'FAILED' ||
    head.scope !== root.scope ||
    head.accountId !== root.accountId ||
    root.retryHeadKey !== head.operationKey ||
    head.retryRootKey !== root.operationKey ||
    head.retryHeadKey !== null
  )
    mediaBudgetFail('MEDIA_BUDGET_RETRY_STATE_INVALID');
}
async function validateChild(tx: MediaBudgetTx, row: MediaBudgetReceipt) {
  if (row.retryRootKey === null) return;
  const root = await receipt(tx, row.scope, row.retryRootKey);
  if (!root) mediaBudgetFail('MEDIA_BUDGET_RETRY_STATE_INVALID');
  validateHead(root, row);
}
function same(found: MediaBudgetReceipt, input: MediaReservationInput, checkStored = true) {
  validateReceipt(found);
  if (
    found.scope !== input.scope ||
    found.operationKey !== input.operationKey ||
    found.fingerprint !== input.fingerprint ||
    found.accountId !== input.accountId ||
    found.rawBytes !== input.rawBytes ||
    (checkStored && found.storedBytes !== input.storedBytes)
  )
    mediaBudgetFail('MEDIA_BUDGET_REPLAY_CONFLICT');
  if (found.day !== (found.accountId === null ? null : mediaBudgetDay(found.createdAt)))
    mediaBudgetFail('MEDIA_BUDGET_DAY_MISMATCH');
}
async function saveGlobal(tx: MediaBudgetTx, committed: bigint, reserved: bigint) {
  mediaByteCount(committed);
  mediaByteCount(reserved);
  await tx.$executeRaw`/*media-budget:save-global*/ UPDATE "MediaBudgetState" SET "committedBytes"=${committed},"reservedBytes"=${reserved} WHERE id='global'`;
}
async function saveDaily(tx: MediaBudgetTx, row: MediaBudgetReceipt, committed: bigint, reserved: bigint) {
  if (row.accountId === null) return;
  mediaByteCount(committed);
  mediaByteCount(reserved);
  await tx.$executeRaw`/*media-budget:save-day*/ UPDATE "MediaDailyBudget" SET "committedBytes"=${committed},"reservedBytes"=${reserved} WHERE "accountId"=${row.accountId} AND day=${row.day}`;
}
/** Caller owns the transaction. No storage IO, auth checks, nested transaction or outbound effects occur here. */
export async function initializeMediaBudgetBaseline(
  tx: MediaBudgetTx,
  input: { bytes: bigint; fingerprint: string; now: Date }
) {
  mediaByteCount(input.bytes);
  mediaBudgetDay(input.now);
  if (!/^[a-f0-9]{64}$/.test(input.fingerprint)) mediaBudgetFail('MEDIA_BUDGET_INVALID_IDENTITY');
  const row = await globalRow(tx);
  if (row.baselineInitializedAt) {
    if (row.baselineBytes !== input.bytes || row.baselineFingerprint !== input.fingerprint)
      mediaBudgetFail('MEDIA_BUDGET_BASELINE_ALREADY_SET');
    return;
  }
  if (row.committedBytes || row.reservedBytes || row.creditedBytes)
    mediaBudgetFail('MEDIA_BUDGET_BASELINE_BUSY');
  await tx.$executeRaw`/*media-budget:baseline*/ UPDATE "MediaBudgetState" SET "baselineBytes"=${input.bytes},"baselineFingerprint"=${input.fingerprint},"baselineInitializedAt"=${input.now} WHERE id='global'`;
  await registerBaselineAggregate(tx, input);
}
async function reserve(
  tx: MediaBudgetTx,
  input: MediaWriterReservationInput,
  policy: MediaBudgetPolicy,
  now: Date,
  rawOnly: boolean
): Promise<MediaBudgetReceipt | null> {
  if (!policy.enabled) return null;
  validateMediaReservation(input);
  validateMediaWriter(input);
  if (!rawOnly) mediaByteCount(input.storedBytes, true);
  mediaBudgetDay(now);
  mediaByteCount(policy.globalLimitBytes, true);
  mediaByteCount(policy.dailyLimitBytes, true);
  const global = await globalRow(tx);
  const found = await receipt(tx, input.scope, input.operationKey);
  let retryRoot: MediaBudgetReceipt | undefined;
  let retryFrom: MediaBudgetReceipt | undefined;
  if (found) {
    validateReceipt(found);
    if (
      found.scope !== input.scope ||
      found.operationKey !== input.operationKey ||
      found.retryRootKey !== null
    )
      mediaBudgetFail('MEDIA_BUDGET_RETRY_STATE_INVALID');
    // Actor identity cannot be changed by a new payload or by a retry pointer.
    if (found.accountId !== input.accountId) mediaBudgetFail('MEDIA_BUDGET_REPLAY_CONFLICT');
    let head = found;
    if (found.retryHeadKey !== null) {
      const current = await receipt(tx, found.scope, found.retryHeadKey);
      if (!current) mediaBudgetFail('MEDIA_BUDGET_RETRY_STATE_INVALID');
      validateHead(found, current);
      head = current;
    }
    const sameWriter = head.attemptId === input.attemptId && head.objectIdentity === input.objectIdentity;
    if (head.state !== 'FAILED' || sameWriter) {
      // The current head governs active/uncertain/completed semantics, never the historical root payload.
      same(head, { ...input, operationKey: head.operationKey }, !rawOnly);
      return head;
    }
    if (head.attemptId === input.attemptId || head.objectIdentity === input.objectIdentity)
      mediaBudgetFail('MEDIA_BUDGET_RETRY_WRITER_REQUIRED');
    if (now.getTime() < head.settledAt!.getTime()) mediaBudgetFail('MEDIA_BUDGET_INVALID_TIME');
    retryRoot = found;
    retryFrom = head;
    const childKey =
      'retry:' +
      createHash('sha256')
        .update(
          JSON.stringify([
            'media-failed-retry-v1',
            input.scope,
            found.operationKey,
            head.operationKey,
            head.attemptId
          ])
        )
        .digest('hex');
    if (childKey === found.operationKey) mediaBudgetFail('MEDIA_BUDGET_RETRY_STATE_INVALID');
    input = { ...input, operationKey: childKey };
  }
  if (!global.baselineInitializedAt) mediaBudgetFail('MEDIA_BUDGET_BASELINE_REQUIRED');
  const day = input.accountId === null ? null : mediaBudgetDay(now);
  const daily = await dailyRow(tx, input.accountId, day);
  const total = addMediaBytes(
    mediaByteCount(global.baselineBytes + global.committedBytes - global.creditedBytes),
    addMediaBytes(global.reservedBytes, input.storedBytes)
  );
  if (total > policy.globalLimitBytes || (rawOnly && total === policy.globalLimitBytes))
    mediaBudgetFail('MEDIA_BUDGET_GLOBAL_LIMIT');
  if (
    daily &&
    addMediaBytes(daily.committedBytes, addMediaBytes(daily.reservedBytes, input.rawBytes)) >
      policy.dailyLimitBytes
  )
    mediaBudgetFail('MEDIA_BUDGET_DAILY_LIMIT');
  await saveGlobal(tx, global.committedBytes, addMediaBytes(global.reservedBytes, input.storedBytes));
  const row: MediaBudgetReceipt = {
    ...input,
    day,
    state: 'RESERVED',
    createdAt: now,
    updatedAt: now,
    persistenceStartedAt: null,
    settledAt: null,
    storageReservedAt: rawOnly ? null : now,
    metadataReservedBytes: 0n,
    reservationProtocol: reservationScope(input.scope) ? MEDIA_RESERVATION_PROTOCOL : null,
    retryHeadKey: null,
    retryRootKey: retryRoot?.operationKey ?? null
  };
  if (daily)
    await saveDaily(tx, row, daily.committedBytes, addMediaBytes(daily.reservedBytes, input.rawBytes));
  await tx.$executeRaw`/*media-budget:insert-receipt*/ INSERT INTO "MediaUploadReceipt" (scope,"operationKey",fingerprint,"accountId",day,"rawBytes","storedBytes",state,"createdAt","updatedAt","attemptId","objectIdentity","storageReservedAt","metadataReservedBytes","retryHeadKey","retryRootKey","reservationProtocol") VALUES (${input.scope},${input.operationKey},${input.fingerprint},${input.accountId},${day},${input.rawBytes},${input.storedBytes},'RESERVED',${now},${now},${input.attemptId},${input.objectIdentity},${row.storageReservedAt},${row.metadataReservedBytes},${row.retryHeadKey},${row.retryRootKey},${row.reservationProtocol})`;
  if (!rawOnly)
    await registerReceiptComponents(tx, row, quoteMediaComponents(row.scope, row.storedBytes, 0n), now, true);
  if (retryRoot && retryFrom) {
    const changed =
      await tx.$executeRaw`/*media-budget:retry-head*/ UPDATE "MediaUploadReceipt" SET "retryHeadKey"=${row.operationKey} WHERE scope=${retryRoot.scope} AND "operationKey"=${retryRoot.operationKey} AND "retryHeadKey" IS NOT DISTINCT FROM ${retryRoot.retryHeadKey} AND "retryRootKey" IS NULL AND state='FAILED' AND "persistenceStartedAt" IS NULL`;
    if (changed !== 1) mediaBudgetFail('MEDIA_BUDGET_RETRY_STATE_INVALID');
  }
  return row;
}
async function change(
  tx: MediaBudgetTx,
  expected: MediaWriterReservationInput,
  now: Date,
  action: 'begin' | 'commit' | 'unknown' | 'fail-before-persistence'
) {
  validateMediaReservation(expected);
  validateMediaWriter(expected);
  mediaBudgetDay(now);
  const global = await globalRow(tx);
  const before = await receipt(tx, expected.scope, expected.operationKey);
  if (!before) mediaBudgetFail('MEDIA_BUDGET_RECEIPT_REQUIRED');
  same(before, expected, false);
  await validateChild(tx, before);
  const daily = await dailyRow(tx, before.accountId, before.day);
  const row = await receipt(tx, expected.scope, expected.operationKey, true);
  if (!row) mediaBudgetFail('MEDIA_BUDGET_RECEIPT_REQUIRED');
  same(row, expected, false);
  own(row, expected);
  if (now.getTime() < row.createdAt.getTime()) mediaBudgetFail('MEDIA_BUDGET_INVALID_TIME');
  if (action === 'begin') {
    if (row.state !== 'RESERVED') mediaBudgetFail('MEDIA_BUDGET_TRANSITION_DENIED');
    if (!row.storageReservedAt || row.storedBytes === 0n) mediaBudgetFail('MEDIA_BUDGET_STORAGE_REQUIRED');
    if (row.persistenceStartedAt) mediaBudgetFail('MEDIA_BUDGET_WRITE_ALREADY_STARTED');
    await tx.$executeRaw`/*media-budget:begin*/ UPDATE "MediaUploadReceipt" SET "persistenceStartedAt"=${now},"updatedAt"=${now} WHERE scope=${row.scope} AND "operationKey"=${row.operationKey}`;
    return { ...row, persistenceStartedAt: now, updatedAt: now };
  }
  const next: MediaReceiptState =
    action === 'commit' ? 'COMMITTED' : action === 'unknown' ? 'UNKNOWN' : 'FAILED';
  if (row.state === next) return row;
  if (row.state === 'COMMITTED' || row.state === 'FAILED') mediaBudgetFail('MEDIA_BUDGET_TRANSITION_DENIED');
  if (action === 'commit' && !row.persistenceStartedAt) mediaBudgetFail('MEDIA_BUDGET_TRANSITION_DENIED');
  if (action === 'fail-before-persistence' && (row.state !== 'RESERVED' || row.persistenceStartedAt))
    mediaBudgetFail('MEDIA_BUDGET_RELEASE_REQUIRES_PREWRITE');
  if (next !== 'UNKNOWN') {
    await saveGlobal(
      tx,
      next === 'COMMITTED' ? addMediaBytes(global.committedBytes, row.storedBytes) : global.committedBytes,
      mediaByteCount(global.reservedBytes - row.storedBytes)
    );
    if (daily)
      await saveDaily(
        tx,
        row,
        next === 'COMMITTED' ? addMediaBytes(daily.committedBytes, row.rawBytes) : daily.committedBytes,
        mediaByteCount(daily.reservedBytes - row.rawBytes)
      );
  }
  const settledAt = next === 'UNKNOWN' ? null : now;
  await tx.$executeRaw`/*media-budget:settle*/ UPDATE "MediaUploadReceipt" SET state=${next},"updatedAt"=${now},"settledAt"=${settledAt} WHERE scope=${row.scope} AND "operationKey"=${row.operationKey}`;
  return { ...row, state: next, updatedAt: now, settledAt };
}
export const beginMediaPersistence = (tx: MediaBudgetTx, input: MediaWriterReservationInput, now: Date) =>
  change(tx, input, now, 'begin');
export const commitMediaBudget = (tx: MediaBudgetTx, input: MediaWriterReservationInput, now: Date) =>
  change(tx, input, now, 'commit');
export const markMediaBudgetUnknown = (tx: MediaBudgetTx, input: MediaWriterReservationInput, now: Date) =>
  change(tx, input, now, 'unknown');
/** Only before beginMediaPersistence. Never releases UNKNOWN or any possibly-written receipt. */
export const failMediaBeforePersistence = (
  tx: MediaBudgetTx,
  input: MediaWriterReservationInput,
  now: Date
) => change(tx, input, now, 'fail-before-persistence');

function own(row: MediaBudgetReceipt, expected: MediaWriterReservationInput) {
  if (row.attemptId !== expected.attemptId || row.objectIdentity !== expected.objectIdentity)
    mediaBudgetFail('MEDIA_BUDGET_NOT_WRITER');
}
export const reserveMediaBudget = (
  tx: MediaBudgetTx,
  input: MediaWriterReservationInput,
  policy: MediaBudgetPolicy,
  now: Date
) => reserve(tx, input, policy, now, false);
export const reserveRawMediaBudget = (
  tx: MediaBudgetTx,
  input: MediaRawReservationInput,
  policy: MediaBudgetPolicy,
  now: Date
) => reserve(tx, { ...input, storedBytes: 0n }, policy, now, true);
/** Exact total allocation once, before begin. No TTL, lease stealing or storage IO. */
export async function allocateMediaStorage(
  tx: MediaBudgetTx,
  input: MediaRawReservationInput,
  allocation: { mediaBytes: bigint; metadataBytes: bigint },
  policy: MediaBudgetPolicy,
  now: Date,
  components?: MediaStoredComponentAllocation
): Promise<MediaBudgetReceipt | null> {
  if (!policy.enabled) return null;
  const expected = { ...input, storedBytes: 0n };
  validateMediaReservation(expected);
  validateMediaWriter(input);
  mediaBudgetDay(now);
  mediaByteCount(allocation.mediaBytes, true);
  mediaByteCount(allocation.metadataBytes);
  mediaByteCount(policy.globalLimitBytes, true);
  const total = addMediaBytes(allocation.mediaBytes, allocation.metadataBytes);
  const parts = quoteMediaComponents(
    input.scope,
    allocation.mediaBytes,
    allocation.metadataBytes,
    components
  );
  const global = await globalRow(tx);
  const first = await receipt(tx, input.scope, input.operationKey);
  if (!first) mediaBudgetFail('MEDIA_BUDGET_RECEIPT_REQUIRED');
  same(first, expected, false);
  await validateChild(tx, first);
  await dailyRow(tx, first.accountId, first.day);
  const row = await receipt(tx, input.scope, input.operationKey, true);
  if (!row) mediaBudgetFail('MEDIA_BUDGET_RECEIPT_REQUIRED');
  same(row, expected, false);
  own(row, expected);
  if (row.state !== 'RESERVED' || row.persistenceStartedAt) mediaBudgetFail('MEDIA_BUDGET_TRANSITION_DENIED');
  if (now.getTime() < row.createdAt.getTime()) mediaBudgetFail('MEDIA_BUDGET_INVALID_TIME');
  if (row.storageReservedAt) {
    if (row.storedBytes !== total || row.metadataReservedBytes !== allocation.metadataBytes)
      mediaBudgetFail('MEDIA_BUDGET_ALLOCATION_CONFLICT');
    await registerReceiptComponents(tx, row, parts, now, false);
    return row;
  }
  if (row.storedBytes !== 0n || row.metadataReservedBytes !== 0n)
    mediaBudgetFail('MEDIA_BUDGET_STATE_MISMATCH');
  if (
    addMediaBytes(
      mediaByteCount(global.baselineBytes + global.committedBytes - global.creditedBytes),
      addMediaBytes(global.reservedBytes, total)
    ) > policy.globalLimitBytes
  )
    mediaBudgetFail('MEDIA_BUDGET_GLOBAL_LIMIT');
  await saveGlobal(tx, global.committedBytes, addMediaBytes(global.reservedBytes, total));
  await tx.$executeRaw`/*media-budget:allocate*/ UPDATE "MediaUploadReceipt" SET "storedBytes"=${total},"metadataReservedBytes"=${allocation.metadataBytes},"storageReservedAt"=${now},"updatedAt"=${now} WHERE scope=${row.scope} AND "operationKey"=${row.operationKey}`;
  const allocated = {
    ...row,
    storedBytes: total,
    metadataReservedBytes: allocation.metadataBytes,
    storageReservedAt: now,
    updatedAt: now
  };
  await registerReceiptComponents(tx, allocated, parts, now, true);
  return allocated;
}

const reservationCandidates = new WeakMap<
  MediaReservationCandidate,
  { receipt: MediaBudgetReceipt; selectedAt: number }
>();
const reservationScope = (scope: string) => (MEDIA_RESERVATION_SCOPES as readonly string[]).includes(scope);
function enrolled(row: MediaBudgetReceipt) {
  return row.reservationProtocol === MEDIA_RESERVATION_PROTOCOL && reservationScope(row.scope);
}
function expiryTime(row: MediaBudgetReceipt, now: Date): 'recent' | 'invalid-time' | null {
  const times = [
    row.createdAt,
    row.updatedAt,
    ...(row.storageReservedAt === null ? [] : [row.storageReservedAt])
  ];
  const current = now instanceof Date ? now.getTime() : NaN;
  if (
    !Number.isFinite(current) ||
    times.some((t) => !(t instanceof Date) || !Number.isFinite(t.getTime()) || t.getTime() > current)
  )
    return 'invalid-time';
  const latest = Math.max(
    row.createdAt.getTime(),
    row.storageReservedAt?.getTime() ?? row.createdAt.getTime()
  );
  if (row.storageReservedAt !== null && row.storageReservedAt.getTime() < row.createdAt.getTime())
    return 'invalid-time';
  if (row.updatedAt.getTime() < latest) return 'invalid-time';
  return current - latest > MEDIA_RESERVATION_TTL_MS ? null : 'recent';
}
function sameGeneration(row: MediaBudgetReceipt, expected: MediaBudgetReceipt) {
  const scalar = [
    'scope',
    'operationKey',
    'fingerprint',
    'accountId',
    'day',
    'rawBytes',
    'storedBytes',
    'metadataReservedBytes',
    'attemptId',
    'objectIdentity',
    'reservationProtocol',
    'retryRootKey'
  ] as const;
  return (
    scalar.every((key) => row[key] === expected[key]) &&
    row.createdAt?.getTime() === expected.createdAt?.getTime() &&
    row.storageReservedAt?.getTime() === expected.storageReservedAt?.getTime()
  );
}
/** Ordinary indexed read; no receipt locks, business reads, time/ID generation or IO. */
export async function listMediaReservationCandidates(
  tx: MediaBudgetTx,
  input: MediaReservationListInput
): Promise<MediaReservationCandidatePage> {
  mediaBudgetDay(input.now);
  const limit = input.limit ?? MEDIA_RESERVATION_BATCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MEDIA_RESERVATION_BATCH_LIMIT)
    mediaBudgetFail('MEDIA_RESERVATION_INVALID_LIMIT');
  if (input.after) {
    mediaBudgetDay(input.after.createdAt);
    validateMediaReservation({
      scope: input.after.scope,
      operationKey: input.after.operationKey,
      accountId: null,
      fingerprint: '0'.repeat(64),
      rawBytes: 1n,
      storedBytes: 0n
    });
  }
  const cutoff = new Date(input.now.getTime() - MEDIA_RESERVATION_TTL_MS);
  // Storage time is rechecked after this LIMIT: a late allocation cannot force an unbounded scan.
  const rows = input.after
    ? await tx.$queryRaw<
        MediaBudgetReceipt[]
      >`/*media-reservation:list-after*/ SELECT * FROM "MediaUploadReceipt"
        WHERE "reservationProtocol"=${MEDIA_RESERVATION_PROTOCOL} AND state='RESERVED' AND "persistenceStartedAt" IS NULL
        AND "createdAt"<${cutoff} AND ("createdAt",scope,"operationKey")>(${input.after.createdAt},${input.after.scope},${input.after.operationKey})
        ORDER BY "createdAt",scope,"operationKey" LIMIT ${limit}`
    : await tx.$queryRaw<MediaBudgetReceipt[]>`/*media-reservation:list*/ SELECT * FROM "MediaUploadReceipt"
        WHERE "reservationProtocol"=${MEDIA_RESERVATION_PROTOCOL} AND state='RESERVED' AND "persistenceStartedAt" IS NULL
        AND "createdAt"<${cutoff} ORDER BY "createdAt",scope,"operationKey" LIMIT ${limit}`;
  let bytes = 0n;
  const candidates: MediaReservationCandidate[] = [];
  for (const row of rows) {
    if (
      !enrolled(row) ||
      expiryTime(row, input.now) !== null ||
      row.state !== 'RESERVED' ||
      row.persistenceStartedAt !== null
    )
      continue;
    validateReceipt(row);
    if (row.attemptId === null || row.objectIdentity === null) continue;
    mediaByteCount(row.storedBytes);
    if (bytes + row.storedBytes > MEDIA_RESERVATION_BATCH_BYTES) continue;
    bytes += row.storedBytes;
    const token = Object.freeze({}) as MediaReservationCandidate;
    reservationCandidates.set(token, { receipt: structuredClone(row), selectedAt: input.now.getTime() });
    candidates.push(token);
  }
  const last = rows.at(-1);
  return {
    candidates: Object.freeze(candidates),
    nextCursor:
      rows.length === limit && last
        ? { createdAt: new Date(last.createdAt), scope: last.scope, operationKey: last.operationKey }
        : null
  };
}
/** Caller must roll back any error. Permanent FAILED fence and reserved-only release share its transaction. */
export async function expireMediaReservationTx(
  tx: MediaBudgetTx,
  candidate: MediaReservationCandidate,
  now: Date
): Promise<MediaReservationExpiryResult> {
  const captured = reservationCandidates.get(candidate);
  if (!captured) mediaBudgetFail('MEDIA_RESERVATION_CANDIDATE_REQUIRED');
  const expected = captured.receipt;
  const retain = (
    reason: Extract<MediaReservationExpiryResult, { kind: 'retained' }>['reason']
  ): MediaReservationExpiryResult => ({ kind: 'retained', reason });
  if (expiryTime(expected, now) === 'invalid-time' || now.getTime() < captured.selectedAt)
    return retain('invalid-time');
  const global = await globalRow(tx);
  const before = await receipt(tx, expected.scope, expected.operationKey);
  if (!before || !sameGeneration(before, expected)) return retain('changed-generation');
  if (!enrolled(before)) return retain('legacy');
  validateReceipt(before);
  const daily = await dailyRow(tx, before.accountId, before.day);
  const row = await receipt(tx, expected.scope, expected.operationKey, true);
  if (!row || !sameGeneration(row, expected)) return retain('changed-generation');
  if (!enrolled(row)) return retain('legacy');
  validateReceipt(row);
  if (row.state === 'UNKNOWN') return retain('unknown');
  if (row.persistenceStartedAt !== null) return retain('started');
  if (row.state !== 'RESERVED') return retain('already-terminal');
  await validateChild(tx, row);
  const timing = expiryTime(row, now);
  if (timing) return retain(timing);
  if (
    !row.attemptId ||
    !row.objectIdentity ||
    row.settledAt !== null ||
    (row.storageReservedAt === null && (row.storedBytes !== 0n || row.metadataReservedBytes !== 0n))
  )
    return retain('invalid-state');
  await saveGlobal(tx, global.committedBytes, mediaByteCount(global.reservedBytes - row.storedBytes));
  if (daily)
    await saveDaily(tx, row, daily.committedBytes, mediaByteCount(daily.reservedBytes - row.rawBytes));
  const changed = await tx.$executeRaw`/*media-reservation:expire*/ UPDATE "MediaUploadReceipt"
    SET state='FAILED',"updatedAt"=${now},"settledAt"=${now}
    WHERE scope=${row.scope} AND "operationKey"=${row.operationKey}
    AND "attemptId"=${row.attemptId} AND "objectIdentity"=${row.objectIdentity}
    AND "reservationProtocol"=${MEDIA_RESERVATION_PROTOCOL}
    AND state='RESERVED' AND "persistenceStartedAt" IS NULL`;
  if (changed !== 1) mediaBudgetFail('MEDIA_RESERVATION_EXPIRY_CONFLICT');
  return { kind: 'expired', releasedStoredBytes: row.storedBytes, releasedRawBytes: row.rawBytes };
}
/** Authoritative root/head snapshot in one statement; never repairs, refunds or fabricates COMMITTED. */
export async function reconcileMediaReservationTx(
  tx: MediaBudgetTx,
  input: MediaReservationReconcileInput
): Promise<MediaReservationReconciliation> {
  validateMediaReservation({ ...input, storedBytes: 0n });
  const rows = await tx.$queryRaw<
    { root: MediaBudgetReceipt; head: MediaBudgetReceipt | null }[]
  >`/*media-reservation:reconcile*/
    SELECT to_jsonb(r) || jsonb_build_object('rawBytes',r."rawBytes"::text,'storedBytes',r."storedBytes"::text,'metadataReservedBytes',r."metadataReservedBytes"::text) AS root,
      CASE WHEN h.scope IS NULL THEN NULL ELSE to_jsonb(h) || jsonb_build_object('rawBytes',h."rawBytes"::text,'storedBytes',h."storedBytes"::text,'metadataReservedBytes',h."metadataReservedBytes"::text) END AS head FROM "MediaUploadReceipt" r
    LEFT JOIN "MediaUploadReceipt" h ON h.scope=r.scope AND h."operationKey"=r."retryHeadKey"
    WHERE r.scope=${input.scope} AND r."operationKey"=${input.operationKey}`;
  const found = rows[0];
  if (!found) return { kind: 'missing' };
  // Exact decimal text projections prevent JSON number precision loss for PG int8.
  const decode = (value: MediaBudgetReceipt) => {
    const row = { ...value };
    for (const k of [
      'createdAt',
      'updatedAt',
      'storageReservedAt',
      'persistenceStartedAt',
      'settledAt'
    ] as const)
      if (row[k] !== null)
        (row as unknown as Record<string, unknown>)[k] = new Date(row[k] as unknown as string);
    for (const k of ['rawBytes', 'storedBytes', 'metadataReservedBytes'] as const) row[k] = BigInt(row[k]);
    return row;
  };
  const root = decode(found.root);
  if (root.retryRootKey !== null) mediaBudgetFail('MEDIA_BUDGET_RETRY_STATE_INVALID');
  validateReceipt(root);
  if (root.accountId !== input.accountId) return { kind: 'conflict' };
  let head = root;
  if (root.retryHeadKey !== null) {
    if (!found.head) mediaBudgetFail('MEDIA_BUDGET_RETRY_STATE_INVALID');
    head = decode(found.head);
    validateHead(root, head);
  }
  if (head.fingerprint !== input.fingerprint || head.rawBytes !== input.rawBytes) return { kind: 'conflict' };
  const kind =
    head.state === 'COMMITTED'
      ? 'committed'
      : head.state === 'FAILED'
        ? 'failed-retry'
        : head.state === 'RESERVED' && head.persistenceStartedAt === null
          ? 'active-prewrite'
          : 'preserve';
  return { kind, receipt: head };
}
