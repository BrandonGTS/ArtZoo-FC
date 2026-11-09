import { createMaintenanceState, runMaintenanceItem, type MaintenanceRunState } from './maintenance-run.js';
import { enqueueConfiguredQqActivityNotifications } from './qq-official-notifications.js';
import type { Prisma, PrismaClient } from './generated/prisma/client.js';

type Tx = Prisma.TransactionClient;
export type SeriesClock = Date | (() => Date);
export interface SeriesRecruitmentResult {
  state: 'RECRUITING' | 'FORMED' | 'CANCELLED' | 'MISSING';
  action: 'NONE' | 'READY' | 'CANCELLED';
  firstActivityId?: string;
  reason?: 'SERIES_INSUFFICIENT' | 'SERIES_UNCONFIRMED';
}
const instant = (clock: SeriesClock) => (typeof clock === 'function' ? clock() : clock);
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

// Interactive callers hold Account before entering. Every series writer takes
// series -> activities (periodNumber, id), so the worker never needs Account locks.
export async function reconcileSeriesRecruitment(
  tx: Tx,
  seriesId: string,
  clock: SeriesClock = () => new Date()
): Promise<SeriesRecruitmentResult> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`series:${seriesId}`}, 0))::text`;
  const header = await tx.activitySeries.findUnique({
    where: { id: seriesId },
    select: {
      activities: { select: { id: true }, orderBy: [{ periodNumber: 'asc' }, { id: 'asc' }] }
    }
  });
  if (!header) return { state: 'MISSING', action: 'NONE' };
  for (const activity of header.activities) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`activity:${activity.id}`}, 0))::text`;
  }
  const series = await tx.activitySeries.findUnique({
    where: { id: seriesId },
    include: {
      activities: {
        orderBy: [{ periodNumber: 'asc' }, { id: 'asc' }],
        include: {
          seats: { orderBy: { position: 'asc' }, include: { registration: true } },
          registrations: { where: { status: 'ACTIVE' } }
        }
      }
    }
  });
  if (!series) return { state: 'MISSING', action: 'NONE' };
  const first = series.activities.find((activity) => activity.periodNumber === 1);
  const firstActivityId = first?.id;
  if (series.state === 'FORMED' || series.formedAt)
    return { state: 'FORMED', action: 'NONE', firstActivityId };
  if (series.state === 'CANCELLED' || series.cancelledAt)
    return { state: 'CANCELLED', action: 'NONE', firstActivityId };
  if (!first || first.scene !== 'GAME' || first.mode !== 'SERIES' || first.cancelledAt) {
    return { state: 'RECRUITING', action: 'NONE', firstActivityId };
  }
  // Resolve a live clock only after all shared locks; explicit Dates support deterministic runs.
  const now = instant(clock);
  const cutoff = new Date(first.startsAt.getTime() - 30 * 60_000);
  if (now < cutoff) return { state: 'RECRUITING', action: 'NONE', firstActivityId };
  const full = first.seats.length > 0 && first.seats.every((seat) => seat.registration?.status === 'ACTIVE');
  const reason = !full ? 'SERIES_INSUFFICIENT' : now >= first.startsAt ? 'SERIES_UNCONFIRMED' : null;
  if (!reason) {
    if (series.readyNotifiedAt) return { state: 'RECRUITING', action: 'NONE', firstActivityId };
    await tx.activitySeries.update({ where: { id: seriesId }, data: { readyNotifiedAt: now } });
    await tx.activityOutbox.upsert({
      where: { eventKey: `series-ready:${seriesId}` },
      update: {},
      create: {
        eventKey: `series-ready:${seriesId}`,
        activityId: first.id,
        kind: 'SERIES_READY',
        channel: 'IN_APP',
        recipientId: first.organizerId,
        payload: { seriesId, activityTitle: first.title, activityLink: `/activities/${first.id}` },
        createdAt: now,
        mockDelivery: { create: { deliveredAt: now } }
      }
    });
    // Nullable system actors do not provide PostgreSQL unique enforcement; the
    // series lock plus persisted transition marker makes this audit idempotent.
    await tx.activityCommand.create({
      data: {
        activityId: first.id,
        actorId: null,
        idempotencyKey: `series:${seriesId}:ready`,
        requestFingerprint: `series-ready:${seriesId}`,
        kind: 'SERIES_READY',
        before: json({ state: series.state, readyNotifiedAt: series.readyNotifiedAt }),
        after: json({ state: 'RECRUITING', readyNotifiedAt: now }),
        createdAt: now
      }
    });
    return { state: 'RECRUITING', action: 'READY', firstActivityId };
  }

  await tx.activitySeries.update({ where: { id: seriesId }, data: { state: 'CANCELLED', cancelledAt: now } });
  const recipients = new Set<string>();
  let registeredCount = 0;
  for (const activity of series.activities) {
    if (!activity.cancelledAt)
      await tx.activity.update({
        where: { id: activity.id },
        data: {
          cancelledAt: now,
          cancellationReason: reason,
          revision: { increment: 1 }
        }
      });
    for (const registration of activity.registrations) {
      recipients.add(registration.accountId);
      registeredCount++;
      const seat = activity.seats.find((item) => item.id === registration.seatId);
      await tx.activityRegistration.update({
        where: { id: registration.id },
        data: {
          status: 'CANCELLED',
          seatId: null,
          exitedAt: registration.exitedAt ?? now,
          ...(registration.seatSnapshot !== null
            ? {}
            : seat
              ? {
                  seatSnapshot: json({
                    id: seat.id,
                    position: seat.position,
                    groupKey: seat.groupKey,
                    kind: seat.kind,
                    role: seat.role,
                    job: seat.job
                  })
                }
              : {})
        }
      });
    }
  }
  for (const recipientId of recipients) {
    const eventKey = `series-cancelled:${seriesId}:${recipientId}`;
    await tx.activityOutbox.upsert({
      where: { eventKey },
      update: {},
      create: {
        eventKey,
        activityId: first.id,
        kind: 'ACTIVITY_CANCELLED',
        channel: 'IN_APP',
        recipientId,
        payload: {
          seriesId,
          activityTitle: first.title,
          oldStartsAt: first.startsAt.toISOString(),
          reason,
          activityLink: `/activities/${first.id}`
        },
        createdAt: now,
        mockDelivery: { create: { deliveredAt: now } }
      }
    });
  }
  await tx.activityCommand.create({
    data: {
      activityId: first.id,
      actorId: null,
      idempotencyKey: `series:${seriesId}:auto-cancel`,
      requestFingerprint: `series-auto-cancel:${seriesId}`,
      kind: 'SERIES_AUTO_CANCEL',
      before: json({ state: series.state, registeredCount }),
      after: json({ state: 'CANCELLED', cancelledAt: now, reason }),
      createdAt: now
    }
  });
  await enqueueConfiguredQqActivityNotifications(tx, first.id, 'CANCELLED', now);
  return { state: 'CANCELLED', action: 'CANCELLED', firstActivityId, reason };
}

export async function processSeriesRecruitment(
  db: PrismaClient,
  clock: SeriesClock = () => new Date(),
  state: MaintenanceRunState = createMaintenanceState()
) {
  const now = instant(clock);
  const candidates = await db.activitySeries.findMany({
    where: {
      state: 'RECRUITING',
      formedAt: null,
      cancelledAt: null,
      activities: {
        some: {
          periodNumber: 1,
          scene: 'GAME',
          mode: 'SERIES',
          cancelledAt: null,
          startsAt: { lte: new Date(now.getTime() + 30 * 60_000) }
        }
      },
      // Already-reminded full series have no work until start; do not let the
      // oldest hundred occupy every batch while other series need a transition.
      OR: [
        { readyNotifiedAt: null },
        { activities: { some: { periodNumber: 1, startsAt: { lte: now } } } },
        {
          activities: {
            some: {
              periodNumber: 1,
              OR: [
                { seats: { none: {} } },
                {
                  seats: {
                    some: {
                      OR: [
                        { registration: { is: null } },
                        { registration: { is: { status: { not: 'ACTIVE' } } } }
                      ]
                    }
                  }
                }
              ]
            }
          }
        }
      ]
    },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 100
  });
  let cancelled = 0,
    ready = 0;
  for (const candidate of candidates) {
    if (state.stopping()) break;
    const result = await runMaintenanceItem(state, 'activity.series', candidate.id, () =>
      db.$transaction((tx) => reconcileSeriesRecruitment(tx, candidate.id, clock), {
        maxWait: 5000,
        timeout: 15000
      })
    );
    if (result?.action === 'CANCELLED') cancelled++;
    if (result?.action === 'READY') ready++;
  }
  return { cancelled, ready };
}
