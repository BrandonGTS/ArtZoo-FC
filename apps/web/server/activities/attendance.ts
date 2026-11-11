import {
  addActivityPenaltyPoints,
  reverseAttendancePenalty,
  reconcileActivityStanding,
  evaluateActivityCompletion,
  validAttendanceRecord,
  type Prisma
} from '@artzoo/db';
import {
  AccountError,
  activityId,
  invalid,
  validateAttendance,
  validateAttendanceAppeal,
  validateAttendanceDecision,
  type ActivityAttendance,
  type AttendanceAppeal,
  type AttendanceAppealPage,
  type AttendanceStatus,
  type AttendanceCommand
} from '@artzoo/domain';
import { lock } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import { ActivityService } from './service';

type Tx = Prisma.TransactionClient;
const person = { id: true, displayName: true, profile: { select: { avatarId: true } } } as const;
const appealSelect = {
  id: true,
  registrationId: true,
  attendanceRevision: true,
  requestedStatus: true,
  reason: true,
  status: true,
  revision: true,
  decisionReason: true,
  createdAt: true,
  decidedAt: true
} as const;
const registrationSelect = {
  id: true,
  activityId: true,
  accountId: true,
  status: true,
  attendanceStatus: true,
  attendanceSource: true,
  attendanceRevision: true,
  attendanceRecordedAt: true,
  attendanceUpdatedAt: true,
  attendancePenaltyId: true
} as const;
const activityFields = {
  scene: true,
  mode: true,
  id: true,
  organizerId: true,
  startsAt: true,
  endsAt: true,
  cancelledAt: true,
  continuedAt: true,
  seats: { select: { registration: { select: { id: true } } } }
} as const;
type Registration = Prisma.ActivityRegistrationGetPayload<{ select: typeof registrationSelect }>;
type Activity = Prisma.ActivityGetPayload<{ select: typeof activityFields }>;
type Appeal = Prisma.ActivityAttendanceAppealGetPayload<{ select: typeof appealSelect }>;
function missing(): never {
  throw new AccountError('NOT_FOUND', '到场记录不存在', 404);
}
const forbidden = (message: string): never => {
  throw new AccountError('FORBIDDEN', message, 403);
};
const conflict = (message: string): never => {
  throw new AccountError('CONFLICT', message, 409);
};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const appealSummary = (row: Appeal): AttendanceAppeal => ({
  id: row.id,
  registrationId: row.registrationId,
  attendanceRevision: row.attendanceRevision,
  requestedStatus: row.requestedStatus as AttendanceStatus,
  reason: row.reason,
  status: row.status as AttendanceAppeal['status'],
  revision: row.revision,
  decisionReason: row.decisionReason,
  createdAt: row.createdAt.toISOString(),
  decidedAt: row.decidedAt?.toISOString() ?? null
});
const snapshot = (row: Registration) =>
  json({
    registrationId: row.id,
    status: row.attendanceStatus,
    revision: row.attendanceRevision,
    recordedAt: row.attendanceRecordedAt,
    updatedAt: row.attendanceUpdatedAt,
    penaltyId: row.attendancePenaltyId
  });
function recordedInWindow(row: Registration, activity: Activity) {
  return validAttendanceRecord(activity, row);
}
export class ActivityAttendanceService extends ActivityService {
  private async view(tx: Tx, key: string, actorId: string): Promise<ActivityAttendance> {
    const activity = await tx.activity.findUnique({
      where: { id: key },
      select: {
        ...activityFields,
        registrations: {
          where: { status: 'ACTIVE' },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            ...registrationSelect,
            completion: { select: { active: true, evaluatedAt: true } },
            account: { select: person },
            attendanceAppeals: {
              where: { accountId: actorId },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 1,
              select: appealSelect
            }
          }
        }
      }
    });
    if (!activity) missing();
    if (activity.scene === 'OFFLINE' || activity.mode === 'SERIES') forbidden('该活动不支持普通单次到场操作');
    const now = this.auth.now(),
      eligible = true;
    const windowOpen = eligible && !activity.cancelledAt && now >= activity.startsAt && now < activity.endsAt;
    return {
      activityId: key,
      serverNow: now.toISOString(),
      startsAt: activity.startsAt.toISOString(),
      endsAt: activity.endsAt.toISOString(),
      isOrganizer: activity.organizerId === actorId,
      eligible,
      windowOpen,
      autoAbsence: true,
      cancelled: !!activity.cancelledAt,
      items: activity.registrations.map((row) => ({
        registrationId: row.id,
        participant: {
          id: row.account.id,
          displayName: row.account.displayName,
          avatarUrl: row.account.profile?.avatarId
            ? `/api/avatars/${row.account.profile.avatarId}?size=small`
            : null
        },
        source: row.attendanceSource,
        status: row.attendanceStatus as AttendanceStatus | null,
        revision: row.attendanceRevision,
        recordedAt: row.attendanceRecordedAt?.toISOString() ?? null,
        updatedAt: row.attendanceUpdatedAt?.toISOString() ?? null,
        completion:
          !activity.cancelledAt && row.attendanceStatus
            ? {
                status: row.completion
                  ? row.completion.active
                    ? 'CREDITED'
                    : 'NOT_CREDITED'
                  : row.attendanceStatus === 'PRESENT'
                    ? 'PENDING'
                    : 'NOT_CREDITED',
                evaluatedAt: row.completion?.evaluatedAt.toISOString() ?? null
              }
            : null,
        canEdit: windowOpen && activity.organizerId === actorId,
        canAppeal:
          eligible &&
          !activity.cancelledAt &&
          now >= activity.endsAt &&
          row.accountId === actorId &&
          recordedInWindow(row, activity) &&
          row.attendanceAppeals[0]?.status !== 'PENDING',
        appeal: row.attendanceAppeals[0] ? appealSummary(row.attendanceAppeals[0]) : null
      }))
    };
  }
  async attendance(id: string, token?: string | null) {
    const key = activityId(id);
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.auth.requireAccount(tx, token);
        return this.view(tx, key, actor.accountId);
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
  }
  private async run(
    key: string,
    registrationId: string,
    input: AttendanceCommand,
    token: string | null | undefined,
    kind: 'ATTENDANCE' | 'ATTENDANCE_APPEAL' | 'ATTENDANCE_DECISION',
    administrator: boolean,
    mutate: (
      tx: Tx,
      activity: Activity,
      row: Registration,
      actorId: string,
      now: Date
    ) => Promise<Prisma.InputJsonValue>
  ) {
    const actor = await this.auth.requireAccount(this.auth.db, token, administrator);
    await this.auth.rate(`activity-attendance:${actor.accountId}`, 120, 900);
    const target = await this.auth.db.activityRegistration.findUnique({
      where: { id: registrationId },
      select: { accountId: true, activityId: true }
    });
    if (!target || target.activityId !== key) missing();
    return this.auth.transaction(async (tx) => {
      // Do NOT call actorLocked first: both actor and score recipient must precede activity, in one global order.
      await lock(tx, `phone:${actor.account.phone}`);
      for (const accountId of [...new Set([actor.accountId, target.accountId])].sort())
        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${accountId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id" = ${actor.id} FOR UPDATE`;
      const fresh = await this.auth.requireAccount(tx, token, administrator);
      if (fresh.accountId !== actor.accountId) forbidden('请重新登录');
      await lock(tx, `activity:${key}`);
      await this.auth.requireAccount(tx, token, administrator);
      const fingerprint = tokenDigest(JSON.stringify({ kind, registrationId, input }));
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
        if (previous.requestFingerprint !== fingerprint) conflict('本次操作内容已变化，请重新确认');
        return { attendance: await this.view(tx, key, fresh.accountId), replayed: true };
      }
      const activity = await tx.activity.findUnique({ where: { id: key }, select: activityFields });
      const row = await tx.activityRegistration.findUnique({
        where: { id: registrationId },
        select: registrationSelect
      });
      if (!activity || !row || row.activityId !== key || row.accountId !== target.accountId) missing();
      if (activity.scene === 'OFFLINE' || activity.mode === 'SERIES')
        forbidden('该活动不支持普通单次到场操作');
      if (activity.cancelledAt || row.status !== 'ACTIVE') forbidden('仅未取消活动的有效报名可以登记或申诉');
      if (row.attendanceRevision !== input.expectedAttendanceRevision)
        conflict('到场记录已变化，请刷新后确认');
      const now = this.auth.now();
      const after = await mutate(tx, activity, row, fresh.accountId, now);
      await tx.activity.update({ where: { id: key }, data: { revision: { increment: 1 } } });
      await tx.activityCommand.create({
        data: {
          activityId: key,
          actorId: fresh.accountId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          kind,
          before: snapshot(row),
          after,
          createdAt: now
        }
      });
      return { attendance: await this.view(tx, key, fresh.accountId), replayed: false };
    });
  }
  private async change(
    tx: Tx,
    activity: Activity,
    row: Registration,
    next: AttendanceStatus,
    now: Date,
    reason: string
  ) {
    if (row.attendanceStatus === next) conflict('到场结果未变化');
    const evaluated = await evaluateActivityCompletion(tx, activity, row, now, 'DEFER');
    let completionRevision: number | null = null;
    if (evaluated && evaluated.record.active !== (next === 'PRESENT')) {
      const completion = await tx.activityCompletion.update({
        where: { id: evaluated.record.id },
        data: {
          active: next === 'PRESENT',
          revision: { increment: 1 },
          updatedAt: now
        }
      });
      completionRevision = completion.revision;
    }
    let correctedPoints: number | null = null;
    if (row.attendanceStatus === 'ABSENT') {
      if (!row.attendancePenaltyId) throw new Error('Missing attendance penalty');
      const result = await reverseAttendancePenalty(tx, row.accountId, row.attendancePenaltyId, now, reason);
      correctedPoints = result.points;
    }
    let penaltyId: string | null = null,
      totalPoints: number | null = null,
      penaltyEvent: string | null = null;
    if (next === 'ABSENT') {
      const eventKey = `attendance-no-show:${row.id}:${row.attendanceRevision + 1}`;
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
      penaltyId = penalty.id;
      penaltyEvent = eventKey;
      totalPoints = (await addActivityPenaltyPoints(tx, row.accountId, 2, now, eventKey, penalty.id)).points;
    }
    if (completionRevision !== null && row.attendanceStatus !== 'ABSENT') {
      const result = await reconcileActivityStanding(
        tx,
        row.accountId,
        now,
        `completion-corrected:${evaluated!.record.id}:${completionRevision}`,
        'COMPLETION_CORRECTED'
      );
      totalPoints = correctedPoints = result.points;
    }
    if (correctedPoints !== null)
      await this.event(
        tx,
        {
          eventKey: `attendance-corrected:${row.id}:${row.attendanceRevision + 1}`,
          activityId: activity.id,
          registrationId: row.id,
          kind: 'ACTIVITY_SCORE_CORRECTED',
          channel: 'IN_APP',
          recipientId: row.accountId,
          payload: { points: correctedPoints, activityLink: `/activities/${activity.id}` }
        },
        now
      );
    if (penaltyEvent)
      await this.event(
        tx,
        {
          eventKey: `penalty-notice:${penaltyEvent}`,
          activityId: activity.id,
          registrationId: row.id,
          kind: 'ACTIVITY_PENALTY',
          channel: 'IN_APP',
          recipientId: row.accountId,
          payload: { points: 2, totalPoints, reason: 'NO_SHOW', activityLink: `/activities/${activity.id}` }
        },
        now
      );
    const updated = await tx.activityRegistration.update({
      where: { id: row.id },
      data: {
        attendanceStatus: next,
        attendanceRevision: { increment: 1 },
        attendanceRecordedAt: row.attendanceRecordedAt ?? now,
        attendanceUpdatedAt: now,
        attendanceSource: row.attendanceSource ?? 'ORGANIZER',
        attendancePenaltyId: penaltyId
      },
      select: registrationSelect
    });
    return snapshot(updated);
  }
  async record(id: string, body: Record<string, unknown>, token?: string | null) {
    const key = activityId(id),
      input = validateAttendance(body);
    return this.run(
      key,
      input.registrationId,
      input,
      token,
      'ATTENDANCE',
      false,
      async (tx, activity, row, actorId, now) => {
        if (activity.organizerId !== actorId) forbidden('仅活动发起者可以登记或更正到场');
        if (now < activity.startsAt || now >= activity.endsAt)
          forbidden('仅能在预定开始至预定结束前登记或更正；截止未填不可补录');
        return this.change(tx, activity, row, input.status, now, 'ORGANIZER_CORRECTION');
      }
    );
  }
  async appeal(id: string, body: Record<string, unknown>, token?: string | null) {
    const key = activityId(id),
      input = validateAttendanceAppeal(body);
    return this.run(
      key,
      input.registrationId,
      input,
      token,
      'ATTENDANCE_APPEAL',
      false,
      async (tx, activity, row, actorId, now) => {
        if (actorId !== row.accountId) forbidden('仅本人可以申诉自己的到场结果');
        if (now < activity.endsAt) forbidden('截止前请联系发起者更正到场结果');
        if (!recordedInWindow(row, activity)) forbidden('未登记记录不能通过申诉补登记');
        if (input.requestedStatus === row.attendanceStatus) conflict('申请结果与现有记录相同');
        if (
          await tx.activityAttendanceAppeal.findFirst({
            where: { registrationId: row.id, status: 'PENDING' },
            select: { id: true }
          })
        )
          conflict('已有待处理申诉，请等待处理');
        const created = await tx.activityAttendanceAppeal.create({
          data: {
            registrationId: row.id,
            accountId: actorId,
            attendanceRevision: row.attendanceRevision,
            requestedStatus: input.requestedStatus,
            reason: input.reason,
            createdAt: now
          },
          select: { id: true }
        });
        return json({ appealId: created.id, requestedStatus: input.requestedStatus, status: 'PENDING' });
      }
    );
  }
  async decide(appealId: string, body: Record<string, unknown>, token?: string | null) {
    const key = activityId(appealId),
      input = validateAttendanceDecision(body);
    await this.auth.requireAccount(this.auth.db, token, true);
    const seed = await this.auth.db.activityAttendanceAppeal.findUnique({
      where: { id: key },
      select: {
        registrationId: true,
        registration: { select: { activityId: true } }
      }
    });
    if (!seed) missing();
    const keyedInput = { ...input, appealId: key };
    return this.run(
      seed.registration.activityId,
      seed.registrationId,
      keyedInput,
      token,
      'ATTENDANCE_DECISION',
      true,
      async (tx, activity, row, actorId, now) => {
        const appeal = await tx.activityAttendanceAppeal.findUnique({ where: { id: key } });
        if (!appeal || appeal.registrationId !== row.id) missing();
        if (
          appeal.status !== 'PENDING' ||
          appeal.revision !== input.expectedAppealRevision ||
          appeal.attendanceRevision !== row.attendanceRevision
        )
          conflict('申诉或到场记录已变化，请刷新');
        if (now < activity.endsAt || !recordedInWindow(row, activity))
          forbidden('只能处理截止后的已有登记结果，不能补录');
        const result =
          input.decision === 'APPROVE'
            ? await this.change(
                tx,
                activity,
                row,
                appeal.requestedStatus as AttendanceStatus,
                now,
                'APPEAL_APPROVED'
              )
            : snapshot(row);
        await tx.activityAttendanceAppeal.update({
          where: { id: key },
          data: {
            status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
            revision: { increment: 1 },
            decisionReason: input.reason,
            decidedById: actorId,
            decidedAt: now
          }
        });
        await this.event(
          tx,
          {
            eventKey: `attendance-appeal-result:${key}`,
            activityId: activity.id,
            registrationId: row.id,
            kind: 'ATTENDANCE_APPEAL_RESULT',
            channel: 'IN_APP',
            recipientId: row.accountId,
            payload: { appealId: key, result: input.decision, activityLink: `/activities/${activity.id}` }
          },
          now
        );
        return json({ appealId: key, result: input.decision, attendance: result });
      }
    );
  }
  async appeals(url: URL, token?: string | null): Promise<AttendanceAppealPage> {
    return this.auth.db.$transaction(
      async (tx) => {
        await this.auth.requireAccount(tx, token, true);
        const pageValue = url.searchParams.get('page') ?? '1',
          scope = url.searchParams.get('scope') ?? 'pending';
        if (!/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(Number(pageValue)))
          invalid('page', '页码无效');
        if (scope !== 'pending' && scope !== 'handled') invalid('scope', '申诉范围无效');
        const where = { status: scope === 'pending' ? 'PENDING' : { in: ['APPROVED', 'REJECTED'] } };
        const total = await tx.activityAttendanceAppeal.count({ where }),
          pageSize = 10;
        const totalPages = Math.ceil(total / pageSize),
          page = Math.min(Number(pageValue), Math.max(1, totalPages));
        const rows = await tx.activityAttendanceAppeal.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            ...appealSelect,
            account: { select: { displayName: true } },
            registration: {
              select: { attendanceStatus: true, activity: { select: { id: true, title: true } } }
            }
          }
        });
        return {
          page,
          pageSize,
          total,
          totalPages,
          items: rows.map((row) => ({
            ...appealSummary(row),
            activityId: row.registration.activity.id,
            activityTitle: row.registration.activity.title,
            participantName: row.account.displayName || '成员',
            currentStatus: row.registration.attendanceStatus as AttendanceStatus | null
          }))
        };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
  }
}
