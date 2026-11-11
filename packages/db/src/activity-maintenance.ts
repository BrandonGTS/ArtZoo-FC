import { createMaintenanceState, runMaintenanceItem, type MaintenanceRunState } from './maintenance-run.js';
import { enqueueConfiguredQqActivityNotifications } from './qq-official-notifications.js';
import type { Prisma, PrismaClient } from './generated/prisma/client.js';
import { settleActivityStanding } from './activity-standing.js';
import { processActivityCompletions } from './activity-completion.js';
import { processActivityAutoAbsences } from './activity-auto-absence.js';
import { processSeriesRecruitment } from './activity-series.js';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export async function processActivityMaintenance(
  db: PrismaClient,
  suppliedNow?: Date,
  state: MaintenanceRunState = createMaintenanceState()
) {
  const failuresBefore = state.failed;
  const now = suppliedNow ?? new Date();
  let reduced = 0,
    cancelled = 0;
  const accounts =
    (await runMaintenanceItem(state, 'activity.decay.scan', 'batch', () =>
      db.account.findMany({
        where: { activityPoints: { gte: 3 }, activityDecayAt: { lte: now } },
        select: { id: true },
        orderBy: [{ activityDecayAt: 'asc' }, { id: 'asc' }],
        take: 100
      })
    )) ?? [];
  for (const account of accounts) {
    if (state.stopping()) break;
    const changed = await runMaintenanceItem(state, 'activity.decay', account.id, () =>
      db.$transaction(
        async (tx) => {
          // Same Account row lock and primitive as interactive guards/penalties.
          const result = await settleActivityStanding(tx, account.id, now);
          return result.reduced;
        },
        { maxWait: 5000, timeout: 15000 }
      )
    );
    if (changed) reduced++;
  }

  const candidates =
    (await runMaintenanceItem(state, 'activity.cancel.scan', 'batch', () =>
      db.activity.findMany({
        where: {
          scene: 'GAME',
          mode: 'SINGLE',
          cancelledAt: null,
          continuedAt: null,
          startsAt: { lte: now },
          seats: { some: { registration: { is: null } } }
        },
        select: { id: true },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: 100
      })
    )) ?? [];
  for (const candidate of candidates) {
    if (state.stopping()) break;
    const changed = await runMaintenanceItem(state, 'activity.cancel', candidate.id, () =>
      db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`activity:${candidate.id}`}, 0))::text`;
          const row = await tx.activity.findUnique({
            where: { id: candidate.id },
            include: {
              seats: { orderBy: { position: 'asc' }, include: { registration: true } }
            }
          });
          if (
            !row ||
            (row.scene !== undefined && row.scene !== 'GAME') ||
            (row.mode !== undefined && row.mode !== 'SINGLE') ||
            row.cancelledAt ||
            row.continuedAt ||
            row.startsAt > now ||
            row.seats.every((seat) => seat.registration)
          )
            return;
          const active = row.seats.filter((seat) => seat.registration);
          const reason = 'RECRUITMENT_UNDECIDED';
          await tx.activity.update({
            where: { id: row.id },
            data: { cancelledAt: now, cancellationReason: reason, revision: { increment: 1 } }
          });
          for (const seat of active)
            await tx.activityRegistration.update({
              where: { id: seat.registration!.id },
              data: {
                status: 'CANCELLED',
                seatId: null,
                exitedAt: now,
                seatSnapshot: json({
                  id: seat.id,
                  position: seat.position,
                  groupKey: seat.groupKey,
                  kind: seat.kind,
                  role: seat.role,
                  job: seat.job
                })
              }
            });
          const payload = {
            activityTitle: row.title,
            oldStartsAt: row.startsAt.toISOString(),
            reason,
            activityLink: `/activities/${row.id}`
          };
          for (const recipientId of new Set(active.map((seat) => seat.registration!.accountId))) {
            await tx.activityOutbox.create({
              data: {
                eventKey: `activity-cancelled:${row.id}:${recipientId}`,
                activityId: row.id,
                kind: 'ACTIVITY_CANCELLED',
                channel: 'IN_APP',
                recipientId,
                payload,
                createdAt: now,
                mockDelivery: { create: { deliveredAt: now } }
              }
            });
          }
          await tx.activityOutbox.create({
            data: {
              eventKey: `activity-cancelled:${row.id}:qq`,
              activityId: row.id,
              kind: 'ACTIVITY_CANCELLED',
              channel: 'QQ',
              payload,
              createdAt: now,
              mockDelivery: { create: { deliveredAt: now } }
            }
          });
          await tx.activityCommand.create({
            data: {
              activityId: row.id,
              actorId: null,
              idempotencyKey: row.id,
              requestFingerprint: `auto-cancel:${row.startsAt.toISOString()}`,
              kind: 'AUTO_CANCEL',
              before: json({
                revision: row.revision,
                startsAt: row.startsAt,
                registeredCount: active.length
              }),
              after: json({ revision: row.revision + 1, cancelledAt: now, reason }),
              createdAt: now
            }
          });
          await enqueueConfiguredQqActivityNotifications(tx, row.id, 'CANCELLED', now);
          return true;
        },
        { maxWait: 5000, timeout: 15000 }
      )
    );
    if (changed) cancelled++;
  }
  const series = (await runMaintenanceItem(state, 'activity.series.scan', 'batch', () =>
    processSeriesRecruitment(db, suppliedNow ?? (() => new Date()), state)
  )) ?? { cancelled: 0, ready: 0 };
  const autoAbsent =
    (await runMaintenanceItem(state, 'activity.autoAbsent.scan', 'batch', () =>
      processActivityAutoAbsences(db, suppliedNow, state)
    )) ?? 0;
  const completed =
    (await runMaintenanceItem(state, 'activity.completion.scan', 'batch', () =>
      processActivityCompletions(db, suppliedNow ?? new Date(), state)
    )) ?? 0;
  return {
    reduced,
    cancelled,
    completed,
    autoAbsent,
    seriesCancelled: series.cancelled,
    seriesReady: series.ready,
    failed: state.failed - failuresBefore
  };
}
