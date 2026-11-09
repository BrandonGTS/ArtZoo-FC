import { reverseManagementPenalty, settleActivityStanding, type Prisma } from '@artzoo/db';
import {
  AccountError,
  activityId,
  invalid,
  penaltyAppealDeadline,
  penaltyAppealWindowOpen,
  validatePenaltyAppeal,
  validatePenaltyAppealDecision,
  type AppealablePenaltyReason,
  type MyActivityPenalties,
  type PenaltyAppeal,
  type PenaltyAppealPage
} from '@artzoo/domain';
import { lock } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import { ActivityService } from './service';
type Tx = Prisma.TransactionClient;
const singleReasons = ['LATE_WITHDRAWAL', 'LATE_CANCELLATION'];
const seriesReasons = ['SERIES_UNAGREED_ABSENCE', 'SERIES_UNCOMMUNICATED_EXIT'];
const reasonScope = {
  OR: [
    { reason: { in: singleReasons } },
    { reason: { in: seriesReasons }, activity: { is: { scene: 'GAME', mode: 'SERIES' } } }
  ]
} satisfies Prisma.ActivityPenaltyWhereInput;
const appealSelect = {
  id: true,
  penaltyId: true,
  reason: true,
  status: true,
  revision: true,
  createdAt: true,
  decidedAt: true,
  decisionReason: true
} as const;
const penaltySelect = {
  id: true,
  accountId: true,
  activityId: true,
  registrationId: true,
  reason: true,
  points: true,
  createdAt: true,
  reversedAt: true,
  appealEnabledAt: true,
  activity: { select: { id: true, title: true, scene: true, mode: true } }
} as const;
type Appeal = Prisma.ActivityPenaltyAppealGetPayload<{ select: typeof appealSelect }>;
type Penalty = Prisma.ActivityPenaltyGetPayload<{ select: typeof penaltySelect }>;
const summary = (row: Appeal): PenaltyAppeal => ({
  id: row.id,
  penaltyId: row.penaltyId,
  reason: row.reason,
  status: row.status as PenaltyAppeal['status'],
  revision: row.revision,
  createdAt: row.createdAt.toISOString(),
  decidedAt: row.decidedAt?.toISOString() ?? null,
  decisionReason: row.decisionReason
});
function missing(): never {
  throw new AccountError('NOT_FOUND', '处罚或申诉记录不存在', 404);
}
function conflict(message: string): never {
  throw new AccountError('CONFLICT', message, 409);
}
function supported(row: Penalty) {
  if (
    !(
      singleReasons.includes(row.reason) ||
      (seriesReasons.includes(row.reason) && row.activity.scene === 'GAME' && row.activity.mode === 'SERIES')
    ) ||
    !row.appealEnabledAt
  )
    throw new AccountError('FORBIDDEN', '此处罚不可通过该入口申诉', 403);
}
function pagination(url: URL) {
  const value = url.searchParams.get('page') ?? '1';
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) invalid('page', '页码无效');
  return Number(value);
}
const canonicalReason = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
export class ActivityPenaltyAppealService extends ActivityService {
  private async locked<T extends { replayed: boolean }>(
    penaltyId: string,
    token: string | null | undefined,
    administrator: boolean,
    work: (tx: Tx, row: Penalty, actorId: string, now: Date) => Promise<T>,
    submissionWindow = false
  ) {
    const actor = await this.auth.requireAccount(this.auth.db, token, administrator);
    await this.auth.rate(`activity-penalty-appeal:${actor.accountId}`, 120, 900);
    const seed = await this.auth.db.activityPenalty.findUnique({
      where: { id: penaltyId },
      select: { accountId: true, activityId: true }
    });
    if (!seed || (!administrator && seed.accountId !== actor.accountId)) missing();
    return this.auth.transaction(async (tx) => {
      await lock(tx, `phone:${actor.account.phone}`);
      for (const id of [...new Set([actor.accountId, seed.accountId])].sort())
        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${id} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id" = ${actor.id} FOR UPDATE`;
      const fresh = await this.auth.requireAccount(tx, token, administrator);
      if (fresh.id !== actor.id || fresh.accountId !== actor.accountId)
        throw new AccountError('FORBIDDEN', '请重新登录', 403);
      await lock(tx, `activity:${seed.activityId}`);
      const current = await this.auth.requireAccount(tx, token, administrator);
      if (
        current.id !== actor.id ||
        current.accountId !== actor.accountId ||
        current.expiresAt <= this.auth.now()
      )
        throw new AccountError('UNAUTHENTICATED', '请先登录', 401);
      const row = await tx.activityPenalty.findUnique({ where: { id: penaltyId }, select: penaltySelect });
      if (!row || row.accountId !== seed.accountId || row.activityId !== seed.activityId) missing();
      const result = await work(tx, row, fresh.accountId, this.auth.now());
      // Recheck after the final work SQL, including waits during audit/outbox writes and replay reads.
      const finalActor = await this.auth.requireAccount(tx, token, administrator),
        finalNow = this.auth.now();
      if (
        finalActor.id !== actor.id ||
        finalActor.accountId !== actor.accountId ||
        finalActor.expiresAt <= finalNow
      )
        throw new AccountError('UNAUTHENTICATED', '请先登录', 401);
      if (submissionWindow && !result.replayed && !penaltyAppealWindowOpen(row.createdAt, finalNow))
        throw new AccountError('FORBIDDEN', '请在处罚产生后的7天内提交申诉', 403);
      return result;
    });
  }
  async minePenalties(url: URL, token?: string | null): Promise<MyActivityPenalties> {
    const requestedPage = pagination(url);
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.auth.requireAccount(tx, token),
          where = { accountId: actor.accountId, ...reasonScope };
        const total = await tx.activityPenalty.count({ where }),
          pageSize = 10,
          totalPages = Math.ceil(total / pageSize);
        const page = Math.min(requestedPage, Math.max(1, totalPages)),
          now = this.auth.now();
        const rows = await tx.activityPenalty.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            ...penaltySelect,
            appeals: {
              orderBy: { sequence: 'desc' },
              take: 1,
              select: appealSelect
            }
          }
        });
        return {
          serverNow: now.toISOString(),
          points: actor.account.activityPoints,
          restricted: actor.account.activityPoints >= 3,
          page,
          pageSize,
          total,
          totalPages,
          items: rows.map((row) => ({
            id: row.id,
            reason: row.reason as AppealablePenaltyReason,
            points: row.points,
            createdAt: row.createdAt.toISOString(),
            reversedAt: row.reversedAt?.toISOString() ?? null,
            activityId: row.activity.id,
            activityTitle: row.activity.title,
            expiresAt: penaltyAppealDeadline(row.createdAt).toISOString(),
            canAppeal:
              !!row.appealEnabledAt &&
              !row.reversedAt &&
              penaltyAppealWindowOpen(row.createdAt, now) &&
              (!row.appeals[0] || row.appeals[0].status === 'REJECTED'),
            latestAppeal: row.appeals[0] ? summary(row.appeals[0]) : null
          }))
        };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
  }
  async appeal(id: string, body: Record<string, unknown>, token?: string | null) {
    const key = activityId(id),
      input = validatePenaltyAppeal(body);
    return this.locked(
      key,
      token,
      false,
      async (tx, row, actorId, now) => {
        const fingerprint = tokenDigest(JSON.stringify({ kind: 'PENALTY_APPEAL', penaltyId: key, input }));
        const previous = await tx.activityPenaltyAppeal.findUnique({
          where: { accountId_submissionKey: { accountId: actorId, submissionKey: input.idempotencyKey } }
        });
        if (previous) {
          if (previous.submissionFingerprint !== fingerprint || previous.penaltyId !== key)
            conflict('本次申诉内容已变化，请重新确认');
          return { appeal: summary(previous), replayed: true };
        }
        supported(row);
        if (row.reversedAt) conflict('这次处罚已经撤销');
        if (!penaltyAppealWindowOpen(row.createdAt, now))
          throw new AccountError('FORBIDDEN', '请在处罚产生后的7天内提交申诉', 403);
        const latest = await tx.activityPenaltyAppeal.findFirst({
          where: { penaltyId: key },
          orderBy: { sequence: 'desc' }
        });
        if ((latest?.id ?? null) !== input.expectedLatestAppealId) conflict('申诉记录已变化，请刷新');
        if (latest && latest.status !== 'REJECTED') conflict('已有待处理申诉或这次处罚已经处理');
        if (latest && canonicalReason(latest.reason) === canonicalReason(input.reason))
          invalid('reason', '再次申诉请补充新的理由');
        const appeal = await tx.activityPenaltyAppeal.create({
          data: {
            penaltyId: key,
            accountId: actorId,
            reason: input.reason,
            submissionKey: input.idempotencyKey,
            submissionFingerprint: fingerprint,
            createdAt: now
          }
        });
        await tx.accountAudit.create({
          data: {
            action: 'PENALTY_APPEAL_SUBMITTED',
            actorId,
            targetAccountId: row.accountId,
            reason: `申诉${appeal.id}：${input.reason}`,
            createdAt: now
          }
        });
        return { appeal: summary(appeal), replayed: false };
      },
      true
    );
  }
  async decide(id: string, body: Record<string, unknown>, token?: string | null) {
    const key = activityId(id),
      input = validatePenaltyAppealDecision(body);
    await this.auth.requireAccount(this.auth.db, token, true);
    const seed = await this.auth.db.activityPenaltyAppeal.findUnique({
      where: { id: key },
      select: { penaltyId: true }
    });
    if (!seed) missing();
    return this.locked(seed.penaltyId, token, true, async (tx, row, actorId, now) => {
      const fingerprint = tokenDigest(
        JSON.stringify({ kind: 'PENALTY_DECISION', appealId: key, penaltyId: row.id, input })
      );
      const previous = await tx.activityPenaltyAppeal.findUnique({
        where: { decidedById_decisionKey: { decidedById: actorId, decisionKey: input.idempotencyKey } }
      });
      if (previous) {
        if (previous.decisionFingerprint !== fingerprint || previous.id !== key)
          conflict('本次处理内容已变化，请重新确认');
        return { appeal: summary(previous), replayed: true };
      }
      supported(row);
      const appeal = await tx.activityPenaltyAppeal.findUnique({ where: { id: key } });
      if (!appeal || appeal.penaltyId !== row.id || appeal.accountId !== row.accountId) missing();
      if (appeal.status !== 'PENDING' || appeal.revision !== input.expectedAppealRevision || row.reversedAt)
        conflict('申诉或处罚记录已变化，请刷新');
      const standing = await settleActivityStanding(tx, row.accountId, now);
      const result =
        input.decision === 'APPROVE'
          ? await reverseManagementPenalty(tx, row.accountId, row.id, now, 'PENALTY_APPEAL_APPROVED')
          : null;
      const changed = await tx.activityPenaltyAppeal.update({
        where: { id: key },
        data: {
          status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          revision: { increment: 1 },
          decisionKey: input.idempotencyKey,
          decisionFingerprint: fingerprint,
          decisionReason: input.reason,
          decidedById: actorId,
          decidedAt: now
        }
      });
      await tx.accountAudit.create({
        data: {
          action: input.decision === 'APPROVE' ? 'PENALTY_APPEAL_APPROVED' : 'PENALTY_APPEAL_REJECTED',
          actorId,
          targetAccountId: row.accountId,
          reason: `申诉${key}：${input.reason}`,
          createdAt: now
        }
      });
      const points = result?.points ?? standing.points;
      await this.event(
        tx,
        {
          eventKey: `penalty-appeal-result:${key}`,
          activityId: row.activityId,
          registrationId: row.registrationId ?? undefined,
          kind: 'PENALTY_APPEAL_RESULT',
          channel: 'IN_APP',
          recipientId: row.accountId,
          payload: {
            appealId: key,
            result: input.decision,
            points,
            restricted: points >= 3,
            activityLink: `/activities/${row.activityId}`
          }
        },
        now
      );
      return { appeal: summary(changed), replayed: false };
    });
  }
  async appeals(url: URL, token?: string | null): Promise<PenaltyAppealPage> {
    const requestedPage = pagination(url),
      scope = url.searchParams.get('scope') ?? 'pending';
    if (scope !== 'pending' && scope !== 'handled') invalid('scope', '申诉范围无效');
    return this.auth.db.$transaction(
      async (tx) => {
        await this.auth.requireAccount(tx, token, true);
        const where = {
          penalty: { is: reasonScope },
          status: scope === 'pending' ? 'PENDING' : { in: ['APPROVED', 'REJECTED'] }
        };
        const total = await tx.activityPenaltyAppeal.count({ where }),
          pageSize = 10,
          totalPages = Math.ceil(total / pageSize);
        const page = Math.min(requestedPage, Math.max(1, totalPages));
        const rows = await tx.activityPenaltyAppeal.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: [{ createdAt: 'desc' }, { sequence: 'desc' }],
          select: {
            ...appealSelect,
            account: { select: { displayName: true } },
            penalty: { select: penaltySelect }
          }
        });
        return {
          page,
          pageSize,
          total,
          totalPages,
          items: rows.map((row) => ({
            ...summary(row),
            participantName: row.account.displayName || '成员',
            activityId: row.penalty.activity.id,
            activityTitle: row.penalty.activity.title,
            penaltyReason: row.penalty.reason as AppealablePenaltyReason,
            penaltyPoints: row.penalty.points,
            penaltyCreatedAt: row.penalty.createdAt.toISOString(),
            reversedAt: row.penalty.reversedAt?.toISOString() ?? null
          }))
        };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
  }
}
