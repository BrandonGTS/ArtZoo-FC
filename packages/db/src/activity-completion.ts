import { createMaintenanceState, runMaintenanceItem, type MaintenanceRunState } from './maintenance-run.js';
import type { Prisma, PrismaClient } from './generated/prisma/client.js';
import { settleActivityStanding } from './activity-standing.js';
import { validAttendanceRecord } from './activity-attendance-policy.js';

type Tx = Prisma.TransactionClient;
export interface CompletionActivity {
  id: string;
  scene?: string;
  mode?: string;
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
  continuedAt: Date | null;
  seats: { registration: { id: string } | null }[];
}
export interface CompletionRegistration {
  id: string;
  activityId: string;
  accountId: string;
  status: string;
  attendanceStatus: string | null;
  attendanceRecordedAt: Date | null;
  attendanceSource?: string | null;
}
export function completionEligible(activity: CompletionActivity, row: CompletionRegistration, now: Date) {
  return (
    (activity.scene === undefined || activity.scene === 'GAME') &&
    (activity.mode === undefined || activity.mode === 'SINGLE') &&
    !activity.cancelledAt &&
    now >= activity.endsAt &&
    row.status === 'ACTIVE' &&
    (row.attendanceStatus === 'PRESENT' || row.attendanceStatus === 'ABSENT') &&
    validAttendanceRecord(activity, row) &&
    // A delayed auto-cancel batch must not let an undecided, incomplete activity earn a credit first.
    (activity.continuedAt !== null || activity.seats.every((seat) => seat.registration))
  );
}
// Caller already holds recipient Account -> shared activity lock.
// DEFER is used only inside an attendance correction so both changes reconcile once.
export async function evaluateActivityCompletion(
  tx: Tx,
  activity: CompletionActivity,
  row: CompletionRegistration,
  now: Date,
  mode: 'APPLY' | 'DEFER' = 'APPLY'
) {
  if (!completionEligible(activity, row, now)) return null;
  const previous = await tx.activityCompletion.findUnique({
    where: { activityId_accountId: { activityId: activity.id, accountId: row.accountId } }
  });
  if (previous) return { record: previous, created: false };
  const before = await settleActivityStanding(tx, row.accountId, now),
    active = row.attendanceStatus === 'PRESENT';
  const points = active && mode === 'APPLY' ? Math.max(0, before.points - 1) : before.points;
  const decayAt = points < 3 ? null : before.decayAt;
  const record = await tx.activityCompletion.create({
    data: {
      activityId: activity.id,
      accountId: row.accountId,
      registrationId: row.id,
      active,
      evaluatedAt: now,
      updatedAt: now
    }
  });
  await tx.account.update({
    where: { id: row.accountId },
    data: { activityPoints: points, activityDecayAt: decayAt }
  });
  await tx.activityScoreChange.create({
    data: {
      eventKey: `completion:${record.id}`,
      accountId: row.accountId,
      completionId: record.id,
      reason: 'NORMAL_COMPLETION',
      delta: points - before.points,
      pointsBefore: before.points,
      pointsAfter: points,
      decayBefore: before.decayAt,
      decayAfter: decayAt,
      notices:
        points === before.points
          ? []
          : ['POINTS_CHANGED', ...(before.points >= 3 && points < 3 ? ['RESTRICTION_ENDED'] : [])],
      simulatedAt: now,
      createdAt: now
    }
  });
  if (mode === 'APPLY') {
    await tx.activity.update({ where: { id: activity.id }, data: { revision: { increment: 1 } } });
    await tx.activityCommand.create({
      data: {
        activityId: activity.id,
        actorId: null,
        idempotencyKey: `completion:${record.id}`,
        requestFingerprint: `completion:${row.id}`,
        kind: 'AUTO_COMPLETION',
        before: { registrationId: row.id, evaluated: false },
        after: { registrationId: row.id, active, evaluated: true },
        createdAt: now
      }
    });
    if (points !== before.points)
      await tx.activityOutbox.create({
        data: {
          eventKey: `completion:${record.id}:notice`,
          activityId: activity.id,
          registrationId: row.id,
          kind: 'ACTIVITY_COMPLETED',
          channel: 'IN_APP',
          recipientId: row.accountId,
          payload: { delta: points - before.points, points, activityLink: `/activities/${activity.id}` },
          createdAt: now,
          mockDelivery: { create: { deliveredAt: now } }
        }
      });
  }
  return { record, created: true };
}
export async function processActivityCompletions(
  db: PrismaClient,
  now = new Date(),
  state: MaintenanceRunState = createMaintenanceState()
) {
  return processCompletions(db, now, state);
}
async function processCompletions(db: PrismaClient, now: Date, state: MaintenanceRunState) {
  let completed = 0;
  const candidates = await db.activityRegistration.findMany({
    where: {
      status: 'ACTIVE',
      attendanceStatus: { in: ['PRESENT', 'ABSENT'] },
      attendanceRecordedAt: { not: null },
      completion: { is: null },
      activity: {
        scene: 'GAME',
        mode: 'SINGLE',
        cancelledAt: null,
        endsAt: { lte: now },
        OR: [{ continuedAt: { not: null } }, { seats: { none: { registration: { is: null } } } }]
      }
    },
    select: { id: true, accountId: true, activityId: true },
    orderBy: [{ activity: { endsAt: 'asc' } }, { id: 'asc' }],
    take: 100
  });
  for (const candidate of candidates) {
    if (state.stopping()) break;
    const credited = await runMaintenanceItem(state, 'activity.completion', candidate.id, () =>
      db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${candidate.accountId} FOR NO KEY UPDATE`;
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`activity:${candidate.activityId}`}, 0))::text`;
          const row = await tx.activityRegistration.findUnique({
            where: { id: candidate.id },
            include: {
              activity: { include: { seats: { select: { registration: { select: { id: true } } } } } }
            }
          });
          if (!row || row.accountId !== candidate.accountId || row.activityId !== candidate.activityId)
            return false;
          const result = await evaluateActivityCompletion(tx, row.activity, row, now);
          return !!result?.created && result.record.active;
        },
        { maxWait: 5000, timeout: 15000 }
      )
    );
    if (credited) completed++;
  }
  return completed;
}
