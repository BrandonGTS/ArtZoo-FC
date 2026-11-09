import type { Prisma, PrismaClient, Account } from '@artzoo/db';
import { setLotteryAccountActive } from '@artzoo/db/lottery-eligibility';
import {
  AccountError,
  isMemberId,
  reasonInput,
  type LifecycleAccount,
  type LifecyclePreview,
  type LifecycleResult,
  type LifecycleAudit
} from '@artzoo/domain';
import { AccountService, accountSummary, lock } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import { collectImpact, impactFingerprint, type CollectedImpact } from './impact';
type Tx = Prisma.TransactionClient;
type Body = Record<string, unknown>;
type Actor = Awaited<ReturnType<AccountService['requireAccount']>>;
function invalid(message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400);
}
function conflict(message = '影响范围已变化，请重新读取并确认'): never {
  throw new AccountError('CONFLICT', message, 409);
}
function denied(): never {
  throw new AccountError('FORBIDDEN', '仅超级管理员可以执行此操作', 403);
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function identifier(id: string) {
  if (!isMemberId(id)) invalid('账号标识无效');
  return id;
}
function desired(value: unknown) {
  if (typeof value !== 'boolean') invalid('账号状态无效');
  return value as boolean;
}
function fields(body: Body, allowed: string[]) {
  if (Object.keys(body).some((k) => !allowed.includes(k))) invalid('提交字段无效');
}
function paging(url: URL) {
  const n = (key: string, fallback: number, max: number) => {
    const raw = url.searchParams.get(key);
    if (raw === null) return fallback;
    if (!/^[1-9]\d{0,6}$/.test(raw) || Number(raw) > max) invalid('分页参数无效');
    return Number(raw);
  };
  return { page: n('page', 1, 1000000), pageSize: n('pageSize', 20, 100) };
}
export class AccountLifecycleService {
  constructor(readonly auth: AccountService) {}
  private async super(tx: Tx | PrismaClient, token?: string | null, expected?: Actor) {
    const actor = await this.auth.requireAccount(tx, token, true);
    if (actor.expiresAt <= this.auth.now())
      throw new AccountError('UNAUTHENTICATED', '登录已过期，请重新登录', 401);
    if (actor.account.adminRole !== 'SUPER_ADMIN') denied();
    if (
      expected &&
      (actor.id !== expected.id ||
        actor.accountId !== expected.accountId ||
        actor.account.membership !== expected.account.membership ||
        actor.account.adminRole !== expected.account.adminRole)
    )
      throw new AccountError('UNAUTHENTICATED', '登录身份已变化，请重新登录', 401);
    return actor;
  }
  private async view(tx: Tx | PrismaClient, targetId: string): Promise<LifecycleAccount> {
    const row = await tx.account.findUnique({ where: { id: targetId }, include: { lotteryStatus: true } });
    if (!row) throw new AccountError('NOT_FOUND', '账号不存在', 404);
    return this.rowView(row);
  }
  private rowView(
    row: Account & { lotteryStatus: { active: boolean; revision: number } | null }
  ): LifecycleAccount {
    if (!row.lotteryStatus) throw new AccountError('SERVICE_UNAVAILABLE', '账号状态暂时不可用', 503);
    return {
      ...accountSummary(row),
      adminRoleRevision: row.adminRoleRevision,
      active: row.lotteryStatus.active,
      lifecycleRevision: row.lotteryStatus.revision
    };
  }
  private protect(account: LifecycleAccount, actor: Actor) {
    if (account.id === actor.accountId || account.adminRole === 'SUPER_ADMIN')
      throw new AccountError('FORBIDDEN', '不能停用或变更超级管理员账号状态', 403);
  }
  private async lockedActor(tx: Tx, token: string | null | undefined, actor: Actor, targetId: string) {
    await lock(tx, 'account-lifecycle:write');
    const target = await tx.account.findUnique({ where: { id: targetId }, select: { phone: true } });
    if (!target) throw new AccountError('NOT_FOUND', '账号不存在', 404);
    for (const phone of [...new Set([actor.account.phone, target.phone])].sort())
      await lock(tx, 'phone:' + phone);
    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${targetId} OR "id"=${actor.accountId} ORDER BY "id" FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${actor.id} FOR UPDATE`;
    return this.super(tx, token, actor);
  }
  private async lockImpact(tx: Tx, impact: CollectedImpact) {
    const seriesIds = [...new Set(impact.activities.flatMap((a) => (a.seriesId ? [a.seriesId] : [])))].sort();
    for (const id of seriesIds) {
      await lock(tx, 'series:' + id);
      const periods = await tx.activity.findMany({
        where: { seriesId: id },
        orderBy: [{ periodNumber: 'asc' }, { id: 'asc' }],
        select: { id: true }
      });
      for (const period of periods) await lock(tx, 'activity:' + period.id);
    }
    for (const activity of impact.activities
      .filter((a) => !a.seriesId)
      .sort((a, b) => a.id.localeCompare(b.id)))
      await lock(tx, 'activity:' + activity.id);
    for (const team of impact.teams) await lock(tx, 'team:' + team.id);
  }
  async accounts(url: URL, token?: string | null) {
    const actor = await this.super(this.auth.db, token),
      { page, pageSize } = paging(url),
      query = (url.searchParams.get('query') ?? '').trim();
    if (query.length > 100) invalid('搜索内容过长');
    const result = await this.auth.db.$transaction(
      async (tx) => {
        const where = {
          displayName: { contains: query.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' as const }
        };
        const total = query ? await tx.account.count({ where }) : 0;
        const rows = query
          ? await tx.account.findMany({
              where,
              include: { lotteryStatus: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              skip: (page - 1) * pageSize,
              take: pageSize
            })
          : [];
        return { items: rows.map((row) => this.rowView(row)), page, pageSize, total };
      },
      { isolationLevel: 'RepeatableRead' }
    );
    await this.super(this.auth.db, token, actor);
    return result;
  }
  async preview(targetId: string, url: URL, token?: string | null): Promise<LifecyclePreview> {
    identifier(targetId);
    const raw = url.searchParams.get('active');
    if (raw !== '0' && raw !== '1') invalid('账号状态无效');
    const active = raw === '1',
      actor = await this.super(this.auth.db, token);
    const result = await this.auth.db.$transaction(
      async (tx) => {
        const account = await this.view(tx, targetId);
        this.protect(account, actor);
        if (account.active === active) invalid(active ? '账号当前已恢复' : '账号当前已停用');
        const now = this.auth.now(),
          collected = await collectImpact(tx, targetId, active, now);
        return {
          account,
          active,
          impact: collected.impact,
          previewFingerprint: impactFingerprint(account, active, collected.vector),
          serverNow: now.toISOString()
        };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
    await this.super(this.auth.db, token, actor);
    return result;
  }
  async audits(url: URL, token?: string | null) {
    const actor = await this.super(this.auth.db, token),
      { page, pageSize } = paging(url);
    const result = await this.auth.db.$transaction(
      async (tx) => {
        const total = await tx.accountLifecycleAudit.count();
        const rows = await tx.accountLifecycleAudit.findMany({
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: {
            actor: { select: { id: true, displayName: true } },
            target: { select: { id: true, displayName: true } }
          }
        });
        const items: LifecycleAudit[] = rows.map((a) => ({
          id: a.id,
          actor: a.actor,
          target: a.target,
          beforeActive: a.beforeActive,
          afterActive: a.afterActive,
          reason: a.reason,
          impact: a.impact as unknown as LifecycleAudit['impact'],
          createdAt: a.createdAt.toISOString()
        }));
        return { items, total, page, pageSize };
      },
      { isolationLevel: 'RepeatableRead' }
    );
    await this.super(this.auth.db, token, actor);
    return result;
  }
  private async apply(
    tx: Tx,
    targetId: string,
    collected: CollectedImpact,
    actorId: string,
    idempotencyKey: string,
    fingerprint: string,
    now: Date
  ) {
    const ownedIds = new Set(collected.cancelled.map((a) => a.id));
    for (const activity of collected.cancelled)
      await tx.activity.update({
        where: { id: activity.id },
        data: { cancelledAt: now, cancellationReason: 'ACCOUNT_DISABLED' }
      });
    for (const { registration: r } of collected.registrations) {
      const seat = r.seat;
      await tx.activityRegistration.update({
        where: { id: r.id },
        data: {
          status: 'CANCELLED',
          seatId: null,
          exitedAt: now,
          ...(seat
            ? {
                seatSnapshot: {
                  id: seat.id,
                  position: seat.position,
                  groupKey: seat.groupKey,
                  kind: seat.kind,
                  role: seat.role,
                  job: seat.job
                }
              }
            : {})
        }
      });
    }
    for (const activity of collected.activities) {
      const affected = collected.registrations
        .filter((r) => r.activity.id === activity.id)
        .map((r) => r.registration.id);
      if (!affected.length && !ownedIds.has(activity.id)) continue;
      await tx.activity.update({ where: { id: activity.id }, data: { revision: { increment: 1 } } });
      await tx.activityCommand.create({
        data: {
          activityId: activity.id,
          actorId,
          idempotencyKey,
          requestFingerprint: fingerprint,
          kind: ownedIds.has(activity.id) ? 'ACCOUNT_DISABLED_CANCEL' : 'ACCOUNT_DISABLED_WITHDRAW',
          before: json({ revision: activity.revision, registrationIds: affected }),
          after: json({
            revision: activity.revision + 1,
            registrationIds: affected,
            status: 'CANCELLED',
            reason: 'ACCOUNT_DISABLED',
            penaltyPoints: 0
          }),
          createdAt: now
        }
      });
    }
    for (const seriesId of [
      ...new Set(collected.cancelled.flatMap((a) => (a.seriesId ? [a.seriesId] : [])))
    ]) {
      const periods = await tx.activity.findMany({
        where: { seriesId },
        select: { endsAt: true, cancelledAt: true }
      });
      if (periods.length && periods.every((p) => p.endsAt > now && p.cancelledAt))
        await tx.activitySeries.update({
          where: { id: seriesId },
          data: { state: 'CANCELLED', cancelledAt: now }
        });
    }
    for (const team of collected.dissolved)
      await tx.fixedTeam.update({ where: { id: team.id }, data: { state: 'DISSOLVED', dissolvedAt: now } });
    for (const { session } of collected.cancelledSessions)
      await tx.teamSession.update({
        where: { id: session.id },
        data: { state: 'CANCELLED', cancelledAt: now }
      });
    for (const { membership } of collected.memberships)
      await tx.teamMembership.update({
        where: { id: membership.id },
        data: { state: 'REMOVED', seatId: null, leftAt: now }
      });
    for (const { member } of collected.sessionMembers)
      await tx.teamSessionMember.update({ where: { id: member.id }, data: { state: 'NEEDS_SUBSTITUTE' } });
    for (const { substitute } of collected.substitutes)
      await tx.teamSessionSubstitute.update({ where: { id: substitute.id }, data: { endedAt: now } });
    for (const { application } of collected.applications)
      await tx.teamApplication.update({
        where: { id: application.id },
        data: { state: 'CANCELLED', decidedAt: now }
      });
    for (const team of collected.teams) {
      const affected = {
        sessionMembers: collected.impact.sessionMembers.filter((item) => item.teamId === team.id),
        dissolved: collected.dissolvedIds.has(team.id),
        sessionIds: collected.cancelledSessions.filter((x) => x.team.id === team.id).map((x) => x.session.id),
        membershipIds: collected.memberships.filter((x) => x.team.id === team.id).map((x) => x.membership.id),
        substituteIds: collected.substitutes.filter((x) => x.team.id === team.id).map((x) => x.substitute.id),
        applicationIds: collected.applications
          .filter((x) => x.team.id === team.id)
          .map((x) => x.application.id)
      };
      if (
        !affected.dissolved &&
        !affected.sessionIds.length &&
        !affected.membershipIds.length &&
        !affected.substituteIds.length &&
        !affected.applicationIds.length
      )
        continue;
      await tx.fixedTeam.update({ where: { id: team.id }, data: { revision: { increment: 1 } } });
      await tx.teamCommand.create({
        data: {
          teamId: team.id,
          actorId,
          idempotencyKey,
          requestFingerprint: fingerprint,
          kind: affected.dissolved ? 'ACCOUNT_DISABLED_DISSOLVE' : 'ACCOUNT_DISABLED_REMOVE_RELATIONS',
          before: { revision: team.revision },
          after: json({ revision: team.revision + 1, affected }),
          createdAt: now
        }
      });
    }
    await tx.accountSession.updateMany({
      where: { accountId: targetId, revokedAt: null },
      data: { revokedAt: now }
    });
  }
  async change(targetId: string, body: Body, token?: string | null): Promise<LifecycleResult> {
    identifier(targetId);
    fields(body, [
      'active',
      'expectedRevision',
      'previewFingerprint',
      'confirmed',
      'reason',
      'idempotencyKey'
    ]);
    const active = desired(body.active),
      expectedRevision = body.expectedRevision,
      previewFingerprint = body.previewFingerprint,
      idempotencyKey = body.idempotencyKey,
      reason = reasonInput(body.reason);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      Number(expectedRevision) < 0 ||
      Number(expectedRevision) >= 2147483647
    )
      invalid('版本无效');
    if (typeof previewFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(previewFingerprint))
      invalid('请先读取影响范围');
    if (typeof idempotencyKey !== 'string' || !/^[-_a-zA-Z0-9]{16,128}$/.test(idempotencyKey))
      invalid('提交标识无效');
    if (body.confirmed !== true) invalid('请确认本次账号状态变更');
    const fingerprint = tokenDigest(
        JSON.stringify({ targetId, active, expectedRevision, previewFingerprint, reason })
      ),
      actor = await this.super(this.auth.db, token);
    await this.auth.rate('account-lifecycle:' + actor.accountId, 120, 900);
    return this.auth.db.$transaction(
      async (tx) => {
        await this.lockedActor(tx, token, actor, targetId);
        let account = await this.view(tx, targetId);
        this.protect(account, actor);
        const old = await tx.accountLifecycleCommand.findUnique({
          where: { actorId_idempotencyKey: { actorId: actor.accountId, idempotencyKey } }
        });
        if (old) {
          if (old.requestFingerprint !== fingerprint) conflict('同次提交内容已变化，请使用原内容重试');
          const auditId = (old.result as { auditId: string }).auditId;
          await this.super(tx, token, actor);
          return { account, replayed: true, auditId };
        }
        if (account.lifecycleRevision !== expectedRevision || account.active === active) conflict();
        const beforeLocks = await collectImpact(tx, targetId, active, this.auth.now());
        await this.lockImpact(tx, beforeLocks);
        const now = this.auth.now(),
          collected = await collectImpact(tx, targetId, active, now);
        const lockedActivities = new Set(beforeLocks.activities.map((a) => a.id)),
          lockedTeams = new Set(beforeLocks.teams.map((t) => t.id));
        if (
          collected.activities.some((a) => !lockedActivities.has(a.id)) ||
          collected.teams.some((t) => !lockedTeams.has(t.id))
        )
          conflict();
        if (impactFingerprint(account, active, collected.vector) !== previewFingerprint) conflict();
        if (!active)
          await this.apply(tx, targetId, collected, actor.accountId, idempotencyKey, fingerprint, now);
        await setLotteryAccountActive(tx, {
          accountId: targetId,
          active,
          expectedRevision: Number(expectedRevision),
          reason,
          changedById: actor.accountId
        });
        const audit = await tx.accountLifecycleAudit.create({
          data: {
            actorId: actor.accountId,
            targetAccountId: targetId,
            beforeActive: account.active,
            afterActive: active,
            revisionBefore: Number(expectedRevision),
            revisionAfter: Number(expectedRevision) + 1,
            reason,
            impact: json(collected.impact),
            createdAt: now
          }
        });
        await tx.accountLifecycleCommand.create({
          data: {
            actorId: actor.accountId,
            targetAccountId: targetId,
            idempotencyKey,
            requestFingerprint: fingerprint,
            result: { auditId: audit.id },
            createdAt: now
          }
        });
        account = await this.view(tx, targetId);
        await this.super(tx, token, actor);
        if (collected.boundary !== null && this.auth.now().getTime() >= collected.boundary)
          conflict('活动或场次已跨过时间边界，请重新读取并确认');
        return { account, replayed: false, auditId: audit.id };
      },
      { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 15000 }
    );
  }
}
