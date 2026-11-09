import { notifyQqActivity } from '../qq-official/notifications';
import type { Prisma } from '@artzoo/db';
import {
  AccountError,
  activityId,
  parseBeijingActivityTime,
  validateOrdinaryEditing,
  type OrdinaryEditingInput,
  type ActivityWriteResult
} from '@artzoo/domain';
import { tokenDigest } from '../auth/crypto';
import { ActivityService, activitySelect } from './service';
type Tx = Prisma.TransactionClient;
type Row = Prisma.ActivityGetPayload<{ select: typeof activitySelect }>;
type Actor = Awaited<ReturnType<ActivityService['auth']['requireAccount']>>;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const fail = (message: string, status = 403) =>
  new AccountError(status === 409 ? 'CONFLICT' : 'FORBIDDEN', message, status);
function snapshot(row: Row) {
  return json({
    id: row.id,
    revision: row.revision,
    title: row.title,
    description: row.description,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    registrationClosesAt: row.registrationClosesAt,
    location: row.location,
    meetingInstructions: row.meetingInstructions,
    capacityUnlimited: row.capacityUnlimited,
    seats: row.seats.map((seat) => ({
      id: seat.id,
      position: seat.position,
      kind: seat.kind,
      role: seat.role,
      job: seat.job,
      registration: seat.registration
        ? { id: seat.registration.id, accountId: seat.registration.accountId }
        : null
    }))
  });
}
export class OrdinaryActivityEditingService extends ActivityService {
  private async finish(tx: Tx, token: string | null | undefined, actor: Actor) {
    const fresh = await this.auth.requireAccount(tx, token);
    if (
      fresh.expiresAt <= this.auth.now() ||
      fresh.id !== actor.id ||
      fresh.accountId !== actor.accountId ||
      fresh.account.membership !== actor.account.membership ||
      fresh.account.adminRole !== actor.account.adminRole
    )
      throw new AccountError('UNAUTHENTICATED', '登录状态已变化，请刷新后重试', 401);
  }
  private offlineBoundary(
    row: Row,
    input: Extract<OrdinaryEditingInput, { action: 'edit' }>,
    now: Date
  ): AccountError | null {
    if (row.cancelledAt) return fail('活动已取消');
    if (now >= row.startsAt || parseBeijingActivityTime(input.startsAt, 'startsAt') <= now)
      return fail('活动时间边界已变化，不能修改');
    const oldCutoff = row.registrationClosesAt ?? new Date(row.startsAt.getTime() - 1800000);
    if (
      now >= oldCutoff &&
      parseBeijingActivityTime(input.registrationClosesAt, 'registrationClosesAt') > now
    )
      return fail('报名已截止，不能延长截止时间重新开放报名');
    return null;
  }
  async execute(
    id: string,
    action: unknown,
    body: Record<string, unknown>,
    token?: string | null
  ): Promise<ActivityWriteResult> {
    const key = activityId(id),
      input = validateOrdinaryEditing(action, body),
      actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`activity-manage:${actor.accountId}`, 120, 900);
    const result = await this.auth.transaction(async (tx) => {
      const fresh = await this.actorLocked(tx, token, actor);
      await this.lockActivityScope(tx, key);
      await this.finish(tx, token, fresh);
      const row = await tx.activity.findUnique({ where: { id: key }, select: activitySelect });
      if (!row) throw new AccountError('NOT_FOUND', '活动不存在', 404);
      if (row.organizerId !== fresh.accountId) return fail('仅活动发起者可以修改');
      if (
        input.action === 'description'
          ? row.scene !== 'GAME' || row.mode !== 'SERIES' || !row.seriesId
          : row.scene !== 'OFFLINE' || row.mode !== 'SINGLE'
      )
        return fail('该活动不支持此编辑操作');
      const fingerprint = tokenDigest(JSON.stringify({ kind: 'ORDINARY_EDITING', anchorId: key, input }));
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
        if (previous.requestFingerprint !== fingerprint) return fail('本次提交内容已变化，请重新确认', 409);
        const activity = await this.read(tx, key, fresh.accountId);
        await this.finish(tx, token, fresh);
        return { activity, replayed: true };
      }
      if (row.cancelledAt || row.series?.state === 'CANCELLED') return fail('活动已取消');
      if (row.revision !== input.expectedRevision) return fail('活动或报名已变化，请刷新后重新确认', 409);
      if (input.action === 'description') {
        if (row.series?.state !== 'FORMED' || !row.series.formedAt)
          return fail('仅已成团的长期活动可以修改未来期次说明');
        const periods = await tx.activity.findMany({
          where: { seriesId: row.seriesId! },
          orderBy: [{ periodNumber: 'asc' }, { id: 'asc' }],
          select: activitySelect
        });
        if (
          periods.some(
            (period) =>
              period.organizerId !== fresh.accountId || period.scene !== 'GAME' || period.mode !== 'SERIES'
          )
        )
          return fail('系列期次状态不一致，请刷新后重试', 409);
        const expected = new Map(input.expectedPeriods.map((item) => [item.id, item.revision]));
        if (
          periods.length !== expected.size ||
          periods.some((period) => expected.get(period.id) !== period.revision)
        )
          return fail('系列期次已变化，请刷新后重新确认', 409);
        const collision = await tx.activityCommand.findFirst({
          where: {
            activityId: { in: periods.map((period) => period.id) },
            actorId: fresh.accountId,
            idempotencyKey: input.idempotencyKey
          },
          select: { id: true }
        });
        if (collision) return fail('本次提交标识已用于其他期次，请重新确认', 409);
        const now = this.auth.now(),
          targets = periods.filter((period) => !period.cancelledAt && period.startsAt > now);
        if (!targets.length) return fail('没有尚未开始的期次可以修改');
        for (const period of targets)
          await tx.activity.update({
            where: { id: period.id },
            data: { description: input.description, revision: { increment: 1 } }
          });
        const auditIds = [...new Set([key, ...targets.map((period) => period.id)])];
        for (const activityId of auditIds) {
          const before = periods.find((period) => period.id === activityId)!;
          const affected = targets.some((period) => period.id === activityId);
          await tx.activityCommand.create({
            data: {
              activityId,
              actorId: fresh.accountId,
              idempotencyKey: input.idempotencyKey,
              requestFingerprint: fingerprint,
              kind: 'SERIES_DESCRIPTION_EDIT',
              before: snapshot(before),
              after: json({
                anchorId: key,
                updatedPeriodIds: targets.map((period) => period.id),
                description: affected ? input.description : before.description,
                revision: before.revision + (affected ? 1 : 0),
                contentChanged: affected,
                penaltyPoints: 0
              }),
              createdAt: now
            }
          });
        }
        if (targets[0]) await notifyQqActivity(tx, targets[0].id, 'CHANGED', now);
        const boundary = () => {
          if (targets.some((period) => this.auth.now() >= period.startsAt))
            throw fail('期次已开始，请刷新后重新确认要修改的未来期次');
        };
        boundary();
        const activity = await this.read(tx, key, fresh.accountId);
        await this.finish(tx, token, fresh);
        boundary();
        return { activity, replayed: false };
      }
      let boundary = this.offlineBoundary(row, input, this.auth.now());
      if (boundary) return boundary;
      const active = row.seats.filter((seat) => seat.registration),
        capacity = input.capacity;
      if (capacity !== null && capacity < active.length) return fail('人数上限不能低于已报名人数', 409);
      boundary = this.offlineBoundary(row, input, this.auth.now());
      if (boundary) return boundary;
      const now = this.auth.now();
      if (capacity !== null) {
        const keepEmpty = row.seats.filter((seat) => !seat.registration).slice(0, capacity - active.length);
        const retained = row.seats.filter(
          (seat) => seat.registration || keepEmpty.some((item) => item.id === seat.id)
        );
        const removed = row.seats.filter(
          (seat) => !seat.registration && !retained.some((item) => item.id === seat.id)
        );
        await tx.$executeRawUnsafe('SET CONSTRAINTS "ActivitySeat_activityId_position_key" DEFERRED');
        if (removed.length)
          await tx.activitySeat.deleteMany({
            where: { activityId: key, id: { in: removed.map((seat) => seat.id) }, registration: { is: null } }
          });
        for (const [position, seat] of retained.entries())
          if (seat.position !== position)
            await tx.activitySeat.update({ where: { id: seat.id }, data: { position } });
        for (let position = retained.length; position < capacity; position++)
          await tx.activitySeat.create({ data: { activityId: key, position, kind: 'ANY' } });
      }
      const startsAt = parseBeijingActivityTime(input.startsAt, 'startsAt'),
        endsAt = parseBeijingActivityTime(input.endsAt, 'endsAt');
      await tx.activity.update({
        where: { id: key },
        data: {
          title: input.title,
          description: input.description,
          location: input.location,
          meetingInstructions: input.meetingInstructions,
          startsAt,
          endsAt,
          registrationClosesAt: parseBeijingActivityTime(input.registrationClosesAt, 'registrationClosesAt'),
          capacityUnlimited: capacity === null,
          revision: { increment: 1 }
        }
      });
      if (startsAt.getTime() !== row.startsAt.getTime() || endsAt.getTime() !== row.endsAt.getTime()) {
        for (const recipientId of new Set(active.map((seat) => seat.registration!.accountId)))
          await this.event(
            tx,
            {
              eventKey: `offline-edited-time:${key}:${row.revision + 1}:${recipientId}`,
              activityId: key,
              kind: 'ACTIVITY_RESCHEDULED',
              channel: 'IN_APP',
              recipientId,
              payload: {
                scene: 'OFFLINE',
                activityTitle: input.title,
                activityLink: `/activities/${key}`,
                oldStartsAt: row.startsAt.toISOString(),
                oldEndsAt: row.endsAt.toISOString(),
                newStartsAt: startsAt.toISOString(),
                newEndsAt: endsAt.toISOString()
              }
            },
            now
          );
      }
      const after = await tx.activity.findUniqueOrThrow({ where: { id: key }, select: activitySelect });
      await tx.activityCommand.create({
        data: {
          activityId: key,
          actorId: fresh.accountId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          kind: 'OFFLINE_EDIT',
          before: snapshot(row),
          after: json({ snapshot: snapshot(after), penaltyPoints: 0 }),
          createdAt: now
        }
      });
      await notifyQqActivity(tx, key, 'CHANGED', now);
      boundary = this.offlineBoundary(row, input, this.auth.now());
      if (boundary) throw boundary;
      const activity = await this.read(tx, key, fresh.accountId);
      await this.finish(tx, token, fresh);
      boundary = this.offlineBoundary(row, input, this.auth.now());
      if (boundary) throw boundary;
      return { activity, replayed: false };
    });
    if (result instanceof AccountError) throw result;
    return result;
  }
}
