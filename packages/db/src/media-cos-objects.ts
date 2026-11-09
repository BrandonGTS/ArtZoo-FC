import { randomUUID } from 'node:crypto';
import type { Prisma } from './generated/prisma/client.js';

/** Storage routing only. Call after authorization and the upload budget begin gate.
 * No network IO belongs in the caller-owned short transaction. This is not a
 * stock proof, business mount, quota settlement, or permission to delete. */
export type MediaCosObjectTx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
export const MEDIA_COS_SCOPES = [
  'albums',
  'album-comments',
  'daily',
  'wishes',
  'lottery',
  'knowledge',
  'activity-shares',
  'avatars',
  'quick-icons',
  'official'
] as const;
export type MediaCosObjectScope = (typeof MEDIA_COS_SCOPES)[number];
export type MediaCosObjectPart = 'original' | 'preview' | 'thumbnail' | 'full' | 'small' | 'icon';
export interface CosObjectLookup {
  readonly scope: MediaCosObjectScope;
  readonly objectId: string;
  readonly part: MediaCosObjectPart;
  readonly accountId: string | null;
}
export interface CosObjectReservation extends CosObjectLookup {
  readonly bucket: string;
  readonly region: 'ap-hongkong';
  readonly prefix: string;
  readonly objectKey: string;
  readonly bytes: bigint;
  readonly sha256: string;
}
export interface MediaCosObjectRecord extends CosObjectReservation {
  readonly id: string;
  readonly etag: string | null;
  readonly identityFingerprint: string | null;
  readonly createdAt: Date;
}
export interface CosObjectExpectedContent {
  readonly bytes: bigint;
  readonly sha256: string;
}
export class MediaCosObjectError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MediaCosObjectError';
  }
}
function fail(code: string): never {
  throw new MediaCosObjectError(code);
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function validateOwner(input: Omit<CosObjectLookup, 'part'>): void {
  if (
    !MEDIA_COS_SCOPES.includes(input.scope) ||
    !uuid(input.objectId) ||
    (input.scope === 'lottery' ? !uuid(input.accountId) : input.accountId !== null)
  )
    fail('COS_LOCATOR_INVALID');
}
export function validateCosObjectLookup(input: CosObjectLookup): void {
  validateOwner(input);
  const parts =
    input.scope === 'avatars'
      ? ['full', 'small']
      : input.scope === 'quick-icons'
        ? ['icon']
        : ['original', 'preview', 'thumbnail'];
  if (!parts.includes(input.part)) fail('COS_LOCATOR_INVALID');
}
function validateContent(input: CosObjectExpectedContent): void {
  // Matches the SDK adapter's exact integer byte domain, without changing scope quotas.
  if (
    typeof input.bytes !== 'bigint' ||
    input.bytes <= 0n ||
    input.bytes > BigInt(Number.MAX_SAFE_INTEGER) ||
    !digest(input.sha256)
  )
    fail('COS_LOCATOR_INVALID');
}
/** Reject noncanonical input instead of silently altering an immutable identity. */
export function validateCosObjectReservation(input: CosObjectReservation): void {
  validateCosObjectLookup(input);
  validateContent(input);
  if (
    typeof input.bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,49}-[0-9]{5,20}$/.test(input.bucket) ||
    input.region !== 'ap-hongkong' ||
    typeof input.prefix !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,39}(?:\/[a-z0-9][a-z0-9-]{0,39}){0,3}$/.test(input.prefix)
  )
    fail('COS_LOCATOR_INVALID');
  const key = [
    input.prefix,
    input.scope,
    ...(input.accountId ? [input.accountId] : []),
    input.objectId + '.' + input.part
  ].join('/');
  if (input.objectKey !== key) fail('COS_LOCATOR_INVALID');
}
function requireTransaction(tx: MediaCosObjectTx): void {
  // Prisma 7.10 can expose nested $transaction; root connect methods distinguish it.
  if (
    typeof (tx as { $connect?: unknown }).$connect === 'function' ||
    typeof (tx as { $disconnect?: unknown }).$disconnect === 'function'
  )
    fail('COS_LOCATOR_TRANSACTION_REQUIRED');
}
function validateObservation(etag: string, fingerprint: string): void {
  // ETag is opaque, not a content hash. The storage adapter supplies its canonical value.
  if (typeof etag !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(etag) || !digest(fingerprint))
    fail('COS_LOCATOR_INVALID');
}
function validateRecord(row: MediaCosObjectRecord): void {
  validateCosObjectReservation(row);
  if (
    !uuid(row.id) ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime()) ||
    (row.etag === null) !== (row.identityFingerprint === null)
  )
    fail('COS_LOCATOR_RECORD_INVALID');
  if (row.etag !== null) validateObservation(row.etag, row.identityFingerprint!);
}
const identityFields = [
  'scope',
  'objectId',
  'part',
  'accountId',
  'bucket',
  'region',
  'prefix',
  'objectKey',
  'bytes',
  'sha256'
] as const;
function assertSame(row: MediaCosObjectRecord, expected: CosObjectReservation): void {
  validateRecord(row);
  if (identityFields.some((field) => row[field] !== expected[field])) fail('COS_LOCATOR_CONFLICT');
}
/** All fragments are reserved atomically by the caller's one transaction.
 * On any rejection, let the exception abort that transaction. Existing rows are
 * immutable and exact-match idempotent, even if already observed. */
export async function reserveCosObjects(
  tx: MediaCosObjectTx,
  inputs: readonly CosObjectReservation[]
): Promise<MediaCosObjectRecord[]> {
  requireTransaction(tx);
  if (!Array.isArray(inputs) || inputs.length === 0) fail('COS_LOCATOR_INVALID');
  const owned = inputs.map((input) => ({ ...input }));
  owned.forEach(validateCosObjectReservation);
  // Stable ordering minimizes overlap deadlocks without changing returned order.
  const indexed = owned
    .map((input, index) => ({ input, index }))
    .sort((a, b) =>
      [a.input.scope, a.input.objectId, a.input.part]
        .join('/')
        .localeCompare([b.input.scope, b.input.objectId, b.input.part].join('/'))
    );
  const result: MediaCosObjectRecord[] = new Array(inputs.length);
  for (const { input, index } of indexed) {
    const id = randomUUID();
    await tx.$executeRaw`/*cos-locator:reserve*/
      INSERT INTO "MediaCosObject"
        ("id", "scope", "objectId", "part", "accountId", "bucket", "region", "prefix", "objectKey", "bytes", "sha256")
      VALUES (${id}, ${input.scope}, ${input.objectId}, ${input.part}, ${input.accountId},
        ${input.bucket}, ${input.region}, ${input.prefix}, ${input.objectKey}, ${input.bytes}, ${input.sha256})
      ON CONFLICT DO NOTHING`;
    const [row] = await tx.$queryRaw<MediaCosObjectRecord[]>`/*cos-locator:reserved*/
      SELECT * FROM "MediaCosObject" WHERE "scope"=${input.scope}
        AND "objectId"=${input.objectId} AND "part"=${input.part} FOR UPDATE`;
    if (!row) fail('COS_LOCATOR_CONFLICT');
    assertSame(row, input);
    result[index] = row;
  }
  return result;
}
/** CAS fills both observation fields once. Conflicting expected content or a
 * different observation is rejected; identical retries return the retained row. */
export async function confirmCosObject(
  tx: MediaCosObjectTx,
  locatorId: string,
  expected: CosObjectExpectedContent,
  etag: string,
  identityFingerprint: string
): Promise<MediaCosObjectRecord> {
  requireTransaction(tx);
  if (!uuid(locatorId)) fail('COS_LOCATOR_INVALID');
  expected = { ...expected };
  validateContent(expected);
  validateObservation(etag, identityFingerprint);
  const [changed] = await tx.$queryRaw<MediaCosObjectRecord[]>`/*cos-locator:confirm*/
    UPDATE "MediaCosObject" SET "etag"=${etag}, "identityFingerprint"=${identityFingerprint}
    WHERE "id"=${locatorId} AND "bytes"=${expected.bytes} AND "sha256"=${expected.sha256}
      AND "etag" IS NULL AND "identityFingerprint" IS NULL RETURNING *`;
  const [row] = changed
    ? [changed]
    : await tx.$queryRaw<MediaCosObjectRecord[]>`/*cos-locator:observed*/
      SELECT * FROM "MediaCosObject" WHERE "id"=${locatorId} FOR UPDATE`;
  if (!row) fail('COS_LOCATOR_NOT_FOUND');
  validateRecord(row);
  if (
    row.bytes !== expected.bytes ||
    row.sha256 !== expected.sha256 ||
    row.etag !== etag ||
    row.identityFingerprint !== identityFingerprint
  )
    fail('COS_LOCATOR_CONFLICT');
  return row;
}
/** null means no locator for this fragment. Owner mismatch is never a legacy
 * fallback. Call findCosObjects for object-level backend selection so a missing
 * fragment of an enrolled object cannot be mistaken for a legacy object. */
export async function findCosObject(
  tx: Pick<MediaCosObjectTx, '$queryRaw'>,
  input: CosObjectLookup
): Promise<MediaCosObjectRecord | null> {
  input = { ...input };
  validateCosObjectLookup(input);
  const [row] = await tx.$queryRaw<MediaCosObjectRecord[]>`/*cos-locator:find*/
    SELECT * FROM "MediaCosObject" WHERE "scope"=${input.scope}
      AND "objectId"=${input.objectId} AND "part"=${input.part}`;
  if (!row) return null;
  validateRecord(row);
  if (row.accountId !== input.accountId) fail('COS_LOCATOR_CONFLICT');
  return row;
}
/** No rows permits the existing legacy path. Any row pins the whole logical
 * object to COS; incomplete observations, missing parts, and all COS errors must
 * fail closed. The caller retains its existing business authorization. */
export async function findCosObjects(
  tx: Pick<MediaCosObjectTx, '$queryRaw'>,
  input: Omit<CosObjectLookup, 'part'>
): Promise<MediaCosObjectRecord[]> {
  input = { ...input };
  validateOwner(input);
  const rows = await tx.$queryRaw<MediaCosObjectRecord[]>`/*cos-locator:find-object*/
    SELECT * FROM "MediaCosObject" WHERE "scope"=${input.scope}
      AND "objectId"=${input.objectId} ORDER BY "part"`;
  for (const row of rows) {
    validateRecord(row);
    if (row.accountId !== input.accountId) fail('COS_LOCATOR_CONFLICT');
  }
  return rows;
}
