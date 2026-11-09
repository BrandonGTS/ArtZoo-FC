import { configuredQqGroups, resolveQqGroup } from './qq-groups.js';
import { botReminders, type BotManagementConfig, type BotReminder } from '@artzoo/domain';
import { currentBotPublication, botNoticeAllowed } from './bot-management.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Prisma } from './generated/prisma/client.js';
import { loadQqOfficialPlanningConfig, qqProactiveEnabled } from './qq-official-config.js';

type Tx = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;
export type QqNotificationKind =
  'PUBLISHED' | 'CHANGED' | 'CANCELLED' | 'REMINDER_2H' | 'REMINDER_1H' | 'REMINDER';
export type QqDeliveryStatus =
  | 'PENDING'
  | 'CLAIMED'
  | 'DISPATCHING'
  | 'SENT'
  | 'SIMULATED'
  | 'UNKNOWN'
  | 'DENIED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';
export interface QqNotificationTarget {
  appId: string;
  botId: string;
  groupOpenId: string;
  enabled: boolean;
  enabledAt: Date;
  testGroupOnly: boolean;
  managed?: boolean;
  generation?: number;
  deliveryMode?: 'SIMULATION' | 'LIVE';
}
export interface QqActivitySnapshot {
  id: string;
  revision: number;
  title: string;
  scene: 'GAME' | 'OFFLINE';
  mode: 'SINGLE' | 'SERIES';
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
  cancelledAt: Date | null;
  seats?: import('@artzoo/domain').BotSeatValue[];
  dutySnapshot?: unknown;
  capacityUnlimited?: boolean;
  _count?: { seats: number; registrations: number };
  description?: string;
  location?: string | null;
  seriesId?: string | null;
  periodNumber?: number | null;
  // Include every period, including cancelled/ended ones. Never choose the earliest remaining period.
  series?: { activities: Array<{ id: string; periodNumber: number | null }> } | null;
}
export interface QqNotificationPayload {
  activityId: string;
  activityTitle: string;
  scene: string;
  mode: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  activityLink: string;
  scheduleFingerprint: string;
  firstPeriodId: string | null;
  reminder?: BotReminder;
}
export interface QqNotificationPlan {
  eventKey: string;
  botId: string;
  appId: string;
  groupOpenId: string;
  activityId: string;
  activityRevision: number;
  kind: QqNotificationKind;
  deliveryMode: 'SIMULATION' | 'LIVE';
  dueAt: Date;
  expiresAt: Date;
  payload: QqNotificationPayload;
  groupGeneration?: number | null;
}
export interface QqDelivery extends QqNotificationPlan {
  id: string;
  status: QqDeliveryStatus;
  attempts: number;
  fence: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  dispatchedAt: Date | null;
  sentAt: Date | null;
  resultCode: string | null;
  providerMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface QqDeliveryClaim {
  delivery: QqDelivery;
  claimToken: string;
}
const MINUTE = 60_000;
const MAX_ATTEMPTS = 3;
const LEASE_MS = 30_000;
function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function qqFirstPeriodId(activity: QqActivitySnapshot): string | null {
  if (activity.mode === 'SINGLE') return activity.id;
  const periods = activity.series?.activities;
  if (!periods?.length || periods.some((row) => !Number.isInteger(row.periodNumber) || row.periodNumber! < 1))
    return null;
  return [...periods].sort((a, b) => a.periodNumber! - b.periodNumber! || a.id.localeCompare(b.id))[0]!.id;
}
export function qqScheduleFingerprint(activity: QqActivitySnapshot): string {
  return hash(
    JSON.stringify([
      activity.id,
      activity.startsAt.toISOString(),
      activity.endsAt.toISOString(),
      qqFirstPeriodId(activity)
    ])
  );
}
export function qqTargetEnabled(target: QqNotificationTarget, now: Date): boolean {
  return (
    target.enabled === true &&
    (target.testGroupOnly === true || target.managed === true) &&
    validDate(target.enabledAt) &&
    target.enabledAt <= now &&
    !!target.appId &&
    !!target.botId &&
    !!target.groupOpenId
  );
}
function supported(activity: QqActivitySnapshot): boolean {
  return (
    ['GAME', 'OFFLINE'].includes(activity.scene) &&
    ['SINGLE', 'SERIES'].includes(activity.mode) &&
    Number.isInteger(activity.revision) &&
    activity.revision >= 0 &&
    validDate(activity.startsAt) &&
    validDate(activity.endsAt) &&
    validDate(activity.createdAt) &&
    activity.endsAt > activity.startsAt
  );
}
export function qqNotificationEventKey(
  target: QqNotificationTarget,
  activity: QqActivitySnapshot,
  kind: QqNotificationKind
): string {
  return (
    'qq-official:' +
    hash(
      JSON.stringify([target.botId, target.appId, target.groupOpenId, activity.id, activity.revision, kind])
    )
  );
}
export function planQqActivityNotifications(
  activity: QqActivitySnapshot,
  kind: 'PUBLISHED' | 'CHANGED' | 'CANCELLED' | 'REMINDERS',
  target: QqNotificationTarget,
  now: Date,
  reminders?: readonly BotReminder[]
): QqNotificationPlan[] {
  if (!validDate(now) || !supported(activity) || !qqTargetEnabled(target, now)) return [];
  // Forward-only enablement: existing activities never generate historical notices or reminders.
  if ((kind === 'PUBLISHED' || kind === 'REMINDERS') && activity.createdAt < target.enabledAt) return [];
  if (kind === 'CANCELLED' ? !activity.cancelledAt : !!activity.cancelledAt) return [];
  const firstPeriodId = qqFirstPeriodId(activity);
  const payload: QqNotificationPayload = {
    activityId: activity.id,
    activityTitle: activity.title,
    scene: activity.scene,
    mode: activity.mode,
    startsAt: activity.startsAt.toISOString(),
    endsAt: activity.endsAt.toISOString(),
    location: activity.location ?? null,
    activityLink: '/activities/' + activity.id,
    scheduleFingerprint: qqScheduleFingerprint(activity),
    firstPeriodId
  };
  const make = (eventKind: QqNotificationKind, dueAt: Date, expiresAt: Date): QqNotificationPlan => ({
    eventKey: qqNotificationEventKey(target, activity, eventKind),
    botId: target.botId,
    appId: target.appId,
    groupOpenId: target.groupOpenId,
    activityId: activity.id,
    activityRevision: activity.revision,
    kind: eventKind,
    groupGeneration: target.generation ?? 0,
    deliveryMode: target.deliveryMode ?? 'SIMULATION',
    dueAt,
    expiresAt,
    payload
  });
  const plans: QqNotificationPlan[] = [];
  if (kind !== 'REMINDERS') {
    const expiresAt = new Date(
      kind === 'CANCELLED'
        ? now.getTime() + 10 * MINUTE
        : Math.min(now.getTime() + 10 * MINUTE, activity.startsAt.getTime())
    );
    if (expiresAt > now) plans.push(make(kind, now, expiresAt));
  }
  if (kind === 'CANCELLED' || firstPeriodId !== activity.id || activity.createdAt < target.enabledAt)
    return plans;
  const rules = reminders
    ? reminders
        .filter((r) => r.enabled)
        .map((r) => ({ kind: 'REMINDER' as const, minutes: r.minutes, reminder: r }))
    : [
        { kind: 'REMINDER_2H' as const, minutes: 120 },
        { kind: 'REMINDER_1H' as const, minutes: 60 }
      ];
  for (const rule of rules) {
    const eventKind = rule.kind,
      lead = rule.minutes;
    const dueAt = new Date(activity.startsAt.getTime() - lead * MINUTE);
    if (dueAt < now || (reminders && dueAt <= now) || dueAt < target.enabledAt) continue;
    const plan = make(
      eventKind,
      dueAt,
      new Date(Math.min(dueAt.getTime() + MINUTE, activity.startsAt.getTime()))
    );
    if ('reminder' in rule) {
      plan.payload = { ...plan.payload, reminder: rule.reminder };
      plan.eventKey =
        'qq-reminder:' +
        hash(
          JSON.stringify([
            target.botId,
            target.appId,
            target.groupOpenId,
            qqScheduleFingerprint(activity),
            lead
          ])
        );
    }
    plans.push(plan);
  }
  return plans;
}
export function validateQqDelivery(
  delivery: QqDelivery,
  activity: QqActivitySnapshot | null,
  target: QqNotificationTarget,
  now: Date
): 'VALID' | 'CANCELLED' | 'EXPIRED' | 'DENIED' {
  if (delivery.expiresAt <= now) return 'EXPIRED';
  if (
    !qqTargetEnabled(target, now) ||
    delivery.botId !== target.botId ||
    delivery.appId !== target.appId ||
    delivery.groupOpenId !== target.groupOpenId ||
    delivery.deliveryMode !== (target.deliveryMode ?? 'SIMULATION') ||
    delivery.createdAt < target.enabledAt ||
    (delivery.groupGeneration ?? 0) !== (target.generation ?? 0)
  )
    return 'DENIED';
  if (!activity || activity.id !== delivery.activityId || !supported(activity)) return 'CANCELLED';
  if (delivery.kind === 'CANCELLED') return activity.cancelledAt ? 'VALID' : 'CANCELLED';
  if (
    activity.cancelledAt ||
    delivery.payload.scheduleFingerprint !== qqScheduleFingerprint(activity) ||
    delivery.payload.activityTitle !== activity.title ||
    delivery.payload.location !== (activity.location ?? null)
  )
    return 'CANCELLED';
  if (delivery.kind.startsWith('REMINDER') && qqFirstPeriodId(activity) !== activity.id) return 'CANCELLED';
  return 'VALID';
}
/** In the business transaction under its existing activity/series lock. */
export async function invalidateQqActivityNotifications(
  tx: Tx,
  activityId: string,
  now: Date,
  remindersOnly = false,
  scope?: QqNotificationTarget
): Promise<number> {
  return tx.$executeRawUnsafe(
    'UPDATE "QqOfficialDelivery" SET "status" = \'CANCELLED\', "leaseOwner" = NULL, "leaseUntil" = NULL, "resultCode" = \'ACTIVITY_CHANGED\', "updatedAt" = $2 WHERE "activityId" = $1 AND "status" IN (\'PENDING\',\'CLAIMED\') AND ($4::text IS NULL OR (\"botId\"=$4 AND \"appId\"=$5 AND \"groupOpenId\"=$6)) AND ($3 = false OR "kind" IN (\'REMINDER_2H\',\'REMINDER_1H\',\'REMINDER\'))',
    activityId,
    now,
    remindersOnly,
    scope?.botId ?? null,
    scope?.appId ?? null,
    scope?.groupOpenId ?? null
  );
}
/** Only actual new business events; never replay historical mock ActivityOutbox receipts. */
export async function enqueueQqActivityNotifications(
  tx: Tx,
  activity: QqActivitySnapshot,
  kind: 'PUBLISHED' | 'CHANGED' | 'CANCELLED' | 'REMINDERS',
  target: QqNotificationTarget,
  now: Date,
  clock?: () => Date
): Promise<number> {
  const arrived = performance.now();
  await lockQqReminderPlanning(tx);
  now = clock ? clock() : new Date(now.getTime() + Math.max(0, Math.floor(performance.now() - arrived)));
  if (!validDate(now)) throw new Error('Invalid reminder planning clock');
  if (target.managed) {
    const current = await resolveQqGroup(
      tx as Prisma.TransactionClient,
      {
        mode: target.deliveryMode === 'SIMULATION' ? 'simulation' : 'live',
        target: { ...target, deliveryMode: target.deliveryMode ?? 'LIVE' },
        managedGroups: true
      },
      target.groupOpenId
    );
    if (
      !current ||
      current.generation !== target.generation ||
      current.enabledAt.getTime() !== target.enabledAt.getTime()
    )
      return 0;
  }
  if (kind === 'CANCELLED' || kind === 'CHANGED')
    await invalidateQqActivityNotifications(tx, activity.id, now, false, target);
  const management =
    'botManagementState' in tx ? await currentBotPublication(tx as Prisma.TransactionClient, target) : null;
  let inserted = 0;
  for (const plan of planQqActivityNotifications(
    activity,
    kind,
    target,
    now,
    management ? botReminders(management.config) : undefined
  )) {
    if (management && !botNoticeAllowed(management.config, plan.kind)) continue;
    if (plan.kind === 'REMINDER') {
      inserted += await storeQqReminderPlan(tx, plan, now, management?.notificationEpoch ?? 0);
      continue;
    }
    inserted += await tx.$executeRawUnsafe(
      'INSERT INTO "QqOfficialDelivery" ("id","eventKey","botId","appId","groupOpenId","activityId","activityRevision","kind","deliveryMode","dueAt","expiresAt","payload","status","createdAt","updatedAt","planningEpoch","groupGeneration") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,\'PENDING\',$13,$13,$14,$15) ON CONFLICT ("eventKey") DO NOTHING',
      randomUUID(),
      plan.eventKey,
      plan.botId,
      plan.appId,
      plan.groupOpenId,
      plan.activityId,
      plan.activityRevision,
      plan.kind,
      plan.deliveryMode,
      plan.dueAt,
      plan.expiresAt,
      JSON.stringify(plan.payload),
      now,
      management?.notificationEpoch ?? 0,
      plan.groupGeneration ?? 0
    );
  }
  return inserted;
}
/** Before dispatch, expired leases are safe to retry. After dispatch they are terminal UNKNOWN. */
export async function recoverQqDeliveryLeases(tx: Tx, now: Date): Promise<number> {
  return tx.$executeRawUnsafe(
    'UPDATE "QqOfficialDelivery" SET "status" = CASE WHEN "status" = \'DISPATCHING\' THEN \'UNKNOWN\' WHEN "expiresAt" <= $1 THEN \'EXPIRED\' WHEN "attempts" >= $2 THEN \'FAILED\' ELSE \'PENDING\' END, "resultCode" = CASE WHEN "status" = \'DISPATCHING\' THEN \'DISPATCH_LEASE_EXPIRED\' ELSE \'CLAIM_LEASE_EXPIRED\' END, "leaseOwner" = NULL, "leaseUntil" = NULL, "updatedAt" = $1 WHERE "status" IN (\'CLAIMED\',\'DISPATCHING\') AND "leaseUntil" <= $1',
    now,
    MAX_ATTEMPTS
  );
}
/** Atomic SKIP LOCKED claim; no external call permitted until beginQqDelivery commits. */
export async function claimQqDelivery(
  tx: Tx,
  target: QqNotificationTarget,
  now: Date
): Promise<QqDeliveryClaim | null> {
  if (!qqTargetEnabled(target, now)) return null;
  const claimToken = randomBytes(32).toString('hex'),
    owner = hash(claimToken),
    leaseUntil = new Date(now.getTime() + LEASE_MS);
  await recoverQqDeliveryLeases(tx, now);
  await tx.$executeRawUnsafe(
    'UPDATE "QqOfficialDelivery" SET "status" = \'EXPIRED\', "resultCode" = \'WINDOW_EXPIRED\', "updatedAt" = $1 WHERE "status" = \'PENDING\' AND "expiresAt" <= $1',
    now
  );
  const rows = await tx.$queryRawUnsafe<QqDelivery[]>(
    'WITH candidate AS (SELECT "id" FROM "QqOfficialDelivery" WHERE "status" = \'PENDING\' AND "dueAt" <= $1 AND "expiresAt" > $1 AND "createdAt" >= $2 AND "attempts" < $3 AND "botId" = $4 AND "appId" = $5 AND "groupOpenId" = $6 AND "deliveryMode" = $9 ORDER BY "dueAt","id" FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE "QqOfficialDelivery" AS d SET "status" = \'CLAIMED\', "fence" = d."fence"+1, "attempts" = d."attempts"+1, "leaseOwner" = $7, "leaseUntil" = $8, "updatedAt" = $1 FROM candidate WHERE d."id" = candidate."id" RETURNING d.*',
    now,
    target.enabledAt,
    MAX_ATTEMPTS,
    target.botId,
    target.appId,
    target.groupOpenId,
    owner,
    leaseUntil,
    target.deliveryMode ?? 'SIMULATION'
  );
  return rows[0] ? { delivery: rows[0], claimToken } : null;
}
export interface QqDeliveryIdentity {
  id: string;
  fence: number;
  claimToken: string;
}
/** Under activity/series lock with a freshly read activity and current target.
 * Commit BEFORE the external call. Never send on a failed or uncertain commit.
 */
export async function beginQqDelivery(
  tx: Tx,
  identity: QqDeliveryIdentity,
  activity: QqActivitySnapshot | null,
  target: QqNotificationTarget,
  now: Date
): Promise<QqDelivery | null> {
  const owner = hash(identity.claimToken);
  const rows = await tx.$queryRawUnsafe<QqDelivery[]>(
    'SELECT * FROM "QqOfficialDelivery" WHERE "id" = $1 AND "fence" = $2 AND "leaseOwner" = $3 AND "status" = \'CLAIMED\' AND "leaseUntil" > $4 FOR UPDATE',
    identity.id,
    identity.fence,
    owner,
    now
  );
  const row = rows[0];
  if (!row) return null;
  const validity = validateQqDelivery(row, activity, target, now);
  if (validity !== 'VALID') {
    await tx.$executeRawUnsafe(
      'UPDATE "QqOfficialDelivery" SET "status" = $1, "resultCode" = $1, "leaseOwner" = NULL, "leaseUntil" = NULL, "updatedAt" = $2 WHERE "id" = $3 AND "fence" = $4 AND "status" = \'CLAIMED\' AND "leaseOwner" = $5',
      validity,
      now,
      row.id,
      row.fence,
      owner
    );
    return null;
  }
  const dispatched = await tx.$queryRawUnsafe<QqDelivery[]>(
    'UPDATE "QqOfficialDelivery" SET "status" = \'DISPATCHING\', "dispatchedAt" = $1, "leaseUntil" = $2, "updatedAt" = $1 WHERE "id" = $3 AND "fence" = $4 AND "status" = \'CLAIMED\' AND "leaseOwner" = $5 AND "leaseUntil" > $1 RETURNING *',
    now,
    new Date(now.getTime() + LEASE_MS),
    row.id,
    row.fence,
    owner
  );
  return dispatched[0] ?? null;
}
export type QqDeliveryOutcome =
  | { kind: 'SENT'; providerMessageId: string }
  | { kind: 'SIMULATED' }
  | { kind: 'DENIED'; code?: string }
  | { kind: 'SAFE_PRE_SEND_FAILURE'; code?: string }
  | { kind: 'UNKNOWN'; code?: string };
export function qqDeliveryOutcomeTransition(
  row: Pick<QqDelivery, 'attempts' | 'expiresAt'>,
  outcome: QqDeliveryOutcome,
  now: Date
) {
  if (outcome.kind === 'SENT') return { status: 'SENT' as const, code: 'CONFIRMED', dueAt: null };
  if (outcome.kind === 'SIMULATED') return { status: 'SIMULATED' as const, code: 'SIMULATED', dueAt: null };
  if (outcome.kind === 'DENIED') return { status: 'DENIED' as const, code: 'PROVIDER_DENIED', dueAt: null };
  if (outcome.kind !== 'SAFE_PRE_SEND_FAILURE')
    return { status: 'UNKNOWN' as const, code: 'DISPATCH_UNCERTAIN', dueAt: null };
  const dueAt = new Date(now.getTime() + Math.min(row.attempts * 5_000, 15_000));
  if (row.expiresAt <= dueAt)
    return { status: 'EXPIRED' as const, code: 'RETRY_WINDOW_EXPIRED', dueAt: null };
  if (row.attempts >= MAX_ATTEMPTS) return { status: 'FAILED' as const, code: 'RETRY_LIMIT', dueAt: null };
  return { status: 'PENDING' as const, code: 'SAFE_PRE_SEND_FAILURE', dueAt };
}
/** SAFE_PRE_SEND_FAILURE requires positive evidence no send occurred.
 * Timeouts, thrown errors, lost responses and worker crash always become UNKNOWN.
 */
export async function completeQqDelivery(
  tx: Tx,
  identity: QqDeliveryIdentity,
  outcome: QqDeliveryOutcome,
  now: Date
): Promise<boolean> {
  const owner = hash(identity.claimToken);
  const rows = await tx.$queryRawUnsafe<QqDelivery[]>(
    'SELECT * FROM "QqOfficialDelivery" WHERE "id" = $1 AND "fence" = $2 AND "leaseOwner" = $3 AND "status" = \'DISPATCHING\' AND "leaseUntil" > $4 FOR UPDATE',
    identity.id,
    identity.fence,
    owner,
    now
  );
  const row = rows[0];
  if (!row) return false;
  if (
    (outcome.kind === 'SENT' && row.deliveryMode !== 'LIVE') ||
    (outcome.kind === 'SIMULATED' && row.deliveryMode !== 'SIMULATION')
  )
    return false;
  const next = qqDeliveryOutcomeTransition(row, outcome, now);
  const messageId = outcome.kind === 'SENT' ? outcome.providerMessageId.slice(0, 256) : null;
  if (outcome.kind === 'SENT' && !messageId) return false;
  const changed = await tx.$executeRawUnsafe(
    'UPDATE "QqOfficialDelivery" SET "status" = $1, "resultCode" = $2, "providerMessageId" = $3, "sentAt" = $4, "dueAt" = COALESCE($5::timestamptz,"dueAt"), "leaseOwner" = NULL, "leaseUntil" = NULL, "updatedAt" = $6 WHERE "id" = $7 AND "fence" = $8 AND "status" = \'DISPATCHING\' AND "leaseOwner" = $9 AND "leaseUntil" > $6',
    next.status,
    next.code,
    messageId,
    outcome.kind === 'SENT' ? now : null,
    next.dueAt,
    now,
    identity.id,
    identity.fence,
    owner
  );
  return changed === 1;
}

/** Load a current immutable notification projection. The caller already owns the business lock. */
export async function loadQqActivitySnapshot(
  tx: Prisma.TransactionClient,
  activityId: string
): Promise<QqActivitySnapshot | null> {
  return tx.activity.findUnique({
    where: { id: activityId },
    select: {
      id: true,
      revision: true,
      title: true,
      scene: true,
      mode: true,
      startsAt: true,
      endsAt: true,
      createdAt: true,
      cancelledAt: true,
      description: true,
      location: true,
      seriesId: true,
      periodNumber: true,
      seats: {
        orderBy: { position: 'asc' },
        select: {
          position: true,
          groupKey: true,
          kind: true,
          role: true,
          job: true,
          registration: { select: { status: true } }
        }
      },
      dutySnapshot: true,
      capacityUnlimited: true,
      _count: { select: { seats: true, registrations: { where: { status: 'ACTIVE' } } } },
      series: {
        select: {
          activities: {
            orderBy: [{ periodNumber: 'asc' }, { id: 'asc' }],
            select: { id: true, periodNumber: true }
          }
        }
      }
    }
  });
}
export async function enqueueQqActivityNotificationsById(
  tx: Prisma.TransactionClient,
  activityId: string,
  kind: 'PUBLISHED' | 'CHANGED' | 'CANCELLED' | 'REMINDERS',
  target: QqNotificationTarget,
  now: Date
): Promise<number> {
  const activity = await loadQqActivitySnapshot(tx, activityId);
  if (!activity) return 0;
  return enqueueQqActivityNotifications(tx, activity, kind, target, now);
}
/** Uses the same series->period ordering as ActivityService; commit returned transition before transport. */
export async function beginQqDeliveryWithActivityLock(
  tx: Prisma.TransactionClient,
  identity: QqDeliveryIdentity,
  target: QqNotificationTarget,
  clock: Date | (() => Date)
): Promise<QqDelivery | null> {
  const delivery = await tx.qqOfficialDelivery.findUnique({
    where: { id: identity.id },
    select: { activityId: true }
  });
  if (!delivery) return null;
  const hint = await tx.activity.findUnique({
    where: { id: delivery.activityId },
    select: { seriesId: true }
  });
  if (hint?.seriesId) {
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text',
      'series:' + hint.seriesId
    );
    const periods = await tx.activity.findMany({
      where: { seriesId: hint.seriesId },
      orderBy: [{ periodNumber: 'asc' }, { id: 'asc' }],
      select: { id: true }
    });
    for (const period of periods)
      await tx.$queryRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text',
        'activity:' + period.id
      );
  } else
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text',
      'activity:' + delivery.activityId
    );
  const activity = await loadQqActivitySnapshot(tx, delivery.activityId);
  return beginQqDelivery(tx, identity, activity, target, typeof clock === 'function' ? clock() : clock);
}

/** A disabled configuration does no storage work. Re-enable epochs and begin-time state revalidation
 * prevent queued work from a former configuration from being sent after activation.
 */
export async function enqueueConfiguredQqActivityNotifications(
  tx: Prisma.TransactionClient,
  activityId: string,
  kind: 'PUBLISHED' | 'CHANGED' | 'CANCELLED' | 'REMINDERS',
  now: Date
): Promise<number> {
  const config = loadQqOfficialPlanningConfig();
  if (!config.target || !qqProactiveEnabled(config)) return 0;
  const target: QqNotificationTarget = {
    ...config.target,
    deliveryMode: config.mode === 'live' ? 'LIVE' : 'SIMULATION'
  };
  let count = 0;
  for (const group of await configuredQqGroups(tx, config))
    count += await enqueueQqActivityNotificationsById(
      tx,
      activityId,
      kind,
      { ...group, deliveryMode: target.deliveryMode },
      now
    );
  return count;
}

// Lock order: business activity/series -> planning -> delivery; management -> planning -> delivery.
// Never acquire an activity/series lock while holding the planning gate.
export async function lockQqReminderPlanning(tx: Tx) {
  await tx.$queryRawUnsafe(
    'SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text',
    'bot-management:reminder-planning'
  );
}
export async function storeQqReminderPlan(
  tx: Tx,
  plan: QqNotificationPlan,
  now: Date,
  epoch: number
): Promise<number> {
  const prior = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "QqOfficialDelivery" WHERE "botId"=$1 AND "appId"=$2 AND "groupOpenId"=$3 AND "activityId"=$4 AND "kind" IN ('REMINDER_2H','REMINDER_1H') AND "dueAt"=$5 AND "payload"->>'scheduleFingerprint'=$6 AND "attempts">0 LIMIT 1`,
    plan.botId,
    plan.appId,
    plan.groupOpenId,
    plan.activityId,
    plan.dueAt,
    plan.payload.scheduleFingerprint
  );
  if (prior.length) return 0;
  return tx.$executeRawUnsafe(
    `INSERT INTO "QqOfficialDelivery" ("id","eventKey","botId","appId","groupOpenId","activityId","activityRevision","kind","deliveryMode","dueAt","expiresAt","payload","status","createdAt","updatedAt","planningEpoch","groupGeneration") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'PENDING',$13,$13,$14,$15) ON CONFLICT ("eventKey") DO UPDATE SET "payload"=EXCLUDED."payload","status"='PENDING',"activityRevision"=EXCLUDED."activityRevision","planningEpoch"=EXCLUDED."planningEpoch","renderedContent"=NULL,"managementVersion"=NULL,"resultCode"=NULL,"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=$13 WHERE "QqOfficialDelivery"."attempts"=0 AND "QqOfficialDelivery"."dueAt">$13 AND "QqOfficialDelivery"."status" IN ('PENDING','CANCELLED') AND ("QqOfficialDelivery"."payload" IS DISTINCT FROM EXCLUDED."payload" OR "QqOfficialDelivery"."status"='CANCELLED' OR "QqOfficialDelivery"."planningEpoch" IS DISTINCT FROM EXCLUDED."planningEpoch")`,
    randomUUID(),
    plan.eventKey,
    plan.botId,
    plan.appId,
    plan.groupOpenId,
    plan.activityId,
    plan.activityRevision,
    plan.kind,
    plan.deliveryMode,
    plan.dueAt,
    plan.expiresAt,
    JSON.stringify(plan.payload),
    now,
    epoch,
    plan.groupGeneration ?? 0
  );
}
export async function reconcileQqReminderPlans(
  tx: Prisma.TransactionClient,
  target: QqNotificationTarget,
  config: BotManagementConfig,
  now: Date,
  epoch: number,
  previous?: BotManagementConfig
) {
  await lockQqReminderPlanning(tx);
  const scope = { botId: target.botId, appId: target.appId, groupOpenId: target.groupOpenId };
  const dueLegacy = await tx.qqOfficialDelivery.findMany({
    where: {
      ...scope,
      kind: { in: ['REMINDER_2H', 'REMINDER_1H'] },
      status: 'PENDING',
      attempts: 0,
      dueAt: { lte: now },
      expiresAt: { gt: now },
      renderedContent: null
    }
  });
  for (const row of dueLegacy) {
    const payload = row.payload as unknown as QqNotificationPayload;
    if (!payload.reminder) {
      const c = previous ?? config,
        kind = row.kind as 'REMINDER_2H' | 'REMINDER_1H';
      const reminder = {
        id: kind === 'REMINDER_2H' ? 'legacy-120' : 'legacy-60',
        minutes: kind === 'REMINDER_2H' ? 120 : 60,
        enabled: true,
        template: c.templates[kind]
      };
      await tx.qqOfficialDelivery.update({
        where: { id: row.id },
        data: { payload: { ...payload, reminder } as unknown as Prisma.InputJsonValue }
      });
    }
  }
  const rules = botReminders(config),
    enabled = config.proactivePaused ? [] : rules.filter((r) => r.enabled);
  const future = await tx.qqOfficialDelivery.findMany({
    where: {
      ...scope,
      kind: { in: ['REMINDER', 'REMINDER_2H', 'REMINDER_1H'] },
      status: 'PENDING',
      attempts: 0,
      dueAt: { gt: now }
    }
  });
  for (const row of future) {
    const payload = row.payload as unknown as QqNotificationPayload,
      keep = row.kind === 'REMINDER' && enabled.some((r) => r.minutes === payload.reminder?.minutes);
    if (!keep)
      await tx.qqOfficialDelivery.update({
        where: { id: row.id },
        data: { status: 'CANCELLED', resultCode: 'REMINDER_CONFIG_CHANGED' }
      });
  }
  if (!qqTargetEnabled(target, now) || config.proactivePaused) return;
  const activities = await tx.activity.findMany({
    where: {
      createdAt: { gte: target.enabledAt },
      startsAt: { gt: now },
      cancelledAt: null,
      scene: { in: ['GAME', 'OFFLINE'] },
      mode: { in: ['SINGLE', 'SERIES'] }
    },
    select: { id: true }
  });
  for (const item of activities) {
    const activity = await loadQqActivitySnapshot(tx, item.id);
    if (!activity) continue;
    for (const plan of planQqActivityNotifications(activity, 'REMINDERS', target, now, enabled))
      await storeQqReminderPlan(tx, plan, now, epoch);
  }
}
