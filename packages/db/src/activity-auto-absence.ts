import { createMaintenanceState, runMaintenanceItem, type MaintenanceRunState } from './maintenance-run.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { addActivityPenaltyPoints } from './activity-standing.js';
import { automaticAbsenceEnabled } from './activity-attendance-policy.js';

/** Only new opted-in GAME/SINGLE activities; no legacy scan or external notification. */
export async function processActivityAutoAbsences(
  db: PrismaClient,
  suppliedNow?: Date,
  state: MaintenanceRunState = createMaintenanceState()
) {
  const cutoff = suppliedNow ?? new Date();
  const candidates = await db.activityRegistration.findMany({
    where: {
      status: 'ACTIVE',
      attendanceStatus: null,
      attendanceRecordedAt: null,
      attendancePenaltyId: null,
      activity: {
        scene: 'GAME',
        mode: 'SINGLE',
        cancelledAt: null,
        autoAbsenceEnabledAt: { not: null },
        startsAt: { gte: db.activity.fields.autoAbsenceEnabledAt },
        endsAt: { lte: cutoff },
        OR: [{ continuedAt: { not: null } }, { seats: { none: { registration: { is: null } } } }]
      }
    },
    select: { id: true, activityId: true, accountId: true },
    orderBy: [{ activity: { endsAt: 'asc' } }, { id: 'asc' }],
    take: 100
  });
  let absent = 0;
  for (const candidate of candidates) {
    if (state.stopping()) break;
    const changed = await runMaintenanceItem(state, 'activity.autoAbsent', candidate.id, () =>
      db.$transaction(
        async (tx) => {
          // Match interactive attendance and completion lock order: recipient before activity.
          await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${candidate.accountId} FOR NO KEY UPDATE`;
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`activity:${candidate.activityId}`}, 0))::text`;
          const row = await tx.activityRegistration.findUnique({
            where: { id: candidate.id },
            include: {
              activity: { include: { seats: { select: { registration: { select: { id: true } } } } } }
            }
          });
          const now = suppliedNow ?? new Date();
          if (!row || row.accountId !== candidate.accountId || row.activityId !== candidate.activityId)
            return false;
          const activity = row.activity;
          if (
            activity.scene !== 'GAME' ||
            activity.mode !== 'SINGLE' ||
            activity.cancelledAt ||
            !automaticAbsenceEnabled(activity) ||
            activity.startsAt < activity.attendanceEnabledAt ||
            now < activity.endsAt ||
            row.status !== 'ACTIVE' ||
            row.attendanceStatus !== null ||
            row.attendanceRecordedAt !== null ||
            row.attendancePenaltyId !== null ||
            row.attendanceSource !== null ||
            (!activity.continuedAt && activity.seats.some((seat) => !seat.registration))
          )
            return false;
          const eventKey = `attendance-auto-absence:${row.id}`;
          const penalty = await tx.activityPenalty.create({
            data: {
              eventKey,
              accountId: row.accountId,
              activityId: activity.id,
              registrationId: row.id,
              points: 2,
              reason: 'NO_SHOW',
              createdAt: now
            },
            select: { id: true }
          });
          const standing = await addActivityPenaltyPoints(tx, row.accountId, 2, now, eventKey, penalty.id);
          await tx.activityRegistration.update({
            where: { id: row.id },
            data: {
              attendanceStatus: 'ABSENT',
              attendanceSource: 'AUTO_DEADLINE',
              attendanceRevision: { increment: 1 },
              attendanceRecordedAt: now,
              attendanceUpdatedAt: now,
              attendancePenaltyId: penalty.id
            }
          });
          await tx.activity.update({ where: { id: activity.id }, data: { revision: { increment: 1 } } });
          await tx.activityCommand.create({
            data: {
              activityId: activity.id,
              actorId: null,
              idempotencyKey: eventKey,
              requestFingerprint: eventKey,
              kind: 'AUTO_ATTENDANCE',
              before: { registrationId: row.id, status: null, revision: row.attendanceRevision },
              after: {
                registrationId: row.id,
                status: 'ABSENT',
                source: 'AUTO_DEADLINE',
                recordedAt: now.toISOString()
              },
              createdAt: now
            }
          });
          await tx.activityOutbox.create({
            data: {
              eventKey: `penalty-notice:${eventKey}`,
              activityId: activity.id,
              registrationId: row.id,
              kind: 'ACTIVITY_PENALTY',
              channel: 'IN_APP',
              recipientId: row.accountId,
              payload: {
                points: 2,
                totalPoints: standing.points,
                reason: 'NO_SHOW',
                activityLink: `/activities/${activity.id}`
              },
              createdAt: now,
              mockDelivery: { create: { deliveredAt: now } }
            }
          });
          return true;
        },
        { maxWait: 5000, timeout: 15000 }
      )
    );
    if (changed) absent++;
  }
  return absent;
}
