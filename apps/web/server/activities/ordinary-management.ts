import { notifyQqActivity } from '../qq-official/notifications';
import type { Prisma } from '@artzoo/db';
import {
  AccountError,
  activityId,
  jobMeetsSeat,
  parseBeijingActivityTime,
  validateOrdinaryManagement,
  type OrdinaryManagementInput,
  type ActivityWriteResult,
  type SeatRequirement
} from '@artzoo/domain';
import { tokenDigest } from '../auth/crypto';
import { ActivityService, activitySelect } from './service';
import { OrdinaryActivityEditingService } from './ordinary-editing';
type Tx = Prisma.TransactionClient;
type Row = Prisma.ActivityGetPayload<{ select: typeof activitySelect }>;
type Actor = Awaited<ReturnType<ActivityService['auth']['requireAccount']>>;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const fail = (message: string, status = 403) =>
  new AccountError(status === 409 ? 'CONFLICT' : 'FORBIDDEN', message, status);
function snapshot(row: Row) {
  return json({
    revision: row.revision,
    scene: row.scene,
    mode: row.mode,
    seriesId: row.seriesId,
    periodNumber: row.periodNumber,
    seriesState: row.series?.state,
    title: row.title,
    description: row.description,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    registrationClosesAt: row.registrationClosesAt,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    seats: row.seats.map((seat) => ({
      id: seat.id,
      position: seat.position,
      groupKey: seat.groupKey,
      kind: seat.kind,
      role: seat.role,
      job: seat.job,
      registration: seat.registration
        ? { id: seat.registration.id, accountId: seat.registration.accountId, job: seat.registration.job }
        : null
    }))
  });
}
function seatSnapshot(seat: Row['seats'][number]) {
  return json({
    id: seat.id,
    position: seat.position,
    groupKey: seat.groupKey,
    kind: seat.kind,
    role: seat.role,
    job: seat.job
  });
}
function requirement(seat: Row['seats'][number]): SeatRequirement {
  return seat.kind === 'ROLE' && seat.role
    ? { kind: 'ROLE', role: seat.role }
    : seat.kind === 'JOB' && seat.job
      ? { kind: 'JOB', job: seat.job }
      : { kind: 'ANY' };
}
/** Only the newly approved ordinary-series/offline management. Never delegates to game-single penalties. */
export class OrdinaryActivityManagementService extends ActivityService {
  private boundary(row: Row, input: OrdinaryManagementInput, now: Date): AccountError | null {
    if (row.cancelledAt || row.series?.state === 'CANCELLED') return fail('活动已取消');
    if (input.action === 'withdraw' || input.action === 'move') {
      if (row.mode === 'SERIES' && (row.periodNumber !== 1 || row.series?.state !== 'RECRUITING'))
        return fail('长期活动已锁定名单，不能在此退出或换位');
      const cutoff = row.registrationClosesAt ?? new Date(row.startsAt.getTime() - 30 * 60000);
      if (now >= cutoff || now >= row.startsAt) return fail('报名已截止，不能退出或换位');
    } else {
      if (now >= row.startsAt) return fail('活动已开始，不能取消或修改');
      if (input.action === 'reschedule') {
        if (row.mode !== 'SERIES' || row.series?.state !== 'FORMED' || !row.series.formedAt)
          return fail('仅已成团的未来期次可以协商改期');
        if (parseBeijingActivityTime(input.startsAt, 'startsAt') <= now)
          return fail('新的开始时间须晚于当前时间');
      }
    }
    return null;
  }
  private async finish(tx: Tx, token: string | null | undefined, actor: Actor) {
    const final = await this.auth.requireAccount(tx, token);
    if (
      final.expiresAt <= this.auth.now() ||
      final.id !== actor.id ||
      final.accountId !== actor.accountId ||
      final.account.membership !== actor.account.membership ||
      final.account.adminRole !== actor.account.adminRole
    )
      throw new AccountError('UNAUTHENTICATED', '登录状态已变化，请刷新后重试', 401);
  }
  async execute(
    id: string,
    action: unknown,
    body: Record<string, unknown>,
    token?: string | null
  ): Promise<ActivityWriteResult> {
    if (action === 'description' || action === 'edit')
      return new OrdinaryActivityEditingService(this.auth).execute(id, action, body, token);
    const key = activityId(id),
      input = validateOrdinaryManagement(action, body),
      actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`activity-manage:${actor.accountId}`, 120, 900);
    const result = await this.auth.transaction(async (tx) => {
      const fresh = await this.actorLocked(tx, token, actor);
      // Match signup, formation, reconciliation and worker: account -> series -> ordered periods.
      await this.lockActivityScope(tx, key);
      await this.auth.requireAccount(tx, token);
      const row = await tx.activity.findUnique({ where: { id: key }, select: activitySelect });
      if (!row) throw new AccountError('NOT_FOUND', '活动不存在', 404);
      if (
        !(row.scene === 'OFFLINE' && row.mode === 'SINGLE') &&
        !(row.scene === 'GAME' && row.mode === 'SERIES' && row.seriesId)
      )
        return fail('该活动不支持此管理操作');
      if (input.action === 'move' && row.mode !== 'SERIES') return fail('线下报名不使用职业换位');
      if (input.action === 'cancel' && row.scene !== 'OFFLINE') return fail('长期活动请使用协商取消本期');
      if (input.action === 'reschedule' && row.mode !== 'SERIES') return fail('该活动不支持此协商改期操作');
      if (input.action !== 'withdraw' && input.action !== 'move' && row.organizerId !== fresh.accountId)
        return fail('仅活动发起者可以执行此操作');
      const fingerprint = tokenDigest(JSON.stringify({ kind: 'ORDINARY_MANAGEMENT', input }));
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
        if (previous.requestFingerprint !== fingerprint)
          return fail('本次提交内容已变化，请刷新后重新确认', 409);
        const activity = await this.read(tx, key, fresh.accountId);
        await this.finish(tx, token, fresh);
        return { activity, replayed: true };
      }
      // Return business errors so any recruitment cancellation reconciled under these locks stays committed.
      const boundary = this.boundary(row, input, this.auth.now());
      if (boundary) return boundary;
      if (row.revision !== input.expectedRevision) return fail('活动或报名已变化，请刷新后重新确认', 409);
      const own = row.seats.find((seat) => seat.registration?.accountId === fresh.accountId);
      if (
        (input.action === 'withdraw' || input.action === 'move') &&
        (!own?.registration || own.registration.id !== input.expectedRegistrationId)
      )
        return fail('你的报名已变化，请刷新后重新确认', 409);
      if (input.action === 'move') {
        if (own!.id !== input.expectedSeatId) return fail('你的席位已变化，请刷新后重新选择', 409);
        const seat = row.seats.find((item) => item.id === input.seatId);
        if (!seat || seat.registration || seat.id === own!.id) return fail('请选择其他空席位', 409);
        if (
          row.category === 'SOCIAL'
            ? input.job !== null
            : !input.job || !jobMeetsSeat(requirement(seat), input.job)
        )
          return fail('职业不符合目标席位要求', 409);
      }
      const now = this.auth.now();
      const lastBoundary = this.boundary(row, input, now);
      if (lastBoundary) return lastBoundary;
      if (input.action === 'withdraw') {
        await tx.activityRegistration.update({
          where: { id: input.expectedRegistrationId },
          data: {
            status: 'WITHDRAWN',
            exitedAt: now,
            seatId: null,
            seatSnapshot: seatSnapshot(own!)
          }
        });
        await this.event(
          tx,
          {
            eventKey: `ordinary-withdrawn:${input.expectedRegistrationId}`,
            activityId: key,
            registrationId: input.expectedRegistrationId,
            kind: 'REGISTRATION_WITHDRAWN',
            channel: 'IN_APP',
            recipientId: row.organizerId,
            payload: {
              activityTitle: row.title,
              activityLink: `/activities/${key}`,
              scene: row.scene,
              seriesId: row.seriesId
            }
          },
          now
        );
      } else if (input.action === 'move') {
        const changed = await tx.activityRegistration.updateMany({
          where: {
            id: input.expectedRegistrationId,
            activityId: key,
            accountId: fresh.accountId,
            seatId: input.expectedSeatId,
            status: 'ACTIVE'
          },
          data: { seatId: input.seatId, job: input.job }
        });
        if (changed.count !== 1) throw fail('你的报名已变化，请刷新后重新选择', 409);
      } else if (input.action === 'cancel') {
        await tx.activity.update({
          where: { id: key },
          data: { cancelledAt: now, cancellationReason: 'ORGANIZER_CANCELLED' }
        });
        const active = row.seats.filter((seat) => seat.registration);
        for (const seat of active)
          await tx.activityRegistration.update({
            where: { id: seat.registration!.id },
            data: { status: 'CANCELLED', exitedAt: now, seatId: null, seatSnapshot: seatSnapshot(seat) }
          });
        for (const recipientId of new Set(active.map((seat) => seat.registration!.accountId)))
          await this.event(
            tx,
            {
              eventKey: `offline-cancelled:${key}:${recipientId}`,
              activityId: key,
              kind: 'ACTIVITY_CANCELLED',
              channel: 'IN_APP',
              recipientId,
              payload: {
                activityTitle: row.title,
                oldStartsAt: row.startsAt.toISOString(),
                activityLink: `/activities/${key}`,
                scene: 'OFFLINE'
              }
            },
            now
          );
      } else {
        await tx.activity.update({
          where: { id: key },
          data: {
            startsAt: parseBeijingActivityTime(input.startsAt, 'startsAt'),
            endsAt: parseBeijingActivityTime(input.endsAt, 'endsAt'),
            registrationClosesAt: new Date(Date.parse(input.startsAt) - 30 * 60000)
          }
        });
        for (const recipientId of new Set(
          row.seats.flatMap((seat) => (seat.registration ? [seat.registration.accountId] : []))
        ))
          await this.event(
            tx,
            {
              eventKey: `series-period-rescheduled:${key}:${row.revision + 1}:${recipientId}`,
              activityId: key,
              kind: 'ACTIVITY_RESCHEDULED',
              channel: 'IN_APP',
              recipientId,
              payload: {
                activityTitle: row.title,
                activityLink: `/activities/${key}`,
                seriesId: row.seriesId,
                periodNumber: row.periodNumber,
                oldStartsAt: row.startsAt.toISOString(),
                oldEndsAt: row.endsAt.toISOString(),
                newStartsAt: input.startsAt,
                newEndsAt: input.endsAt,
                allMembersAgreed: true
              }
            },
            now
          );
      }
      await tx.activity.update({ where: { id: key }, data: { revision: { increment: 1 } } });
      const after = await tx.activity.findUniqueOrThrow({ where: { id: key }, select: activitySelect });
      const kind =
        input.action === 'reschedule'
          ? 'SERIES_RESCHEDULE_PERIOD'
          : input.action === 'cancel'
            ? 'OFFLINE_CANCEL'
            : input.action === 'move'
              ? 'ORDINARY_MOVE'
              : 'ORDINARY_WITHDRAW';
      await tx.activityCommand.create({
        data: {
          activityId: key,
          actorId: fresh.accountId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          kind,
          before: snapshot(row),
          after: json({
            snapshot: snapshot(after),
            penaltyPoints: 0,
            ...(input.action === 'reschedule' ? { allMembersAgreed: true } : {})
          }),
          createdAt: now
        }
      });
      if (input.action === 'cancel' || input.action === 'reschedule')
        await notifyQqActivity(tx, key, input.action === 'cancel' ? 'CANCELLED' : 'CHANGED', now);
      // The command INSERT/events can wait after eligibility was checked. Recheck both clocks at the final write.
      const finalBoundary = this.boundary(row, input, this.auth.now());
      if (finalBoundary) throw finalBoundary;
      await this.finish(tx, token, fresh);
      const activity = await this.read(tx, key, fresh.accountId);
      await this.finish(tx, token, fresh);
      const resultBoundary = this.boundary(row, input, this.auth.now());
      if (resultBoundary) throw resultBoundary;
      return { activity, replayed: false };
    });
    if (result instanceof AccountError) throw result;
    return result;
  }
}
