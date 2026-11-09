import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from './generated/prisma/client.js';
import { validateOfficialEventSourceInput, type OfficialEventSourceInput } from './official-event-source.js';
import { attachOfficialEventImageTx, type OfficialPreparedImage } from './official-event-images.js';
type Tx = Prisma.TransactionClient;
export interface OfficialEventIngestionResult {
  eventId: string;
  replayed: boolean;
  changedSource?: boolean;
  imageId?: string | null;
}
export const OFFICIAL_EVENT_MANUAL_FIELDS = [
  'title',
  'sourceUrl',
  'summary',
  'startsAt',
  'endsAt',
  'status',
  'image'
] as const;
type EventRow = {
  imageId: string | null;
  id: string;
  externalId: string;
  requestFingerprint: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceText: string;
  summary: string;
  startsAt: Date | null;
  endsAt: Date | null;
  status: string;
  manualFields: unknown;
  sourceSnapshot: unknown;
  revision: number;
};
export function officialEventSourceFingerprint(
  input: OfficialEventSourceInput,
  imageFingerprint?: string
): string {
  const snapshot: unknown[] = [
    input.sourceKey,
    input.externalId,
    input.sourceUrl,
    input.sourceTitle,
    input.sourceText
  ];
  if (input.calendar) snapshot.push(input.calendar);
  if (input.image) snapshot.push(input.image, imageFingerprint ?? null);
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
/** Administrator overrides are field-specific. A missing optional supplement never clears existing text. */
export function officialEventAutomaticFields(existing: EventRow, input: OfficialEventSourceInput) {
  const protectedFields = new Set(
    Array.isArray(existing.manualFields)
      ? existing.manualFields.filter((field): field is string => typeof field === 'string')
      : OFFICIAL_EVENT_MANUAL_FIELDS
  );
  const calendar = input.calendar!;
  let startsAt = protectedFields.has('startsAt') ? existing.startsAt : new Date(calendar.startsAt);
  let endsAt = protectedFields.has('endsAt') ? existing.endsAt : new Date(calendar.endsAt);
  // Independently protected dates must never combine into an invalid range.
  if (startsAt && endsAt && endsAt <= startsAt) {
    startsAt = existing.startsAt;
    endsAt = existing.endsAt;
  }
  const complete = Boolean(startsAt && endsAt && endsAt > startsAt);
  return {
    sourceTitle: protectedFields.has('title') ? existing.sourceTitle : input.sourceTitle,
    sourceUrl: protectedFields.has('sourceUrl') ? existing.sourceUrl : input.sourceUrl,
    sourceText: input.sourceText || existing.sourceText,
    summary: protectedFields.has('summary') || !calendar.summary ? existing.summary : calendar.summary,
    startsAt,
    endsAt,
    status: protectedFields.has('status') || !complete ? existing.status : 'PUBLISHED'
  };
}
/** Caller owns the transaction. Only verified calendar records publish automatically. No notifications. */
export async function ingestOfficialEventTx(
  tx: Tx,
  input: OfficialEventSourceInput,
  now = new Date(),
  image?: OfficialPreparedImage
): Promise<OfficialEventIngestionResult> {
  validateOfficialEventSourceInput(input);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid collection time');
  const fingerprint = officialEventSourceFingerprint(input, image?.fingerprint),
    identity = JSON.stringify([input.sourceKey, input.externalId]);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity},0))::text`;
  const [existing] = await tx.$queryRaw<EventRow[]>`
  SELECT * FROM "OfficialEvent" WHERE "sourceKey"=${input.sourceKey} AND
   ("externalId"=${input.externalId} OR (${Boolean(input.calendar)} AND "sourceUrl"=${input.sourceUrl} AND "externalId" NOT LIKE 'calendar:%'))
  ORDER BY ("externalId"=${input.externalId}) DESC,"createdAt",id LIMIT 1 FOR UPDATE`;
  if (existing) {
    // Old review-only snapshots retain their historical immutable behavior.
    if (!input.calendar)
      return {
        eventId: existing.id,
        replayed: true,
        ...(existing.requestFingerprint !== fingerprint ? { changedSource: true } : {})
      };
    if (existing.requestFingerprint === fingerprint)
      return { eventId: existing.id, replayed: true, imageId: existing.imageId };
    const changed = officialEventAutomaticFields(existing, input);
    const imageId =
      image && Array.isArray(existing.manualFields) && !existing.manualFields.includes('image')
        ? await attachOfficialEventImageTx(tx, existing.id, image, now)
        : existing.imageId;
    await tx.$executeRaw`UPDATE "OfficialEvent" SET "externalId"=${input.externalId},"sourceTitle"=${changed.sourceTitle},"sourceUrl"=${changed.sourceUrl},"sourceText"=${changed.sourceText},
   "imageId"=${imageId},summary=${changed.summary},"startsAt"=${changed.startsAt},"endsAt"=${changed.endsAt},status=${changed.status},"sourceSnapshot"=${JSON.stringify(input)}::jsonb,
   "requestFingerprint"=${fingerprint},revision=revision+1,"updatedAt"=${now} WHERE id=${existing.id}`;
    const before = {
      imageId: existing.imageId,
      sourceKey: input.sourceKey,
      externalId: existing.externalId,
      sourceTitle: existing.sourceTitle,
      sourceUrl: existing.sourceUrl,
      sourceText: existing.sourceText,
      requestFingerprint: existing.requestFingerprint,
      sourceSnapshot: existing.sourceSnapshot ?? {},
      manualFields: existing.manualFields,
      summary: existing.summary,
      startsAt: existing.startsAt,
      endsAt: existing.endsAt,
      status: existing.status,
      revision: existing.revision
    };
    const after = {
      ...before,
      ...changed,
      imageId,
      externalId: input.externalId,
      requestFingerprint: fingerprint,
      sourceSnapshot: input,
      revision: existing.revision + 1
    };
    await tx.$executeRaw`INSERT INTO "OfficialEventAudit" (id,"eventId","actorId",action,reason,before,after,"createdAt")
   VALUES (${randomUUID()},${existing.id},NULL,'SYNCED','官方月历同步',${JSON.stringify(before)}::jsonb,${JSON.stringify(after)}::jsonb,${now})`;
    return { eventId: existing.id, replayed: true, changedSource: true, imageId };
  }
  const eventId = randomUUID(),
    calendar = input.calendar,
    status = calendar ? 'PUBLISHED' : 'PENDING',
    summary = calendar?.summary ?? '',
    startsAt = calendar ? new Date(calendar.startsAt) : null,
    endsAt = calendar ? new Date(calendar.endsAt) : null;
  await tx.$executeRaw`INSERT INTO "OfficialEvent" (id,"sourceKey","externalId","sourceUrl","sourceTitle","sourceText","requestFingerprint",status,summary,"startsAt","endsAt","sourceSnapshot","manualFields",revision,"createdAt","updatedAt")
  VALUES (${eventId},${input.sourceKey},${input.externalId},${input.sourceUrl},${input.sourceTitle},${input.sourceText},${fingerprint},${status},${summary},${startsAt},${endsAt},${JSON.stringify(input)}::jsonb,'[]'::jsonb,0,${now},${now})`;
  const imageId = image ? await attachOfficialEventImageTx(tx, eventId, image, now) : null;
  if (imageId) await tx.$executeRaw`UPDATE "OfficialEvent" SET "imageId"=${imageId} WHERE id=${eventId}`;
  const snapshot = { ...input, status, summary, startsAt, endsAt, imageId, revision: 0 };
  await tx.$executeRaw`INSERT INTO "OfficialEventAudit" (id,"eventId","actorId",action,reason,before,after,"createdAt")
  VALUES (${randomUUID()},${eventId},NULL,'COLLECTED',${calendar ? '官方月历自动发布' : '官网采集'},'{}'::jsonb,${JSON.stringify(snapshot)}::jsonb,${now})`;
  return { eventId, replayed: false, imageId };
}
export async function ingestOfficialEvent(
  db: PrismaClient,
  input: OfficialEventSourceInput,
  now = new Date()
): Promise<OfficialEventIngestionResult> {
  return db.$transaction((tx) => ingestOfficialEventTx(tx, input, now));
}
