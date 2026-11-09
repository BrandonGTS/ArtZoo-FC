import { notifyQqActivity } from '../qq-official/notifications';
import { requireActiveTargets } from '../auth/active-targets';
import { type Prisma } from '@artzoo/db';
import {
  AccountError,
  activityId,
  invalid,
  validateSeriesPeriodCancellation,
  type ActivityWriteResult
} from '@artzoo/domain';
import { tokenDigest } from '../auth/crypto';
import { ActivityService, activitySelect } from './service';

export class ActivitySeriesService extends ActivityService {
  private async checkedResult(
    tx: Prisma.TransactionClient,
    id: string,
    actor: Awaited<ReturnType<ActivitySeriesService['auth']['requireAccount']>>,
    token: string | null | undefined,
    replayed: boolean,
    originalStartsAt?: Date
  ): Promise<ActivityWriteResult> {
    const activity = await this.read(tx, id, actor.accountId);
    const final = await this.auth.requireAccount(tx, token);
    if (
      final.expiresAt <= this.auth.now() ||
      final.id !== actor.id ||
      final.accountId !== actor.accountId ||
      final.account.membership !== actor.account.membership ||
      final.account.adminRole !== actor.account.adminRole
    )
      throw new AccountError('UNAUTHENTICATED', '登录状态已变化，请刷新后重试', 401);
    if (!replayed && originalStartsAt && this.auth.now() >= originalStartsAt)
      throw new AccountError('FORBIDDEN', '本期已开始，不能提交本次操作', 403);
    return { activity, replayed };
  }
  async cancelPeriod(
    id: string,
    body: Record<string, unknown>,
    token?: string | null
  ): Promise<ActivityWriteResult> {
    const key = activityId(id),
      input = validateSeriesPeriodCancellation(body);
    const actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`activity-manage:${actor.accountId}`, 120, 900);
    const result = await this.auth.transaction(async (tx) => {
      const fresh = await this.actorLocked(tx, token, actor);
      // Same account -> series -> ordered periods lock order as signup, formation and worker.
      await this.lockActivityScope(tx, key);
      await this.auth.requireAccount(tx, token);
      const row = await tx.activity.findUnique({ where: { id: key }, select: activitySelect });
      if (!row) throw new AccountError('NOT_FOUND', '活动不存在', 404);
      if (row.scene !== 'GAME' || row.mode !== 'SERIES' || !row.seriesId) {
        throw new AccountError('FORBIDDEN', '仅普通长期活动可以协商取消本期', 403);
      }
      if (row.organizerId !== fresh.accountId)
        throw new AccountError('FORBIDDEN', '仅发起者可以确认协商取消', 403);
      const fingerprint = tokenDigest(JSON.stringify({ kind: 'SERIES_CANCEL_PERIOD', input }));
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
          throw new AccountError('CONFLICT', '本次确认内容已变化，请重新确认', 409);
        return this.checkedResult(tx, key, fresh, token, true);
      }
      // Returning a business error preserves any recruitment transition reconciled under the locks.
      if (row.cancelledAt || row.series?.state === 'CANCELLED')
        return new AccountError('FORBIDDEN', '本期或长期活动已取消', 403);
      if (row.series?.state !== 'FORMED' || !row.series.formedAt)
        return new AccountError('FORBIDDEN', '请先确认长期活动成团', 403);
      const now = this.auth.now();
      if (now >= row.startsAt) throw new AccountError('FORBIDDEN', '本期已开始，不能提前协商取消', 403);
      if (row.revision !== input.expectedRevision)
        throw new AccountError('CONFLICT', '活动已更新，请刷新后重新确认', 409);
      const active = row.seats.flatMap((seat) =>
        seat.registration ? [{ seat, registration: seat.registration }] : []
      );
      await tx.activity.update({
        where: { id: key },
        data: {
          cancelledAt: now,
          cancellationReason: 'SERIES_AGREED_CANCEL',
          revision: { increment: 1 }
        }
      });
      for (const { seat, registration } of active) {
        await tx.activityRegistration.update({
          where: { id: registration.id },
          data: {
            status: 'CANCELLED',
            exitedAt: now,
            seatId: null,
            seatSnapshot: {
              id: seat.id,
              position: seat.position,
              groupKey: seat.groupKey,
              kind: seat.kind,
              role: seat.role,
              job: seat.job
            }
          }
        });
      }
      const payload = {
        activityTitle: row.title,
        seriesId: row.seriesId,
        periodNumber: row.periodNumber,
        oldStartsAt: row.startsAt.toISOString(),
        reason: 'SERIES_AGREED_CANCEL',
        activityLink: `/activities/${key}`
      };
      for (const recipientId of new Set(active.map((item) => item.registration.accountId))) {
        await this.event(
          tx,
          {
            eventKey: `series-period-cancelled:${key}:${recipientId}`,
            activityId: key,
            kind: 'ACTIVITY_CANCELLED',
            channel: 'IN_APP',
            recipientId,
            payload
          },
          now
        );
      }
      await notifyQqActivity(tx, key, 'CANCELLED', now);
      // Keep the attestation and exact affected roster; do not rewrite the series plan or another period.
      await tx.activityCommand.create({
        data: {
          activityId: key,
          actorId: fresh.accountId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          kind: 'SERIES_CANCEL_PERIOD',
          before: {
            revision: row.revision,
            seriesId: row.seriesId,
            periodNumber: row.periodNumber,
            registrations: active.map((item) => ({
              id: item.registration.id,
              accountId: item.registration.accountId,
              seatId: item.seat.id
            }))
          },
          after: {
            revision: row.revision + 1,
            allMembersAgreed: true,
            cancelledAt: now.toISOString(),
            reason: 'SERIES_AGREED_CANCEL',
            penaltyPoints: 0
          },
          createdAt: now
        }
      });
      if (this.auth.now() >= row.startsAt)
        throw new AccountError('FORBIDDEN', '本期已开始，不能提交本次操作', 403);
      return this.checkedResult(tx, key, fresh, token, false, row.startsAt);
    });
    if (result instanceof AccountError) throw result;
    return result;
  }
  async confirm(
    id: string,
    body: Record<string, unknown>,
    token?: string | null
  ): Promise<ActivityWriteResult> {
    if (Object.keys(body).some((key) => !['idempotencyKey', 'expectedRevision'].includes(key)))
      invalid('series', '包含不允许提交的字段');
    const key = activityId(id),
      idempotencyKey = activityId(body.idempotencyKey, 'idempotencyKey');
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
      invalid('expectedRevision', '活动版本无效');
    const actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`activity-manage:${actor.accountId}`, 120, 900);
    const result = await this.auth.transaction(async (tx) => {
      const fresh = await this.actorLocked(tx, token, actor);
      await this.lockActivityScope(tx, key);
      await this.auth.requireAccount(tx, token);
      const row = await tx.activity.findUnique({ where: { id: key }, select: activitySelect });
      if (!row) throw new AccountError('NOT_FOUND', '活动不存在', 404);
      if (row.mode !== 'SERIES' || !row.seriesId || row.periodNumber !== 1)
        throw new AccountError('FORBIDDEN', '请从长期活动首期确认成团', 403);
      if (row.organizerId !== fresh.accountId)
        throw new AccountError('FORBIDDEN', '仅发起者可以确认成团', 403);
      const fingerprint = tokenDigest(
        JSON.stringify({ kind: 'SERIES_FORM', expectedRevision: body.expectedRevision })
      );
      const previous = await tx.activityCommand.findUnique({
        where: {
          activityId_actorId_idempotencyKey: { activityId: key, actorId: fresh.accountId, idempotencyKey }
        },
        select: { requestFingerprint: true }
      });
      if (previous) {
        if (previous.requestFingerprint !== fingerprint)
          throw new AccountError('CONFLICT', '本次确认内容已变化，请刷新', 409);
        return this.checkedResult(tx, key, fresh, token, true);
      }
      const now = this.auth.now();
      if (row.cancelledAt || row.series?.state === 'CANCELLED')
        return new AccountError('FORBIDDEN', '长期活动已取消', 403);
      if (row.series?.state !== 'RECRUITING')
        throw new AccountError('CONFLICT', '长期活动已成团，名单已锁定', 409);
      if (now >= row.startsAt) return new AccountError('FORBIDDEN', '首期已开始，不能确认成团', 403);
      if (row.revision !== body.expectedRevision)
        throw new AccountError('CONFLICT', '报名或活动已更新，请刷新后重新确认', 409);
      if (!row.seats.length || row.seats.some((seat) => !seat.registration))
        throw new AccountError('CONFLICT', '人数未满，暂不能确认成团', 409);
      await requireActiveTargets(
        tx,
        row.seats.map((seat) => seat.registration!.accountId)
      );
      const periods = await tx.activity.findMany({
        where: { seriesId: row.seriesId },
        orderBy: [{ periodNumber: 'asc' }, { id: 'asc' }],
        select: activitySelect
      });
      for (const period of periods.filter((item) => item.id !== row.id)) {
        if (
          period.cancelledAt ||
          period.seats.length !== row.seats.length ||
          period.seats.some((seat) => seat.registration)
        )
          throw new AccountError('CONFLICT', '系列期次与名单状态不一致，请刷新', 409);
      }
      for (const period of periods.filter((item) => item.id !== row.id)) {
        for (const [index, seat] of period.seats.entries()) {
          const member = row.seats[index]!.registration!;
          await tx.activityRegistration.create({
            data: {
              activityId: period.id,
              seatId: seat.id,
              accountId: member.accountId,
              job: member.job,
              createdAt: now
            }
          });
        }
      }
      await tx.activitySeries.update({
        where: { id: row.seriesId },
        data: { state: 'FORMED', formedAt: now }
      });
      await tx.activity.updateMany({
        where: { seriesId: row.seriesId },
        data: { revision: { increment: 1 } }
      });
      const payload = {
        activityTitle: row.title,
        activityLink: `/activities/${row.id}`,
        totalPeriods: periods.length
      };
      for (const recipientId of new Set(row.seats.map((seat) => seat.registration!.accountId)))
        await this.event(
          tx,
          {
            eventKey: `series-formed:${row.seriesId}:${recipientId}`,
            activityId: row.id,
            kind: 'SERIES_FORMED',
            channel: 'IN_APP',
            recipientId,
            payload
          },
          now
        );
      await tx.activityCommand.create({
        data: {
          activityId: row.id,
          actorId: fresh.accountId,
          idempotencyKey,
          requestFingerprint: fingerprint,
          kind: 'SERIES_FORM',
          before: { revision: row.revision, state: 'RECRUITING' },
          after: {
            revision: row.revision + 1,
            state: 'FORMED',
            members: row.seats.map((seat) => seat.registration!.accountId)
          } as Prisma.InputJsonValue,
          createdAt: now
        }
      });
      if (this.auth.now() >= row.startsAt)
        throw new AccountError('FORBIDDEN', '本期已开始，不能提交本次操作', 403);
      return this.checkedResult(tx, key, fresh, token, false, row.startsAt);
    });
    if (result instanceof AccountError) throw result;
    return result;
  }
}
