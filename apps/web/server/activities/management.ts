import { notifyQqActivity } from '../qq-official/notifications';
import { addActivityPenaltyPoints, type Prisma } from '@artzoo/db';
import {
  AccountError,
  activityId,
  parseBeijingActivityTime,
  assertActivitySeatEditPreservesRegistrations,
  validateActivityCancellation,
  validateActivityContinuation,
  validateActivityWithdrawal,
  validateActivityEdit,
  activityWithdrawalPenalty,
  activityCancellationPenalty,
  type ActivityManagementCommand,
  type EditActivityInput,
  type ActivityWriteResult,
  type DutySnapshot
} from '@artzoo/domain';
import { lock } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import { ActivityService, activityDetail, activitySelect } from './service';

type Tx = Prisma.TransactionClient;
type Row = Prisma.ActivityGetPayload<{ select: typeof activitySelect }>;
type Seat = Row['seats'][number];
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const conflict = (message: string): never => {
  throw new AccountError('CONFLICT', message, 409);
};
const forbidden = (message: string): never => {
  throw new AccountError('FORBIDDEN', message, 403);
};
function seatSnapshot(seat: Seat) {
  return json({
    id: seat.id,
    position: seat.position,
    groupKey: seat.groupKey,
    kind: seat.kind,
    role: seat.role,
    job: seat.job
  });
}
function snapshot(row: Row) {
  return json({
    revision: row.revision,
    title: row.title,
    description: row.description,
    category: row.category,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    duty: row.dutySnapshot,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    continuedAt: row.continuedAt,
    seats: row.seats.map((seat) => ({
      id: seat.id,
      position: seat.position,
      groupKey: seat.groupKey,
      kind: seat.kind,
      role: seat.role,
      job: seat.job,
      registrationId: seat.registration?.id ?? null
    }))
  });
}

export class ActivityManagementService extends ActivityService {
  private async run(
    id: string,
    input: ActivityManagementCommand,
    token: string | null | undefined,
    kind: 'WITHDRAW' | 'CANCEL' | 'EDIT' | 'CONTINUE',
    mutate: (tx: Tx, row: Row, actorId: string, now: Date) => Promise<void>
  ): Promise<ActivityWriteResult> {
    const key = activityId(id),
      actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`activity-manage:${actor.accountId}`, 120, 900);
    return this.auth.transaction(async (tx) => {
      const fresh = await this.actorLocked(tx, token, actor);
      await lock(tx, `activity:${key}`);
      await this.auth.requireAccount(tx, token);
      const fingerprint = tokenDigest(JSON.stringify({ kind, input }));
      const previous = await tx.activityCommand.findUnique({
        where: {
          activityId_actorId_idempotencyKey: {
            activityId: key,
            actorId: fresh.accountId,
            idempotencyKey: input.idempotencyKey
          }
        },
        select: { requestFingerprint: true }
      });
      if (previous) {
        if (previous.requestFingerprint !== fingerprint) conflict('本次操作内容已变化，请刷新后重新提交');
        return { activity: await this.read(tx, key, fresh.accountId), replayed: true };
      }
      const row = await tx.activity.findUnique({ where: { id: key }, select: activitySelect });
      if (!row) throw new AccountError('NOT_FOUND', '活动不存在', 404);
      if (row.scene === 'OFFLINE' || row.mode === 'SERIES') forbidden('该活动不支持普通单次管理操作');
      if (kind !== 'WITHDRAW' && row.organizerId !== fresh.accountId) forbidden('仅活动发起者可以执行此操作');
      if (row.cancelledAt) forbidden('活动已取消');
      // Lifecycle guards use trusted time after all lock/auth waits. Signup's entry-time policy remains separate.
      const now = this.auth.now();
      if (now >= row.startsAt) forbidden('活动已开始，不能退出、取消或修改');
      if (row.revision !== input.expectedRevision) conflict('活动已更新，请刷新后重新确认');
      await mutate(tx, row, fresh.accountId, now);
      await tx.activity.update({ where: { id: key }, data: { revision: { increment: 1 } } });
      const after = await tx.activity.findUniqueOrThrow({ where: { id: key }, select: activitySelect });
      await tx.activityCommand.create({
        data: {
          activityId: key,
          actorId: fresh.accountId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          kind,
          before: snapshot(row),
          after: snapshot(after),
          createdAt: now
        }
      });
      if (kind === 'CANCEL' || kind === 'EDIT')
        await notifyQqActivity(tx, key, kind === 'CANCEL' ? 'CANCELLED' : 'CHANGED', now);
      return { activity: activityDetail(after, fresh.accountId, this.auth.now()), replayed: false };
    });
  }
  private async penalty(
    tx: Tx,
    row: Row,
    accountId: string,
    points: 1 | 2,
    reason: 'LATE_WITHDRAWAL' | 'LATE_CANCELLATION',
    eventKey: string,
    now: Date,
    registrationId?: string
  ) {
    const penalty = await tx.activityPenalty.create({
      data: { eventKey, accountId, activityId: row.id, registrationId, points, reason, createdAt: now },
      select: { id: true }
    });
    const standing = await addActivityPenaltyPoints(tx, accountId, points, now, eventKey, penalty.id);
    await this.event(
      tx,
      {
        eventKey: `penalty-notice:${eventKey}`,
        activityId: row.id,
        registrationId,
        kind: 'ACTIVITY_PENALTY',
        channel: 'IN_APP',
        recipientId: accountId,
        payload: {
          points,
          totalPoints: standing.points,
          reason,
          activityTitle: row.title,
          activityLink: `/activities/${row.id}`
        }
      },
      now
    );
  }
  async withdraw(id: string, body: Record<string, unknown>, token?: string | null) {
    const input = validateActivityWithdrawal(body);
    return this.run(id, input, token, 'WITHDRAW', async (tx, row, actorId, now) => {
      const seat = row.seats.find((item) => item.registration?.accountId === actorId);
      if (!seat?.registration || seat.registration.id !== input.expectedRegistrationId)
        conflict('你的报名已变化，请刷新后重新确认');
      const own = await tx.activityRegistration.findUniqueOrThrow({
        where: { id: input.expectedRegistrationId },
        select: { rescheduleExitAllowed: true }
      });
      now = this.auth.now();
      if (now >= row.startsAt) forbidden('活动已开始，不能退出报名');
      const points = activityWithdrawalPenalty(row.startsAt, now, own.rescheduleExitAllowed);
      if (points !== input.expectedPenaltyPoints)
        conflict(`处罚预期已变化，本次${points ? '将记1点' : '无责'}，请重新确认`);
      await tx.activityRegistration.update({
        where: { id: input.expectedRegistrationId },
        data: {
          status: 'WITHDRAWN',
          exitedAt: now,
          seatId: null,
          seatSnapshot: seatSnapshot(seat!)
        }
      });
      if (points)
        await this.penalty(
          tx,
          row,
          actorId,
          1,
          'LATE_WITHDRAWAL',
          `late-withdrawal:${input.expectedRegistrationId}`,
          now,
          input.expectedRegistrationId
        );
      await this.event(
        tx,
        {
          eventKey: `registration-withdrawn:${input.expectedRegistrationId}`,
          activityId: row.id,
          registrationId: input.expectedRegistrationId,
          kind: 'REGISTRATION_WITHDRAWN',
          channel: 'IN_APP',
          recipientId: row.organizerId,
          payload: { activityTitle: row.title, activityLink: `/activities/${row.id}` }
        },
        now
      );
    });
  }
  async cancel(id: string, body: Record<string, unknown>, token?: string | null) {
    const input = validateActivityCancellation(body);
    return this.run(id, input, token, 'CANCEL', async (tx, row, actorId, now) => {
      const active = row.seats.filter((seat) => seat.registration);
      const shortage =
        now.getTime() >= row.startsAt.getTime() - 30 * 60000 &&
        active.length < row.seats.length &&
        !row.continuedAt;
      const reason = shortage ? 'RECRUITMENT_SHORTAGE' : 'ORGANIZER_CANCELLED';
      const points = activityCancellationPenalty(
        row.startsAt,
        now,
        active.length,
        row.seats.length,
        !!row.continuedAt
      );
      if (points !== input.expectedPenaltyPoints)
        conflict(`处罚预期已变化，本次${points ? '将记2点' : '无责'}，请重新确认`);
      await tx.activity.update({
        where: { id: row.id },
        data: { cancelledAt: now, cancellationReason: reason }
      });
      for (const seat of active)
        await tx.activityRegistration.update({
          where: { id: seat.registration!.id },
          data: { status: 'CANCELLED', exitedAt: now, seatId: null, seatSnapshot: seatSnapshot(seat) }
        });
      if (points) {
        await this.penalty(tx, row, actorId, 2, 'LATE_CANCELLATION', `late-cancellation:${row.id}`, now);
      }
      const payload = {
        activityTitle: row.title,
        oldStartsAt: row.startsAt.toISOString(),
        reason,
        activityLink: `/activities/${row.id}`
      };
      for (const recipientId of new Set(active.map((seat) => seat.registration!.accountId))) {
        await this.event(
          tx,
          {
            eventKey: `activity-cancelled:${row.id}:${recipientId}`,
            activityId: row.id,
            kind: 'ACTIVITY_CANCELLED',
            channel: 'IN_APP',
            recipientId,
            payload
          },
          now
        );
      }
      await this.event(
        tx,
        {
          eventKey: `activity-cancelled:${row.id}:qq`,
          activityId: row.id,
          kind: 'ACTIVITY_CANCELLED',
          channel: 'QQ',
          payload
        },
        now
      );
    });
  }
  async continueActivity(id: string, body: Record<string, unknown>, token?: string | null) {
    const input = validateActivityContinuation(body);
    return this.run(id, input, token, 'CONTINUE', async (tx, row, _actorId, now) => {
      if (
        now.getTime() < row.startsAt.getTime() - 30 * 60000 ||
        row.seats.every((seat) => seat.registration)
      ) {
        forbidden('仅报名截止后未满员的活动可以确认继续举行');
      }
      if (row.continuedAt) conflict('已确认继续举行，请刷新活动');
      await tx.activity.update({ where: { id: row.id }, data: { continuedAt: now } });
    });
  }
  private async editedDuty(input: EditActivityInput, row: Row): Promise<DutySnapshot | null> {
    const prior = row.dutySnapshot as unknown as DutySnapshot | null;
    const selection = input.dutySelection;
    const same =
      prior &&
      selection &&
      (selection.type === 'OTHER'
        ? prior.type === 'OTHER' &&
          prior.name === selection.name &&
          prior.partyComposition === selection.partyComposition
        : prior.id === selection.dutyId && prior.type === selection.type);
    if (!same) return this.resolveDuty({ ...input, seats: input.seats.map((seat) => seat.requirement) });
    if (prior.partyComposition !== 'CUSTOM' && input.seats.length !== prior.capacity) {
      throw new AccountError('VALIDATION_ERROR', '席位人数必须符合已保存副本编制', 400, {
        seats: '席位人数不符'
      });
    }
    return {
      ...prior,
      capacity: input.seats.length,
      finalSeats: input.seats.map((seat, index) => ({
        requirement: seat.requirement,
        groupKey: prior.finalSeats[index]?.groupKey ?? null
      }))
    };
  }
  async edit(id: string, body: Record<string, unknown>, token?: string | null) {
    const input = validateActivityEdit(body);
    return this.run(id, input, token, 'EDIT', async (tx, row, _actorId, now) => {
      const startsAt = parseBeijingActivityTime(input.startsAt, 'startsAt');
      if (startsAt <= now) forbidden('预定开始须晚于当前时间');
      const changedTime = startsAt.getTime() !== row.startsAt.getTime();
      const active = row.seats.filter((seat) => seat.registration);
      if (changedTime && active.length && row.startsAt.getTime() - now.getTime() < 4 * 3600000) {
        forbidden('已有报名且距原开始不足4小时，不能直接改期');
      }
      assertActivitySeatEditPreservesRegistrations(row.seats, input.seats, input.category);
      const duty = await this.editedDuty(input, row);
      const mutationAt = this.auth.now();
      if (mutationAt >= row.startsAt || startsAt <= mutationAt) forbidden('活动时间边界已变化，请刷新后重试');
      if (changedTime && active.length && row.startsAt.getTime() - mutationAt.getTime() < 4 * 3600000)
        forbidden('已有报名且距原开始不足4小时，不能直接改期');
      // All checks precede mutations. Deferral permits retained seat positions to change atomically.
      await tx.$executeRawUnsafe('SET CONSTRAINTS "ActivitySeat_activityId_position_key" DEFERRED');
      const retained = input.seats.flatMap((seat) => (seat.id ? [seat.id] : []));
      await tx.activitySeat.deleteMany({ where: { activityId: row.id, id: { notIn: retained } } });
      for (const [position, seat] of input.seats.entries()) {
        const data = {
          position,
          groupKey: duty?.finalSeats[position]?.groupKey ?? null,
          kind: seat.requirement.kind,
          role: seat.requirement.kind === 'ROLE' ? seat.requirement.role : null,
          job: seat.requirement.kind === 'JOB' ? seat.requirement.job : null
        };
        if (seat.id) await tx.activitySeat.update({ where: { id: seat.id }, data });
        else await tx.activitySeat.create({ data: { ...data, activityId: row.id } });
      }
      await tx.activity.update({
        where: { id: row.id },
        data: {
          title: input.title,
          description: input.description,
          category: input.category,
          startsAt,
          endsAt: parseBeijingActivityTime(input.endsAt, 'endsAt'),
          dutyId: duty?.id ?? null,
          ...(duty ? { dutySnapshot: json(duty) } : {}),
          ...(changedTime ? { continuedAt: null } : {})
        }
      });
      if (!duty) await tx.$executeRaw`UPDATE "Activity" SET "dutySnapshot" = NULL WHERE "id" = ${row.id}`;
      if (changedTime) {
        await tx.activityRegistration.updateMany({
          where: { activityId: row.id, status: 'ACTIVE' },
          data: { rescheduleExitAllowed: true }
        });
        const payload = {
          activityTitle: input.title,
          oldStartsAt: row.startsAt.toISOString(),
          newStartsAt: startsAt.toISOString(),
          activityLink: `/activities/${row.id}`,
          withdrawalWithoutPenalty: true
        };
        const eventBase = `activity-rescheduled:${row.id}:${row.revision + 1}`;
        for (const recipientId of new Set(active.map((seat) => seat.registration!.accountId))) {
          await this.event(
            tx,
            {
              eventKey: `${eventBase}:${recipientId}`,
              activityId: row.id,
              kind: 'ACTIVITY_RESCHEDULED',
              channel: 'IN_APP',
              recipientId,
              payload
            },
            now
          );
        }
        await this.event(
          tx,
          {
            eventKey: `${eventBase}:qq`,
            activityId: row.id,
            kind: 'ACTIVITY_RESCHEDULED',
            channel: 'QQ',
            payload
          },
          now
        );
      }
    });
  }
}
