import { requireActiveTargets } from '../auth/active-targets';
import type { Prisma } from '@artzoo/db';
import {
  AccountError,
  BEIJING_OFFSET_MS,
  beijingDateKey,
  activityId,
  invalid,
  jobMeetsSeat,
  teamCommand,
  teamPage,
  teamJob,
  teamPosition,
  teamText,
  teamTimes,
  teamBatchTimes,
  teamMetadata,
  teamApplicationInput,
  TEAM_PAGE_SIZE,
  teamCycleWindow,
  teamSessionInCycle,
  validateCreateTeam,
  validateGameNickname,
  validateGameServer,
  type TeamPerson,
  type TeamParticipationChangeView,
  type TeamDetail,
  type TeamHistory,
  type TeamHistoryPage,
  type TeamList,
  type TeamSummary,
  type TeamWriteResult,
  type SeatRequirement
} from '@artzoo/domain';
import { AccountService, lock } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
type Tx = Prisma.TransactionClient;
const personSelect = {
  id: true,
  displayName: true,
  gameRegion: true,
  gameServer: true,
  profile: { select: { avatarId: true } }
} as const;
type PersonRow = Prisma.AccountGetPayload<{ select: typeof personSelect }>;
function person(row: PersonRow): TeamPerson {
  return {
    id: row.id,
    displayName: row.displayName,
    gameRegion: row.gameRegion,
    gameServer: row.gameServer,
    avatarUrl: row.profile?.avatarId ? `/api/avatars/${row.profile.avatarId}?size=small` : null
  };
}
const recordsInclude = {
  orderBy: { revision: 'desc' as const },
  include: { actor: { select: personSelect } }
};
function participationRecords(
  rows: { id: string; status: string; reason: string; actor: PersonRow; recordedAt: Date }[]
): TeamParticipationChangeView[] {
  return rows.map((r) => ({
    id: r.id,
    status: r.status as TeamParticipationChangeView['status'],
    reason: r.reason,
    actor: person(r.actor),
    recordedAt: r.recordedAt.toISOString()
  }));
}
const teamSelect = {
  id: true,
  name: true,
  description: true,
  dutyName: true,
  progress: true,
  strategy: true,
  commonTimes: true,
  createdAt: true,
  recruitmentCompletedAt: true,
  qqGroupId: true,
  state: true,
  revision: true,
  creatorId: true,
  creator: { select: personSelect },
  seats: {
    orderBy: { position: 'asc' as const },
    include: {
      _count: { select: { applications: { where: { state: 'PENDING' } } } },
      membership: { include: { account: { select: personSelect } } }
    }
  },
  memberships: {
    where: { state: 'ACTIVE' },
    orderBy: { position: 'asc' as const },
    include: { account: { select: personSelect } }
  },
  applications: {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    include: { account: { select: personSelect }, seat: { select: { position: true } } }
  },
  sessions: {
    orderBy: [{ startsAt: 'asc' as const }, { id: 'asc' as const }],
    include: {
      feedback: true,
      members: {
        orderBy: { position: 'asc' as const },
        include: { account: { select: personSelect }, leave: true, participationChanges: recordsInclude }
      },
      substitutes: {
        where: { endedAt: null },
        orderBy: { position: 'asc' as const },
        include: { account: { select: personSelect }, participationChanges: recordsInclude }
      }
    }
  }
} as const satisfies Prisma.FixedTeamSelect;
const teamSummarySelect = {
  id: true,
  name: true,
  description: true,
  dutyName: true,
  progress: true,
  strategy: true,
  commonTimes: true,
  createdAt: true,
  recruitmentCompletedAt: true,
  state: true,
  revision: true,
  creatorId: true,
  creator: { select: personSelect },
  seats: {
    orderBy: { position: 'asc' as const },
    select: {
      id: true,
      position: true,
      kind: true,
      role: true,
      job: true,
      _count: { select: { applications: { where: { state: 'PENDING' } } } },
      membership: { select: { id: true, state: true, job: true, account: { select: personSelect } } }
    }
  },
  memberships: { where: { state: 'ACTIVE' }, select: { accountId: true } }
} as const satisfies Prisma.FixedTeamSelect;
type Row = Prisma.FixedTeamGetPayload<{ select: typeof teamSelect }>;
type SummaryRow = Prisma.FixedTeamGetPayload<{ select: typeof teamSummarySelect }>;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const forbidden = (message: string): never => {
  throw new AccountError('FORBIDDEN', message, 403);
};
const conflict = (message: string): never => {
  throw new AccountError('CONFLICT', message, 409);
};
function requirement(seat: Pick<Row['seats'][number], 'kind' | 'role' | 'job'>): SeatRequirement {
  return seat.kind === 'JOB' ? { kind: 'JOB', job: seat.job! } : { kind: 'ROLE', role: seat.role! };
}
function summary(row: SummaryRow, actorId: string): TeamSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    dutyName: row.dutyName,
    progress: row.progress,
    strategy: row.strategy,
    commonTimes: row.commonTimes,
    createdAt: row.createdAt.toISOString(),
    recruitmentCompletedAt: row.recruitmentCompletedAt?.toISOString() ?? null,
    state: row.state,
    revision: row.revision,
    creator: person(row.creator),
    isCreator: row.creatorId === actorId,
    isMember: row.state === 'ACTIVE' && row.memberships.some((m) => m.accountId === actorId),
    seats: row.seats.map((s) => ({
      id: s.id,
      position: s.position,
      requirement: requirement(s),
      pendingApplicationCount: s._count.applications,
      member:
        s.membership?.state === 'ACTIVE'
          ? { id: s.membership.id, person: person(s.membership.account), job: s.membership.job }
          : null
    }))
  };
}
function detail(row: Row, actorId: string, now: Date): TeamDetail {
  const base = summary(row, actorId),
    internal = base.isCreator || base.isMember;
  return {
    ...base,
    currentAccountId: actorId,
    serverNow: now.toISOString(),
    qqGroupId: base.isCreator ? row.qqGroupId : null,
    applications: row.applications
      .filter((a) => base.isCreator || a.accountId === actorId)
      .map((a) => ({
        id: a.id,
        seatPosition: a.seat.position,
        person: person(a.account),
        job: a.job,
        note: a.note,
        state: a.state
      })),
    sessions: !internal
      ? null
      : row.sessions.map((s) => ({
          id: s.id,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          state: s.state as 'PROPOSED' | 'CONFIRMED' | 'CANCELLED',
          timeVersion: s.timeVersion,
          feedback: row.memberships.map((m) => ({
            person: person(m.account),
            choice:
              (s.feedback.find((f) => f.accountId === m.accountId && f.timeVersion === s.timeVersion)
                ?.choice as 'CAN' | 'CANNOT' | undefined) ?? null
          })),
          myChoice:
            (s.feedback.find((f) => f.accountId === actorId && f.timeVersion === s.timeVersion)?.choice as
              'CAN' | 'CANNOT' | undefined) ?? null,
          members: s.members
            .filter((m) => m.timeVersion === s.timeVersion)
            .map((m) => ({
              id: m.id,
              person: person(m.account),
              position: m.position,
              job: m.job,
              state: m.state,
              records: participationRecords(m.participationChanges),
              leave: m.leave
                ? {
                    reason: m.leave.reason,
                    recordedById: m.leave.recordedById,
                    createdAt: m.leave.createdAt.toISOString()
                  }
                : null
            })),
          substitutes: s.substitutes
            .filter((m) => m.timeVersion === s.timeVersion)
            .map((m) => ({
              id: m.id,
              position: m.position,
              person: m.account ? person(m.account) : null,
              displayName: m.displayName,
              gameRegion: m.gameRegion,
              gameServer: m.gameServer,
              job: m.job,
              records: participationRecords(m.participationChanges)
            }))
        }))
  };
}
export class TeamService {
  constructor(readonly auth: AccountService) {}
  private async actorLocked(
    tx: Tx,
    token: string | null | undefined,
    actor: Awaited<ReturnType<AccountService['requireAccount']>>
  ) {
    await lock(tx, `phone:${actor.account.phone}`);
    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${actor.accountId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id" = ${actor.id} FOR UPDATE`;
    const fresh = await this.auth.requireAccount(tx, token);
    if (fresh.accountId !== actor.accountId || fresh.id !== actor.id) forbidden('请重新登录');
    return fresh;
  }
  private async verifySession(
    tx: Tx,
    token: string | null | undefined,
    actor: Awaited<ReturnType<AccountService['requireAccount']>>
  ) {
    const fresh = await this.auth.requireAccount(tx, token);
    if (fresh.id !== actor.id || fresh.accountId !== actor.accountId || fresh.expiresAt <= this.auth.now()) {
      throw new AccountError('UNAUTHENTICATED', '请先登录', 401);
    }
  }
  private exactSessionAvailable(row: Row, times: { startsAt: Date; endsAt: Date }, exceptId?: string) {
    if (
      row.sessions.some(
        (session) =>
          session.id !== exceptId &&
          session.state !== 'CANCELLED' &&
          session.startsAt.getTime() === times.startsAt.getTime() &&
          session.endsAt.getTime() === times.endsAt.getTime()
      )
    ) {
      const instant = times.startsAt.getTime(),
        beijing = new Date(instant + BEIJING_OFFSET_MS),
        year = beijing.getUTCFullYear(),
        date =
          Number.isSafeInteger(instant) && year >= 0 && year <= 9999
            ? beijingDateKey(instant)
            : beijing.toISOString().slice(0, 10);
      conflict(`${date}已存在完全相同时间的未取消场次`);
    }
  }
  private async load(tx: Tx, id: string): Promise<Row> {
    const row = await tx.fixedTeam.findUnique({ where: { id }, select: teamSelect });
    if (!row) throw new AccountError('NOT_FOUND', '固定队不存在', 404);
    return row;
  }
  private async loadForReader(tx: Tx, id: string, actorId: string): Promise<Row> {
    const row = await tx.fixedTeam.findUnique({
      where: { id },
      select: { ...teamSelect, applications: false, sessions: false }
    });
    if (!row) throw new AccountError('NOT_FOUND', '固定队不存在', 404);
    const applications = await tx.teamApplication.findMany({
      ...teamSelect.applications,
      where: { teamId: id, ...(row.creatorId === actorId ? {} : { accountId: actorId }) }
    });
    const internal =
      row.creatorId === actorId ||
      (row.state === 'ACTIVE' && row.memberships.some((member) => member.accountId === actorId));
    const sessions = internal
      ? await tx.teamSession.findMany({ ...teamSelect.sessions, where: { teamId: id } })
      : [];
    return { ...row, applications, sessions };
  }
  private async notify(
    tx: Tx,
    row: Pick<Row, 'id' | 'name' | 'qqGroupId'>,
    key: string,
    kind: string,
    recipients: string[],
    now: Date,
    group = false,
    session?: { id: string; startsAt: Date; endsAt: Date },
    context?: { participantName: string | null; position: number },
    actorId: string | null = null
  ) {
    const payload = {
      ...context,
      actorId,
      teamName: row.name,
      teamLink: `/teams/${row.id}`,
      ...(session
        ? {
            sessionId: session.id,
            startsAt: session.startsAt.toISOString(),
            endsAt: session.endsAt.toISOString()
          }
        : {})
    };
    for (const recipientId of new Set(recipients))
      await tx.teamNotification.create({
        data: {
          eventKey: `${key}:${recipientId}`,
          teamId: row.id,
          recipientId,
          kind,
          channel: 'IN_APP',
          payload,
          createdAt: now,
          simulatedAt: now
        }
      });
    if (group && row.qqGroupId)
      await tx.teamNotification.create({
        data: {
          eventKey: `${key}:qq`,
          teamId: row.id,
          kind,
          channel: 'QQ',
          qqGroupTarget: row.qqGroupId,
          payload,
          createdAt: now,
          simulatedAt: now
        }
      });
  }
  async create(body: Record<string, unknown>, token?: string | null): Promise<TeamWriteResult> {
    const input = validateCreateTeam(body),
      actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`team-create:${actor.accountId}`, 60, 900);
    return this.auth.transaction(async (tx) => {
      const fresh = await this.actorLocked(tx, token, actor);
      if (fresh.account.membership !== 'MEMBER') forbidden('仅正式成员可以创建固定队');
      await lock(tx, `team-create:${fresh.accountId}:${input.idempotencyKey}`);
      const fingerprint = tokenDigest(JSON.stringify(input));
      const previous = await tx.fixedTeam.findUnique({
        where: {
          creatorId_idempotencyKey: { creatorId: fresh.accountId, idempotencyKey: input.idempotencyKey }
        },
        select: { id: true, requestFingerprint: true }
      });
      if (previous) {
        if (previous.requestFingerprint !== fingerprint) conflict('本次建队内容已变化，请重新确认');
        return {
          team: detail(await this.load(tx, previous.id), fresh.accountId, this.auth.now()),
          replayed: true
        };
      }
      const now = this.auth.now(),
        team = await tx.fixedTeam.create({
          data: {
            creatorId: fresh.accountId,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: fingerprint,
            name: input.name,
            description: input.description,
            dutyName: input.dutyName,
            progress: input.progress,
            strategy: input.strategy,
            commonTimes: input.commonTimes,
            qqGroupId: input.qqGroupId,
            createdAt: now,
            seats: {
              create: input.seats.map((s) => ({
                position: s.position,
                kind: s.requirement.kind,
                role: s.requirement.kind === 'ROLE' ? s.requirement.role : null,
                job: s.requirement.kind === 'JOB' ? s.requirement.job : null
              }))
            }
          },
          select: { id: true }
        });
      const row = await this.load(tx, team.id);
      return { team: detail(row, fresh.accountId, this.auth.now()), replayed: false };
    });
  }
  private async run(
    id: string,
    body: Record<string, unknown>,
    token: string | null | undefined,
    kind: string,
    fields: string[],
    mutate: (tx: Tx, row: Row, actorId: string, now: Date, eventKey: string) => Promise<unknown>,
    permission: 'owner' | 'member' | 'registered' = 'owner',
    allowArchived = false
  ): Promise<TeamWriteResult> {
    const key = activityId(id),
      input = teamCommand(body, fields),
      actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`team-manage:${actor.accountId}`, 120, 900);
    return this.auth.transaction(async (tx) => {
      const fresh = await this.actorLocked(tx, token, actor);
      await lock(tx, `team:${key}`);
      await this.verifySession(tx, token, fresh);
      const row = await this.load(tx, key);
      if (permission === 'owner' && row.creatorId !== fresh.accountId)
        forbidden('仅固定队创建者可以执行此操作');
      if (permission === 'member' && !row.memberships.some((m) => m.accountId === fresh.accountId))
        forbidden('仅本队成员可以填写反馈');
      const fingerprint = tokenDigest(JSON.stringify({ kind, body }));
      const previous = await tx.teamCommand.findUnique({
        where: {
          teamId_actorId_idempotencyKey: {
            teamId: key,
            actorId: fresh.accountId,
            idempotencyKey: input.idempotencyKey
          }
        }
      });
      if (previous) {
        if (previous.requestFingerprint !== fingerprint) conflict('本次操作内容已变化，请重新确认');
        await this.verifySession(tx, token, fresh);
        return { team: detail(row, fresh.accountId, this.auth.now()), replayed: true };
      }
      if (row.state !== 'ACTIVE' && !allowArchived) forbidden('固定队已解散');
      if (row.revision !== input.expectedRevision) conflict('队伍信息已更新，请刷新后重新确认');
      const now = this.auth.now(),
        eventKey = `team:${key}:${input.idempotencyKey}`;
      const affected = await mutate(tx, row, fresh.accountId, now, eventKey);
      await tx.fixedTeam.update({ where: { id: key }, data: { revision: { increment: 1 } } });
      await tx.teamCommand.create({
        data: {
          teamId: key,
          actorId: fresh.accountId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          kind,
          before: { revision: row.revision },
          after: json({ revision: row.revision + 1, affected }),
          createdAt: now
        }
      });
      const updated = await this.load(tx, key);
      await this.verifySession(tx, token, fresh);
      return { team: detail(updated, fresh.accountId, this.auth.now()), replayed: false };
    });
  }
  async apply(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'APPLY',
      ['position', 'job', 'note'],
      async (tx, row, actorId, now, eventKey) => {
        if (row.recruitmentCompletedAt) forbidden('招募已完成，无法继续申请');
        if (row.memberships.some((m) => m.accountId === actorId)) conflict('你已在该队伍中');
        const position = teamPosition(body.position),
          seat = row.seats[position]!;
        const { job, note } = teamApplicationInput(body, requirement(seat));
        if (seat.membership) conflict('该席位已有队员');
        if (!jobMeetsSeat(requirement(seat), job)) invalid('job', '职业不符合席位要求');
        if (row.applications.some((a) => a.accountId === actorId && a.state === 'PENDING'))
          conflict('你已有待审申请，请先撤回再申请其他席位');
        const isCreator = row.creatorId === actorId;
        const application = await tx.teamApplication.create({
          data: {
            teamId: row.id,
            seatId: seat.id,
            accountId: actorId,
            job,
            note,
            createdAt: now,
            state: isCreator ? 'ACCEPTED' : 'PENDING',
            decidedAt: isCreator ? now : null
          }
        });
        if (isCreator) {
          await tx.teamMembership.create({
            data: { teamId: row.id, seatId: seat.id, position, accountId: actorId, job, joinedAt: now }
          });
          await this.closeSeatApplications(tx, row, seat.id, application.id, actorId, now, eventKey);
        } else {
          await this.notify(
            tx,
            row,
            eventKey,
            'TEAM_APPLICATION',
            [row.creatorId],
            now,
            false,
            undefined,
            undefined,
            actorId
          );
        }
        return { applicationId: application.id, position };
      },
      'registered'
    );
  }
  async decide(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'APPLICATION_DECISION',
      ['applicationId', 'decision'],
      async (tx, row, _actorId, now, eventKey) => {
        if (row.recruitmentCompletedAt) forbidden('招募已完成，无法审核申请');
        const applicationId = activityId(body.applicationId, 'applicationId'),
          application = row.applications.find((a) => a.id === applicationId);
        if (!application) throw new AccountError('NOT_FOUND', '申请不存在', 404);
        if (body.decision !== 'ACCEPT' && body.decision !== 'REJECT') invalid('decision', '请选择接受或拒绝');
        if (application.state !== 'PENDING') conflict('该申请已处理');
        if (body.decision === 'ACCEPT') {
          await requireActiveTargets(tx, [application.accountId]);
          const seat = row.seats.find((s) => s.id === application.seatId)!;
          if (seat.membership || row.memberships.some((m) => m.accountId === application.accountId))
            conflict('席位或成员已变化，请刷新');
          if (!jobMeetsSeat(requirement(seat), application.job)) conflict('申请职业已不符合席位要求');
          await tx.teamMembership.create({
            data: {
              teamId: row.id,
              seatId: seat.id,
              position: seat.position,
              accountId: application.accountId,
              job: application.job,
              joinedAt: now
            }
          });
        }
        if (body.decision === 'ACCEPT') {
          await this.closeSeatApplications(
            tx,
            row,
            application.seatId,
            application.id,
            application.accountId,
            now,
            eventKey
          );
        }
        await tx.teamApplication.update({
          where: { id: application.id },
          data: { state: body.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED', decidedAt: now }
        });
        await this.notify(
          tx,
          row,
          eventKey,
          body.decision === 'ACCEPT' ? 'TEAM_ACCEPTED' : 'TEAM_REJECTED',
          [application.accountId],
          now,
          false,
          undefined,
          undefined,
          _actorId
        );
        return { applicationId, decision: body.decision };
      }
    );
  }
  private async closeSeatApplications(
    tx: Tx,
    row: Row,
    seatId: string,
    applicationId: string,
    accountId: string,
    now: Date,
    eventKey: string
  ) {
    const competing = row.applications.filter(
      (a) => a.id !== applicationId && a.seatId === seatId && a.state === 'PENDING'
    );
    await tx.teamApplication.updateMany({
      where: { id: { in: competing.map((a) => a.id) }, state: 'PENDING' },
      data: { state: 'CANCELLED', decidedAt: now }
    });
    await this.notify(
      tx,
      row,
      eventKey + ':seat-filled',
      'TEAM_SEAT_FILLED',
      competing.filter((a) => a.accountId !== accountId).map((a) => a.accountId),
      now,
      false,
      undefined,
      { participantName: null, position: row.seats.find((s) => s.id === seatId)!.position }
    );
  }
  async edit(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'EDIT_TEAM',
      ['name', 'description', 'dutyName', 'progress', 'strategy', 'commonTimes', 'qqGroupId'],
      async (tx, row) => {
        const input = teamMetadata(body);
        await tx.fixedTeam.update({ where: { id: row.id }, data: input });
        return input;
      }
    );
  }
  async withdrawApplication(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'WITHDRAW_APPLICATION',
      ['applicationId'],
      async (tx, row, actorId, now) => {
        const applicationId = activityId(body.applicationId, 'applicationId'),
          application = row.applications.find((a) => a.id === applicationId);
        if (!application || application.accountId !== actorId)
          throw new AccountError('NOT_FOUND', '申请不存在', 404);
        if (application.state !== 'PENDING') conflict('该申请已处理');
        await tx.teamApplication.update({
          where: { id: application.id },
          data: { state: 'CANCELLED', decidedAt: now }
        });
        return { applicationId };
      },
      'registered'
    );
  }
  async addMember(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'ADD_MEMBER',
      ['position', 'memberId', 'job'],
      async (tx, row, _actorId, now, eventKey) => {
        const position = teamPosition(body.position),
          memberId = activityId(body.memberId, 'memberId'),
          job = teamJob(body.job),
          seat = row.seats[position]!;
        if (seat.membership || row.memberships.some((m) => m.accountId === memberId))
          conflict('席位已占用或成员已在队中');
        if (!jobMeetsSeat(requirement(seat), job)) invalid('job', '职业不符合席位要求');
        if (!(await tx.account.findUnique({ where: { id: memberId }, select: { id: true } })))
          invalid('memberId', '请选择已注册站内成员');
        await requireActiveTargets(tx, [memberId]);
        const member = await tx.teamMembership.create({
          data: { teamId: row.id, seatId: seat.id, position, accountId: memberId, job, joinedAt: now }
        });
        await this.notify(
          tx,
          row,
          eventKey,
          'TEAM_JOINED',
          [memberId],
          now,
          false,
          undefined,
          undefined,
          _actorId
        );
        return { membershipId: member.id };
      }
    );
  }
  async propose(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'PROPOSE_SESSION',
      ['startsAt', 'endsAt', 'cycleStart'],
      async (tx, row, _actorId, now, eventKey) => {
        const times = teamTimes(body);
        if (times.startsAt <= now) invalid('startsAt', '请选择未来开始时间');
        if (body.cycleStart !== undefined) {
          const cycle = teamCycleWindow(now, 1);
          if (body.cycleStart !== cycle.startsAt.toISOString()) conflict('周排期范围已变化，请重新确认');
          if (!teamSessionInCycle(times.startsAt, cycle)) invalid('startsAt', '开场时间须在所选周范围内');
        }
        this.exactSessionAvailable(row, times);
        const session = await tx.teamSession.create({ data: { teamId: row.id, ...times, createdAt: now } });
        await this.notify(
          tx,
          row,
          eventKey,
          'TEAM_SCHEDULE_PROPOSED',
          row.memberships.map((m) => m.accountId),
          now,
          true,
          session,
          undefined,
          _actorId
        );
        return { sessionId: session.id, ...times };
      }
    );
  }
  async proposeBatch(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'PROPOSE_SESSION_BATCH',
      ['cycleStart', 'sessions'],
      async (tx, row, actorId, now, eventKey) => {
        const cycle = teamCycleWindow(now, 1);
        if (body.cycleStart !== cycle.startsAt.toISOString()) conflict('周排期范围已变化，请重新确认');
        const sessions = teamBatchTimes(body, cycle);
        for (const [index, times] of sessions.entries()) {
          if (times.startsAt <= now) invalid(`sessions.${index}.startsAt`, '请选择未来开始时间');
          this.exactSessionAvailable(row, times);
        }
        const created = [];
        for (const times of sessions) {
          const session = await tx.teamSession.create({ data: { teamId: row.id, ...times, createdAt: now } });
          await this.notify(
            tx,
            row,
            `${eventKey}:session:${session.id}`,
            'TEAM_SCHEDULE_PROPOSED',
            row.memberships.map((member) => member.accountId),
            now,
            true,
            session,
            undefined,
            actorId
          );
          created.push({ sessionId: session.id, ...times });
        }
        return { sessions: created };
      }
    );
  }
  async editSession(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'EDIT_SESSION',
      ['sessionId', 'startsAt', 'endsAt', 'cycleStart'],
      async (tx, row, _actorId, now, eventKey) => {
        const session = row.sessions.find((s) => s.id === activityId(body.sessionId, 'sessionId'));
        if (!session) throw new AccountError('NOT_FOUND', '场次不存在', 404);
        if (session.state === 'CANCELLED' || session.startsAt <= now)
          forbidden('仅可修改未开始且未取消的场次');
        const times = teamTimes(body);
        if (times.startsAt <= now) invalid('startsAt', '请选择未来开始时间');
        if (body.cycleStart !== undefined) {
          const cycle = teamCycleWindow(now, 1);
          if (body.cycleStart !== cycle.startsAt.toISOString()) conflict('周排期范围已变化，请重新确认');
          if (!teamSessionInCycle(session.startsAt, cycle) || !teamSessionInCycle(times.startsAt, cycle))
            invalid('startsAt', '本场及调整后的开场时间须在所选周范围内');
        }
        if (
          times.startsAt.getTime() === session.startsAt.getTime() &&
          times.endsAt.getTime() === session.endsAt.getTime()
        )
          conflict('场次时间未变化');
        this.exactSessionAvailable(row, times, session.id);
        await tx.teamSession.update({
          where: { id: session.id },
          data: { ...times, timeVersion: { increment: 1 }, state: 'PROPOSED', confirmedAt: null }
        });
        await this.notify(
          tx,
          row,
          eventKey,
          'TEAM_SCHEDULE_CHANGED',
          this.sessionRecipients(row, session),
          now,
          true,
          { ...session, ...times },
          undefined,
          _actorId
        );
        return { sessionId: session.id, timeVersion: session.timeVersion + 1, ...times };
      }
    );
  }
  async feedback(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'FEEDBACK',
      ['choices'],
      async (tx, row, actorId, now, eventKey) => {
        if (!Array.isArray(body.choices) || !body.choices.length || body.choices.length > 200)
          invalid('choices', '请选择要提交反馈的具体场次');
        const seen = new Set<string>(),
          choices = body.choices.map((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value))
              invalid('choices', '反馈格式无效');
            const v = value as Record<string, unknown>;
            if (Object.keys(v).some((k) => !['sessionId', 'timeVersion', 'choice'].includes(k)))
              invalid('choices', '反馈包含无效字段');
            const sessionId = activityId(v.sessionId, 'sessionId'),
              session = row.sessions.find((s) => s.id === sessionId);
            if (!session) throw new AccountError('NOT_FOUND', '场次不存在', 404);
            if (session.state !== 'PROPOSED' || session.startsAt <= now)
              forbidden('仅可反馈本队未开始的待确认场次');
            if (v.timeVersion !== session.timeVersion || seen.has(sessionId))
              conflict('排期时间已更新或重复，请重新填写');
            if (v.choice !== 'CAN' && v.choice !== 'CANNOT') invalid('choice', '请选择可参加或不可参加');
            seen.add(sessionId);
            return { sessionId, timeVersion: session.timeVersion, choice: v.choice as string };
          });
        for (const choice of choices)
          await tx.teamFeedback.upsert({
            where: {
              sessionId_timeVersion_accountId: {
                sessionId: choice.sessionId,
                timeVersion: choice.timeVersion,
                accountId: actorId
              }
            },
            create: { ...choice, accountId: actorId, updatedAt: now },
            update: { choice: choice.choice, updatedAt: now }
          });
        await this.notify(
          tx,
          row,
          eventKey,
          'TEAM_FEEDBACK',
          [row.creatorId],
          now,
          false,
          undefined,
          undefined,
          actorId
        );
        return { choices };
      },
      'member'
    );
  }
  async confirm(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'CONFIRM_SESSION',
      ['sessionId'],
      async (tx, row, _actorId, now, eventKey) => {
        const session = row.sessions.find((s) => s.id === activityId(body.sessionId, 'sessionId'));
        if (!session) throw new AccountError('NOT_FOUND', '场次不存在', 404);
        if (session.state !== 'PROPOSED' || session.startsAt <= now) forbidden('仅可确认未开始的待定场次');
        await requireActiveTargets(
          tx,
          row.memberships.map((member) => member.accountId)
        );
        for (const member of row.memberships)
          await tx.teamSessionMember.create({
            data: {
              sessionId: session.id,
              timeVersion: session.timeVersion,
              membershipId: member.id,
              accountId: member.accountId,
              position: member.position,
              job: member.job,
              confirmedStartsAt: session.startsAt,
              confirmedEndsAt: session.endsAt
            }
          });
        await tx.teamSession.update({
          where: { id: session.id },
          data: { state: 'CONFIRMED', confirmedAt: now }
        });
        await this.notify(
          tx,
          row,
          eventKey,
          'TEAM_SCHEDULE_CONFIRMED',
          row.memberships.map((m) => m.accountId),
          now,
          true,
          session,
          undefined,
          _actorId
        );
        return { sessionId: session.id, members: row.memberships.map((m) => m.id) };
      }
    );
  }
  private sessionRecipients(row: Row, session: Row['sessions'][number]) {
    return [
      ...row.memberships.map((m) => m.accountId),
      ...session.substitutes.flatMap((m) =>
        m.timeVersion === session.timeVersion && m.accountId ? [m.accountId] : []
      )
    ];
  }
  async cancelSession(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'CANCEL_SESSION',
      ['sessionId', 'confirmed'],
      async (tx, row, _actorId, now, eventKey) => {
        if (body.confirmed !== true) invalid('confirmed', '请确认取消本场排期');
        const session = row.sessions.find((s) => s.id === activityId(body.sessionId, 'sessionId'));
        if (!session) throw new AccountError('NOT_FOUND', '场次不存在', 404);
        if (session.state === 'CANCELLED' || session.startsAt <= now) forbidden('仅可取消未开始的场次');
        await tx.teamSession.update({
          where: { id: session.id },
          data: { state: 'CANCELLED', cancelledAt: now }
        });
        await this.notify(
          tx,
          row,
          eventKey,
          'TEAM_SCHEDULE_CANCELLED',
          this.sessionRecipients(row, session),
          now,
          true,
          session,
          undefined,
          _actorId
        );
        return { sessionId: session.id };
      }
    );
  }
  private futureConfirmed(row: Row, value: unknown, now: Date) {
    const session = row.sessions.find((s) => s.id === activityId(value, 'sessionId'));
    if (!session) throw new AccountError('NOT_FOUND', '场次不存在', 404);
    if (session.state !== 'CONFIRMED' || session.startsAt <= now) forbidden('仅可处理未开始的已确认场次');
    return session;
  }
  private async endMembership(tx: Tx, row: Row, membershipId: string, state: 'LEFT' | 'REMOVED', now: Date) {
    const member = row.memberships.find((m) => m.id === membershipId);
    if (!member) return conflict('成员已离队或已被移除');
    await tx.teamMembership.update({ where: { id: member.id }, data: { state, seatId: null, leftAt: now } });
    const ids = row.sessions
      .filter((s) => s.state === 'CONFIRMED' && s.startsAt > now)
      .flatMap((s) =>
        s.members
          .filter((m) => m.timeVersion === s.timeVersion && m.membershipId === member.id)
          .map((m) => m.id)
      );
    await tx.teamSessionMember.updateMany({
      where: { id: { in: ids } },
      data: { state: 'NEEDS_SUBSTITUTE' }
    });
    return {
      membershipId: member.id,
      accountId: member.accountId,
      position: member.position,
      affectedMembers: ids
    };
  }
  async leave(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'LEAVE_TEAM',
      ['confirmed'],
      async (tx, row, actorId, now, eventKey) => {
        if (body.confirmed !== true) invalid('confirmed', '请确认离开固定队');
        if (row.creatorId === actorId) forbidden('创建者停止带队请解散固定队');
        const member = row.memberships.find((m) => m.accountId === actorId);
        if (!member) return forbidden('仅本队成员可以离队');
        const affected = await this.endMembership(tx, row, member.id, 'LEFT', now);
        await this.notify(
          tx,
          row,
          eventKey,
          'TEAM_MEMBER_LEFT',
          [row.creatorId],
          now,
          false,
          undefined,
          { participantName: member.account.displayName, position: member.position },
          actorId
        );
        return affected;
      },
      'registered'
    );
  }
  async removeMember(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'REMOVE_MEMBER',
      ['membershipId', 'confirmed'],
      async (tx, row, _actorId, now, eventKey) => {
        if (body.confirmed !== true) invalid('confirmed', '请确认移除成员');
        const member = row.memberships.find((m) => m.id === activityId(body.membershipId, 'membershipId'));
        if (!member) return conflict('成员已变化，请刷新');
        if (member.accountId === row.creatorId) forbidden('创建者停止带队请解散固定队');
        const affected = await this.endMembership(tx, row, member.id, 'REMOVED', now);
        await this.notify(
          tx,
          row,
          eventKey,
          'TEAM_MEMBER_REMOVED',
          [member.accountId],
          now,
          false,
          undefined,
          { participantName: member.account.displayName, position: member.position },
          _actorId
        );
        return affected;
      }
    );
  }
  private async endRecruitmentApplications(tx: Tx, row: Row, actorId: string, now: Date, eventKey: string) {
    const pending = row.applications.filter((a) => a.state === 'PENDING');
    await tx.teamApplication.updateMany({
      where: { teamId: row.id, state: 'PENDING' },
      data: { state: 'CANCELLED', decidedAt: now }
    });
    await this.notify(
      tx,
      row,
      eventKey + ':recruitment-ended',
      'TEAM_RECRUITMENT_ENDED',
      pending.map((a) => a.accountId),
      now,
      false,
      undefined,
      undefined,
      actorId
    );
    return pending.map((a) => a.id);
  }
  async completeRecruitment(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'COMPLETE_RECRUITMENT',
      ['confirmed'],
      async (tx, row, actorId, now, eventKey) => {
        if (body.confirmed !== true) invalid('confirmed', '请确认完成招募');
        if (row.recruitmentCompletedAt) conflict('招募已经完成');
        const applicationIds = await this.endRecruitmentApplications(tx, row, actorId, now, eventKey);
        await tx.fixedTeam.update({ where: { id: row.id }, data: { recruitmentCompletedAt: now } });
        return { applicationIds, recruitmentCompletedAt: now.toISOString() };
      }
    );
  }
  async deleteRecruitment(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.dissolveCommand(id, body, token, true);
  }
  async dissolve(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.dissolveCommand(id, body, token, false);
  }
  private async dissolveCommand(
    id: string,
    body: Record<string, unknown>,
    token: string | null | undefined,
    recruitmentOnly: boolean
  ) {
    return this.run(
      id,
      body,
      token,
      recruitmentOnly ? 'DELETE_RECRUITMENT' : 'DISSOLVE_TEAM',
      ['confirmed'],
      async (tx, row, _actorId, now, eventKey) => {
        if (body.confirmed !== true) invalid('confirmed', '请确认解散固定队');
        if (recruitmentOnly && row.recruitmentCompletedAt) forbidden('招募已完成，请通过队伍管理解散');
        await this.endRecruitmentApplications(tx, row, _actorId, now, eventKey);
        const sessionIds = row.sessions
          .filter((s) => s.startsAt > now && s.state !== 'CANCELLED')
          .map((s) => s.id);
        await tx.teamSession.updateMany({
          where: { id: { in: sessionIds } },
          data: { state: 'CANCELLED', cancelledAt: now }
        });
        await tx.fixedTeam.update({ where: { id: row.id }, data: { state: 'DISSOLVED', dissolvedAt: now } });
        const recipients = [
          ...row.memberships.map((m) => m.accountId),
          ...row.sessions
            .filter((s) => sessionIds.includes(s.id))
            .flatMap((s) =>
              s.substitutes.flatMap((m) =>
                m.timeVersion === s.timeVersion && m.accountId ? [m.accountId] : []
              )
            )
        ];
        await this.notify(
          tx,
          row,
          eventKey,
          'TEAM_DISSOLVED',
          recipients,
          now,
          false,
          undefined,
          undefined,
          _actorId
        );
        return { sessionIds };
      }
    );
  }
  async recordLeave(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'SESSION_LEAVE',
      ['sessionId', 'memberId', 'reason'],
      async (tx, row, actorId, now, eventKey) => {
        const session = this.futureConfirmed(row, body.sessionId, now),
          member = session.members.find(
            (m) => m.timeVersion === session.timeVersion && m.id === activityId(body.memberId, 'memberId')
          );
        if (!member) invalid('memberId', '请选择本场成员');
        if (row.creatorId !== actorId && member.accountId !== actorId) forbidden('只能为本人请假');
        if (!row.memberships.some((m) => m.id === member.membershipId)) conflict('该成员已离队');
        if (member.leave) conflict('本场已记录请假');
        const reason = teamText(body.reason, 'reason', 1000);
        await tx.teamSessionLeave.create({
          data: { memberId: member.id, reason, recordedById: actorId, createdAt: now }
        });
        await tx.teamSessionMember.update({ where: { id: member.id }, data: { state: 'NEEDS_SUBSTITUTE' } });
        await this.notify(
          tx,
          row,
          eventKey,
          'TEAM_SESSION_LEAVE',
          [row.creatorId, ...(member.accountId === actorId ? [] : [member.accountId])],
          now,
          false,
          session,
          { participantName: member.account.displayName, position: member.position },
          actorId
        );
        return { memberId: member.id, sessionId: session.id, reason };
      },
      'registered'
    );
  }
  async substitute(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'SESSION_SUBSTITUTE',
      ['sessionId', 'position', 'kind', 'accountId', 'displayName', 'gameRegion', 'gameServer', 'job'],
      async (tx, row, actorId, now, eventKey) => {
        const session = this.futureConfirmed(row, body.sessionId, now),
          position = teamPosition(body.position),
          job = teamJob(body.job);
        const original = session.members.find(
          (m) => m.timeVersion === session.timeVersion && m.position === position
        );
        if (original && original.state !== 'NEEDS_SUBSTITUTE') conflict('本场该席位已有正常参加成员');
        if (session.substitutes.some((m) => m.timeVersion === session.timeVersion && m.position === position))
          conflict('本场席位已有临时补位');
        if (!jobMeetsSeat(requirement(row.seats[position]!), job)) invalid('job', '职业不符合席位要求');
        let participantName: string | null = null,
          accountId: string | null = null,
          external: { displayName: string; gameRegion: string; gameServer: string } | null = null;
        if (body.kind === 'REGISTERED') {
          accountId = activityId(body.accountId, 'accountId');
          await requireActiveTargets(tx, [accountId]);
          if (body.displayName !== null || body.gameRegion !== null || body.gameServer !== null)
            invalid('person', '站内成员不填写站外身份');
          const person = await tx.account.findUnique({
            where: { id: accountId },
            select: { id: true, displayName: true }
          });
          if (!person) invalid('accountId', '请选择站内成员');
          participantName = person.displayName;
          if (
            session.members.some(
              (m) =>
                m.timeVersion === session.timeVersion && m.accountId === accountId && m.state === 'MEMBER'
            ) ||
            session.substitutes.some(
              (m) => m.timeVersion === session.timeVersion && m.accountId === accountId
            )
          )
            conflict('该成员已在本场占位');
          if (original?.accountId === accountId) conflict('原成员不能补位本人的席位');
        } else if (body.kind === 'EXTERNAL') {
          if (body.accountId !== null) invalid('accountId', '站外临补不关联站内账号');
          external = {
            displayName: validateGameNickname(body.displayName),
            ...validateGameServer(body.gameRegion, body.gameServer)
          };
          participantName = external.displayName;
          if (
            session.substitutes.some(
              (m) =>
                m.timeVersion === session.timeVersion &&
                m.displayName === external!.displayName &&
                m.gameServer === external!.gameServer
            )
          )
            conflict('该站外成员已在本场占位');
        } else invalid('kind', '请选择站内或站外临补');
        const substitute = await tx.teamSessionSubstitute.create({
          data: {
            sessionId: session.id,
            timeVersion: session.timeVersion,
            position,
            kind: body.kind,
            accountId,
            ...external,
            job,
            recordedById: actorId,
            createdAt: now,
            confirmedStartsAt: session.startsAt,
            confirmedEndsAt: session.endsAt
          }
        });
        await this.notify(
          tx,
          row,
          eventKey,
          'TEAM_SESSION_SUBSTITUTE',
          [...(original ? [original.accountId] : []), ...(accountId ? [accountId] : [])],
          now,
          false,
          session,
          { participantName, position },
          actorId
        );
        return { sessionId: session.id, substituteId: substitute.id, position };
      }
    );
  }
  async recordParticipation(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.run(
      id,
      body,
      token,
      'PARTICIPATION_RECORD',
      ['sessionId', 'targetKind', 'targetId', 'status', 'reason'],
      async (tx, row, actorId, now) => {
        const session = row.sessions.find((s) => s.id === activityId(body.sessionId, 'sessionId'));
        if (!session) throw new AccountError('NOT_FOUND', '场次不存在', 404);
        if (session.state !== 'CONFIRMED' || session.endsAt > now)
          forbidden('仅可补记或更正已结束的已确认场次');
        const targetId = activityId(body.targetId, 'targetId');
        if (body.targetKind !== 'MEMBER' && body.targetKind !== 'SUBSTITUTE')
          invalid('targetKind', '请选择本场成员或临时补位');
        const target =
          body.targetKind === 'MEMBER'
            ? session.members.find((m) => m.id === targetId && m.timeVersion === session.timeVersion)
            : session.substitutes.find((m) => m.id === targetId && m.timeVersion === session.timeVersion);
        if (!target) invalid('targetId', '请选择本场当前版本的参与人员');
        if (body.status !== 'PRESENT' && body.status !== 'LEAVE' && body.status !== 'ABSENT')
          invalid('status', '请选择参加、请假或缺席');
        const reason = teamText(body.reason, 'reason', 1000);
        const record = await tx.teamParticipationChange.create({
          data: {
            teamId: row.id,
            memberId: body.targetKind === 'MEMBER' ? targetId : null,
            substituteId: body.targetKind === 'SUBSTITUTE' ? targetId : null,
            status: body.status,
            reason,
            actorId,
            recordedAt: now,
            revision: row.revision + 1
          }
        });
        return { recordId: record.id, sessionId: session.id, targetId, status: body.status };
      },
      'owner',
      true
    );
  }
  async history(token?: string | null): Promise<TeamHistory>;
  async history(token: string | null | undefined, requestedPage: string | null): Promise<TeamHistoryPage>;
  async history(
    token?: string | null,
    requestedPage?: string | null
  ): Promise<TeamHistory | TeamHistoryPage> {
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token);
      const page = requestedPage === undefined ? undefined : teamPage(requestedPage);
      const historyRecords = {
        orderBy: recordsInclude.orderBy,
        select: {
          id: true,
          status: true,
          reason: true,
          recordedAt: true,
          actor: { select: personSelect }
        }
      } as const;
      const rows = await tx.fixedTeam.findMany({
        where: {
          OR: [
            { creatorId: actor.accountId },
            { memberships: { some: { accountId: actor.accountId } } },
            { sessions: { some: { substitutes: { some: { accountId: actor.accountId } } } } }
          ]
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(page === undefined ? {} : { skip: (page - 1) * TEAM_PAGE_SIZE, take: TEAM_PAGE_SIZE + 1 }),
        select: {
          id: true,
          name: true,
          state: true,
          sessions: {
            orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
            select: {
              state: true,
              timeVersion: true,
              members: {
                where: { accountId: actor.accountId },
                select: {
                  id: true,
                  timeVersion: true,
                  position: true,
                  job: true,
                  state: true,
                  confirmedStartsAt: true,
                  confirmedEndsAt: true,
                  leave: { select: { reason: true } },
                  participationChanges: historyRecords
                }
              },
              substitutes: {
                where: { accountId: actor.accountId },
                select: {
                  id: true,
                  timeVersion: true,
                  position: true,
                  job: true,
                  confirmedStartsAt: true,
                  confirmedEndsAt: true,
                  participationChanges: historyRecords
                }
              }
            }
          }
        }
      });
      return {
        items: (page === undefined ? rows : rows.slice(0, TEAM_PAGE_SIZE)).map((row) => ({
          teamId: row.id,
          teamName: row.name,
          teamState: row.state,
          sessions: row.sessions.flatMap((s) => [
            ...s.members
              .filter((m) => m.confirmedStartsAt && m.confirmedEndsAt)
              .map((m) => ({
                id: m.id,
                startsAt: m.confirmedStartsAt!.toISOString(),
                endsAt: m.confirmedEndsAt!.toISOString(),
                state: m.timeVersion === s.timeVersion ? s.state : 'TIME_CHANGED',
                position: m.position,
                job: m.job,
                participation: (m.leave ? 'LEAVE' : m.state) as 'LEAVE' | 'MEMBER' | 'NEEDS_SUBSTITUTE',
                reason: m.leave?.reason ?? null,
                records: participationRecords(m.participationChanges)
              })),
            ...s.substitutes.map((m) => ({
              id: m.id,
              startsAt: m.confirmedStartsAt.toISOString(),
              endsAt: m.confirmedEndsAt.toISOString(),
              state: m.timeVersion === s.timeVersion ? s.state : 'TIME_CHANGED',
              position: m.position,
              job: m.job,
              participation: 'SUBSTITUTE' as const,
              reason: null,
              records: participationRecords(m.participationChanges)
            }))
          ])
        })),
        ...(page === undefined
          ? {}
          : { page, pageSize: TEAM_PAGE_SIZE, hasMore: rows.length > TEAM_PAGE_SIZE })
      };
    });
  }
  async get(id: string, token?: string | null): Promise<TeamDetail> {
    const key = activityId(id);
    return this.auth.transaction(async (tx) => {
      // Authorize the root and every conditional collection in one read-only snapshot.
      await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      const actor = await this.auth.requireAccount(tx, token);
      return detail(await this.loadForReader(tx, key, actor.accountId), actor.accountId, this.auth.now());
    });
  }
  async list(mine: boolean, token?: string | null, requestedPage = 1): Promise<TeamList> {
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token);
      const where: Prisma.FixedTeamWhereInput = {
        state: 'ACTIVE',
        recruitmentCompletedAt: mine ? { not: null } : null,
        ...(mine
          ? {
              OR: [
                { creatorId: actor.accountId },
                { memberships: { some: { accountId: actor.accountId, state: 'ACTIVE' } } }
              ]
            }
          : {})
      };
      const total = await tx.fixedTeam.count({ where }),
        totalPages = mine ? 1 : Math.max(1, Math.ceil(total / TEAM_PAGE_SIZE));
      const page = mine ? 1 : Math.min(Math.max(1, requestedPage), totalPages);
      const rows = await tx.fixedTeam.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: teamSummarySelect,
        ...(!mine ? { skip: (page - 1) * TEAM_PAGE_SIZE, take: TEAM_PAGE_SIZE } : {})
      });
      return {
        items: rows.map((row) => summary(row, actor.accountId)),
        total,
        totalPages,
        page,
        pageSize: mine ? total : TEAM_PAGE_SIZE
      };
    });
  }
}
