import type { Prisma } from './generated/prisma/client.js';

type Tx = Prisma.TransactionClient;
export interface ActivityStanding {
  points: number;
  decayAt: Date | null;
}
export const ACTIVITY_DECAY_INTERVAL = 7 * 86400000;

async function standing(tx: Tx, accountId: string): Promise<ActivityStanding> {
  const rows = await tx.$queryRaw<Array<{ activityPoints: number; activityDecayAt: Date | null }>>`
    SELECT "activityPoints", "activityDecayAt" FROM "Account" WHERE "id" = ${accountId} FOR NO KEY UPDATE`;
  if (!rows[0]) throw new Error('Activity standing account missing');
  return { points: rows[0].activityPoints, decayAt: rows[0].activityDecayAt };
}
// Caller holds the Account row lock; worker and interactive writes use the same primitive.
export async function settleActivityStanding(
  tx: Tx,
  accountId: string,
  now: Date,
  current?: ActivityStanding
): Promise<ActivityStanding & { reduced: boolean }> {
  const state = current ?? (await standing(tx, accountId));
  if (state.points < 3 || !state.decayAt || now < state.decayAt) return { ...state, reduced: false };
  const steps = Math.min(
    state.points - 2,
    Math.floor((now.getTime() - state.decayAt.getTime()) / ACTIVITY_DECAY_INTERVAL) + 1
  );
  const points = state.points - steps,
    decayAt = points >= 3 ? new Date(state.decayAt.getTime() + steps * ACTIVITY_DECAY_INTERVAL) : null;
  await tx.account.update({
    where: { id: accountId },
    data: { activityPoints: points, activityDecayAt: decayAt }
  });
  // One current simulated notice for settled state; no replayed historical notification stream.
  await tx.activityScoreChange.create({
    data: {
      eventKey: `natural-decay:${accountId}:${state.decayAt.toISOString()}`,
      accountId,
      delta: -steps,
      pointsBefore: state.points,
      pointsAfter: points,
      reason: 'NATURAL_DECAY',
      notices: points < 3 ? ['POINTS_CHANGED', 'RESTRICTION_ENDED'] : ['POINTS_CHANGED'],
      decayBefore: state.decayAt,
      decayAfter: decayAt,
      simulatedAt: now,
      createdAt: now
    }
  });
  return { points, decayAt, reduced: true };
}
export async function addActivityPenaltyPoints(
  tx: Tx,
  accountId: string,
  points: 1 | 2,
  now: Date,
  eventKey: string,
  penaltyId: string
): Promise<ActivityStanding> {
  const before = await settleActivityStanding(tx, accountId, now);
  const total = before.points + points;
  const entered = before.points < 3 && total >= 3;
  const decayAt = total >= 3 ? (before.decayAt ?? new Date(now.getTime() + ACTIVITY_DECAY_INTERVAL)) : null;
  await tx.account.update({
    where: { id: accountId },
    data: { activityPoints: total, activityDecayAt: decayAt }
  });
  await tx.activityScoreChange.create({
    data: {
      eventKey: `score:${eventKey}`,
      accountId,
      penaltyId,
      delta: points,
      pointsBefore: before.points,
      pointsAfter: total,
      reason: 'PENALTY',
      notices: entered ? ['RESTRICTION_STARTED'] : [],
      decayBefore: before.decayAt,
      decayAfter: decayAt,
      simulatedAt: now,
      createdAt: now
    }
  });
  return { points: total, decayAt };
}

export interface ScoreReplayEvent {
  reason: string;
  delta: number;
  simulatedAt: Date;
  penalty?: { reversedAt: Date | null } | null;
  completion?: { active: boolean } | null;
}
function settleValue(state: ActivityStanding, now: Date): ActivityStanding {
  if (state.points < 3 || !state.decayAt || now < state.decayAt) return { ...state };
  const steps = Math.min(
    state.points - 2,
    Math.floor((now.getTime() - state.decayAt.getTime()) / ACTIVITY_DECAY_INTERVAL) + 1
  );
  const points = state.points - steps;
  return {
    points,
    decayAt: points >= 3 ? new Date(state.decayAt.getTime() + steps * ACTIVITY_DECAY_INTERVAL) : null
  };
}
// Start at the earliest reversible original grant/evaluation, never at a later contaminated snapshot.
// Preserve independent completion events, including a nominal -1 whose original actual delta was zero.
export function replayActivityStanding(
  initial: ActivityStanding,
  events: readonly ScoreReplayEvent[],
  now: Date
): ActivityStanding {
  let state = { ...initial };
  for (const event of events) {
    state = settleValue(state, event.simulatedAt);
    if (
      event.reason === 'NATURAL_DECAY' ||
      event.reason === 'PENALTY_REVERSED' ||
      event.reason === 'COMPLETION_CORRECTED'
    )
      continue;
    if (event.reason === 'PENALTY') {
      if (event.penalty?.reversedAt) continue;
      if (event.delta <= 0) throw new Error('Invalid penalty score event');
      const points = state.points + event.delta;
      state = {
        points,
        decayAt:
          points >= 3
            ? (state.decayAt ?? new Date(event.simulatedAt.getTime() + ACTIVITY_DECAY_INTERVAL))
            : null
      };
    } else if (event.reason === 'NORMAL_COMPLETION') {
      if (event.completion && !event.completion.active) continue;
      const points = Math.max(0, state.points - 1);
      state = { points, decayAt: points >= 3 ? state.decayAt : null };
    } else throw new Error('Unsupported score event during correction');
  }
  return settleValue(state, now);
}
export async function reverseAttendancePenalty(
  tx: Tx,
  accountId: string,
  penaltyId: string,
  now: Date,
  reason: string
): Promise<ActivityStanding> {
  return reversePenalty(tx, accountId, penaltyId, now, reason, ['NO_SHOW']);
}
export async function reverseManagementPenalty(
  tx: Tx,
  accountId: string,
  penaltyId: string,
  now: Date,
  reason: string
): Promise<ActivityStanding> {
  return reversePenalty(tx, accountId, penaltyId, now, reason, [
    'LATE_WITHDRAWAL',
    'LATE_CANCELLATION',
    'SERIES_UNAGREED_ABSENCE',
    'SERIES_UNCOMMUNICATED_EXIT'
  ]);
}
async function reversePenalty(
  tx: Tx,
  accountId: string,
  penaltyId: string,
  now: Date,
  reason: string,
  allowedReasons: readonly string[]
): Promise<ActivityStanding> {
  const before = await settleActivityStanding(tx, accountId, now);
  const penalty = await tx.activityPenalty.findUniqueOrThrow({
    where: { id: penaltyId },
    select: {
      accountId: true,
      reason: true,
      reversedAt: true,
      activity: { select: { scene: true, mode: true } }
    }
  });
  if (
    ['SERIES_UNAGREED_ABSENCE', 'SERIES_UNCOMMUNICATED_EXIT'].includes(penalty.reason) &&
    (penalty.activity.scene !== 'GAME' || penalty.activity.mode !== 'SERIES')
  )
    throw new Error('Invalid reversible series penalty');
  if (penalty.accountId !== accountId || !allowedReasons.includes(penalty.reason))
    throw new Error('Invalid reversible penalty');
  if (penalty.reversedAt) return before;
  await tx.activityPenalty.update({
    where: { id: penaltyId },
    data: { reversedAt: now, reversalReason: reason }
  });
  return reconcileActivityStanding(tx, accountId, now, `reverse:${penaltyId}`, 'PENALTY_REVERSED', before);
}
// Include the earliest original evaluation even if it was disabled and later restored.
// Correction rows are audit deltas, never independent grants during replay.
export async function reconcileActivityStanding(
  tx: Tx,
  accountId: string,
  now: Date,
  eventKey: string,
  reason: 'PENALTY_REVERSED' | 'COMPLETION_CORRECTED',
  current?: ActivityStanding
): Promise<ActivityStanding> {
  const before = current ?? (await settleActivityStanding(tx, accountId, now));
  const anchor = await tx.activityScoreChange.findFirstOrThrow({
    where: {
      accountId,
      OR: [
        { reason: 'PENALTY', penalty: { is: { reason: 'NO_SHOW' } } },
        {
          reason: 'PENALTY',
          penalty: {
            is: { reason: { in: ['LATE_WITHDRAWAL', 'LATE_CANCELLATION'] }, reversedAt: { not: null } }
          }
        },
        {
          reason: 'PENALTY',
          penalty: {
            is: {
              reason: { in: ['SERIES_UNAGREED_ABSENCE', 'SERIES_UNCOMMUNICATED_EXIT'] },
              reversedAt: { not: null },
              activity: { is: { scene: 'GAME', mode: 'SERIES' } }
            }
          }
        },
        { reason: 'NORMAL_COMPLETION', completion: { isNot: null } }
      ]
    },
    orderBy: { sequence: 'asc' },
    select: { sequence: true, pointsBefore: true, decayBefore: true }
  });
  const events = await tx.activityScoreChange.findMany({
    where: { accountId, sequence: { gte: anchor.sequence } },
    orderBy: { sequence: 'asc' },
    select: {
      reason: true,
      delta: true,
      simulatedAt: true,
      penalty: { select: { reversedAt: true } },
      completion: { select: { active: true } }
    }
  });
  const after = replayActivityStanding(
    { points: anchor.pointsBefore, decayAt: anchor.decayBefore },
    events,
    now
  );
  await tx.account.update({
    where: { id: accountId },
    data: { activityPoints: after.points, activityDecayAt: after.decayAt }
  });
  await tx.activityScoreChange.create({
    data: {
      eventKey,
      accountId,
      delta: after.points - before.points,
      pointsBefore: before.points,
      pointsAfter: after.points,
      decayBefore: before.decayAt,
      decayAfter: after.decayAt,
      reason,
      notices: [
        'POINTS_CHANGED',
        ...(before.points >= 3 && after.points < 3 ? ['RESTRICTION_ENDED'] : []),
        ...(before.points < 3 && after.points >= 3 ? ['RESTRICTION_STARTED'] : [])
      ],
      simulatedAt: now,
      createdAt: now
    }
  });
  return after;
}
