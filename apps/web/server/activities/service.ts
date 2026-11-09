import { notifyQqActivity } from '../qq-official/notifications';
import { emitMessage } from '../messages/emit';
import { settleActivityStanding, reconcileSeriesRecruitment, type Prisma } from '@artzoo/db';
import {
  generateSeriesPeriods,
  BEIJING_OFFSET_MS,
  beijingMonthKey,
  fromBeijingParts,
  toBeijingParts,
  AccountError,
  activityId,
  activityStatus,
  invalid,
  isMemberId,
  jobMeetsSeat,
  parseBeijingActivityTime,
  validateActivityRegistration,
  validateActivityRegistrationMove,
  validateCreateActivity,
  dutyPresetSeats,
  isCatalogDutyType,
  type ActivityDetail,
  type ActivityHistory,
  type ActivityList,
  type ActivityPerson,
  type ActivityRegistration,
  type ActivitySummary,
  type ActivityWriteResult,
  type MyActivities,
  type MyActivitiesPagination,
  type ActivityPeriod,
  type SeatRequirement,
  type CreateActivityInput,
  type RegisterActivityInput,
  type DutySnapshot,
  type DutyCatalogList,
  type DutyGroupKey
} from '@artzoo/domain';
import { missingActivityDescriptionFields } from '../../lib/activity-description';
import { tokenDigest } from '../auth/crypto';
import { AccountService, lock } from '../auth/service';
import { staticDutyCatalog, type DutyCatalogReader } from './duty-catalog';

type Tx = Prisma.TransactionClient;
const personSelect = { id: true, displayName: true, profile: { select: { avatarId: true } } } as const;
const registrationSelect = {
  id: true,
  seatId: true,
  accountId: true,
  job: true,
  rescheduleExitAllowed: true,
  createdAt: true,
  account: { select: personSelect }
} as const;
export const activitySelect = {
  scene: true,
  mode: true,
  location: true,
  meetingInstructions: true,
  capacityUnlimited: true,
  registrationClosesAt: true,
  seriesId: true,
  periodNumber: true,
  series: {
    select: {
      id: true,
      state: true,
      formedAt: true,
      totalPeriods: true,
      activities: {
        orderBy: [{ periodNumber: 'asc' as const }, { id: 'asc' as const }],
        select: {
          id: true,
          revision: true,
          periodNumber: true,
          startsAt: true,
          endsAt: true,
          cancelledAt: true
        }
      }
    }
  },
  revision: true,
  cancelledAt: true,
  cancellationReason: true,
  continuedAt: true,
  registrations: {
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    select: { id: true, accountId: true, status: true, job: true, exitedAt: true }
  },
  id: true,
  title: true,
  description: true,
  category: true,
  startsAt: true,
  endsAt: true,
  createdAt: true,
  dutyId: true,
  dutySnapshot: true,
  organizerId: true,
  organizer: { select: personSelect },
  seats: {
    orderBy: { position: 'asc' as const },
    select: {
      id: true,
      position: true,
      kind: true,
      role: true,
      job: true,
      groupKey: true,
      registration: { select: registrationSelect }
    }
  }
} as const satisfies Prisma.ActivitySelect;
const activityListSelect = (accountId: string) =>
  ({
    ...activitySelect,
    registrations: { ...activitySelect.registrations, where: { accountId } }
  }) satisfies Prisma.ActivitySelect;

export type ActivityRegistrationRow = Prisma.ActivityGetPayload<{ select: typeof activitySelect }>;
type ActivityRow = ActivityRegistrationRow;
type RegistrationActor = Pick<Awaited<ReturnType<AccountService['requireAccount']>>, 'accountId' | 'account'>;
type PersonRow = Prisma.AccountGetPayload<{ select: typeof personSelect }>;
function person(row: PersonRow): ActivityPerson {
  return {
    id: row.id,
    displayName: row.displayName,
    avatarUrl: row.profile?.avatarId ? `/api/avatars/${row.profile.avatarId}?size=small` : null
  };
}
function requirement(seat: ActivityRow['seats'][number]): SeatRequirement {
  if (seat.kind === 'ROLE' && seat.role) return { kind: 'ROLE', role: seat.role };
  if (seat.kind === 'JOB' && seat.job) return { kind: 'JOB', job: seat.job };
  return { kind: 'ANY' };
}
function registration(row: NonNullable<ActivityRow['seats'][number]['registration']>): ActivityRegistration {
  return {
    id: row.id,
    seatId: row.seatId!,
    job: row.job,
    rescheduleExitAllowed: Boolean(row.rescheduleExitAllowed),
    registeredAt: row.createdAt.toISOString(),
    participant: person(row.account)
  };
}
export function activitySummary(row: ActivityRow, accountId: string, now: Date): ActivitySummary {
  const registrations = row.seats.flatMap((seat) => (seat.registration ? [seat.registration] : []));
  const own = registrations.find((item) => item.accountId === accountId);
  return {
    scene: row.scene ?? 'GAME',
    mode: row.mode ?? 'SINGLE',
    location: row.location ?? null,
    meetingInstructions: row.meetingInstructions ?? null,
    capacityUnlimited: row.capacityUnlimited ?? false,
    series: row.series
      ? {
          id: row.series.id,
          state: row.series.state as 'RECRUITING' | 'FORMED' | 'CANCELLED',
          formedAt: row.series.formedAt?.toISOString() ?? null,
          periodNumber: row.periodNumber!,
          totalPeriods: row.series.totalPeriods,
          periods: row.series.activities.map((item) => ({
            id: item.id,
            revision: item.revision ?? 0,
            number: item.periodNumber!,
            startsAt: item.startsAt.toISOString(),
            endsAt: item.endsAt.toISOString(),
            cancelledAt: item.cancelledAt?.toISOString() ?? null
          }))
        }
      : null,
    revision: row.revision ?? 0,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancellationReason: row.cancellationReason ?? null,
    continuedAt: row.continuedAt?.toISOString() ?? null,
    myParticipation: (() => {
      const ownHistory = row.registrations?.filter((item) => item.accountId === accountId);
      const latest = ownHistory?.find((item) => item.status === 'ACTIVE') ?? ownHistory?.[0];
      return latest
        ? {
            id: latest.id,
            status: latest.status as 'ACTIVE' | 'WITHDRAWN' | 'CANCELLED',
            job: latest.job,
            exitedAt: latest.exitedAt?.toISOString() ?? null
          }
        : null;
    })(),
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    duty: row.dutySnapshot ? (row.dutySnapshot as unknown as DutySnapshot) : null,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    registrationClosesAt: (
      row.registrationClosesAt ?? new Date(row.startsAt.getTime() - 30 * 60000)
    ).toISOString(),
    createdAt: row.createdAt.toISOString(),
    organizer: person(row.organizer),
    capacity: row.seats.length,
    registeredCount: registrations.length,
    participants: registrations.map((item) => person(item.account)),
    status: row.cancelledAt
      ? 'CANCELLED'
      : activityStatus(
          row.startsAt,
          row.endsAt,
          now,
          !row.capacityUnlimited && registrations.length === row.seats.length,
          row.registrationClosesAt ?? undefined
        ),
    isOrganizer: row.organizerId === accountId,
    myRegistration: own ? registration(own) : null
  };
}
export function activityDetail(row: ActivityRow, accountId: string, now: Date): ActivityDetail {
  return {
    ...activitySummary(row, accountId, now),
    serverNow: now.toISOString(),
    timeZone: 'Asia/Shanghai',
    seats: row.seats.map((seat) => ({
      id: seat.id,
      position: seat.position,
      groupKey: seat.groupKey as DutyGroupKey | null,
      requirement: requirement(seat),
      registration: seat.registration ? registration(seat.registration) : null
    }))
  };
}
function missing(): AccountError {
  return new AccountError('NOT_FOUND', '活动不存在', 404);
}
function conflict(message: string): never {
  throw new AccountError('CONFLICT', message, 409);
}

export class ActivityService {
  constructor(
    readonly auth: AccountService,
    readonly catalog: DutyCatalogReader = staticDutyCatalog
  ) {}
  protected async resolveDuty(input: CreateActivityInput): Promise<DutySnapshot | null> {
    const selection = input.dutySelection;
    if (!selection) return null;
    if (selection.type === 'OTHER') {
      const preset = dutyPresetSeats(selection.partyComposition);
      return {
        id: null,
        name: selection.name,
        type: 'OTHER',
        capacity: input.seats.length,
        partyComposition: selection.partyComposition,
        catalogVersion: null,
        entryRevision: null,
        finalSeats: input.seats.map((requirement, position) => ({
          requirement,
          groupKey: preset[position]?.groupKey ?? null
        }))
      };
    }
    const found = await this.catalog.findById(selection.dutyId);
    if (!found || !found.entry.enabled) invalid('dutySelection', '副本不可用，请重新选择');
    const { entry, catalogVersion } = found;
    if (entry.type !== selection.type) invalid('dutySelection', '副本与所选类型不一致');
    if (input.seats.length !== entry.capacity) invalid('seats', '席位人数必须符合副本编制');
    // The catalog controls capacity/group structure; every requirement remains user editable.
    const expected = dutyPresetSeats(entry.partyComposition);
    if (
      entry.defaultSeats.length !== entry.capacity ||
      expected.length !== entry.capacity ||
      entry.defaultSeats.some((seat, index) => seat.groupKey !== expected[index]?.groupKey) ||
      !Number.isInteger(entry.entryRevision) ||
      entry.entryRevision < 1
    ) {
      throw new AccountError('CONFLICT', '副本目录编制无效，请联系维护者', 409);
    }
    return {
      id: entry.id,
      name: entry.name,
      type: entry.type,
      capacity: entry.capacity,
      partyComposition: entry.partyComposition,
      catalogVersion,
      entryRevision: entry.entryRevision,
      finalSeats: input.seats.map((requirement, position) => ({
        requirement,
        groupKey: entry.defaultSeats[position]?.groupKey ?? null
      }))
    };
  }
  async duties(url: URL, token?: string | null): Promise<DutyCatalogList> {
    return this.auth.transaction(async (tx) => {
      await this.auth.requireAccount(tx, token);
      const type = url.searchParams.get('type'),
        search = url.searchParams.get('search')?.trim() ?? '';
      if (type !== null && !isCatalogDutyType(type)) invalid('type', '副本类型无效');
      if (search.length > 100) invalid('search', '搜索内容过长');
      return this.catalog.list({ ...(type ? { type } : {}), search });
    });
  }
  protected async actorLocked(
    tx: Tx,
    token: string | null | undefined,
    actor: Awaited<ReturnType<AccountService['requireAccount']>>
  ) {
    // Credential writers lock phone first. NO KEY UPDATE still serializes account mutations,
    // while allowing notification foreign-key KEY SHARE locks and avoiding activity/account cycles.
    await lock(tx, `phone:${actor.account.phone}`);
    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${actor.accountId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id" = ${actor.id} FOR UPDATE`;
    const fresh = await this.auth.requireAccount(tx, token);
    if (fresh.accountId !== actor.accountId) throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
    return fresh;
  }
  protected async lockActivityScope(tx: Tx, id: string) {
    const hint = await tx.activity.findUnique({ where: { id }, select: { seriesId: true } });
    if (hint?.seriesId) {
      await lock(tx, `series:${hint.seriesId}`);
      const periods = await tx.activity.findMany({
        where: { seriesId: hint.seriesId },
        orderBy: [{ periodNumber: 'asc' }, { id: 'asc' }],
        select: { id: true }
      });
      for (const period of periods) await lock(tx, `activity:${period.id}`);
      await reconcileSeriesRecruitment(tx, hint.seriesId, () => this.auth.now());
    } else await lock(tx, `activity:${id}`);
  }
  protected async read(tx: Tx, id: string, accountId: string): Promise<ActivityDetail> {
    const row = await tx.activity.findUnique({ where: { id }, select: activitySelect });
    if (!row) throw missing();
    return activityDetail(row, accountId, this.auth.now());
  }
  protected async event(
    tx: Tx,
    data: {
      eventKey: string;
      activityId: string;
      registrationId?: string;
      kind:
        | 'REGISTRATION_CONFIRMED'
        | 'SERIES_READY'
        | 'SERIES_FORMED'
        | 'ACTIVITY_PUBLISHED'
        | 'REGISTRATION_CREATED'
        | 'REGISTRATION_WITHDRAWN'
        | 'ACTIVITY_RESCHEDULED'
        | 'ACTIVITY_CANCELLED'
        | 'ACTIVITY_PENALTY'
        | 'ACTIVITY_SCORE_CORRECTED'
        | 'ATTENDANCE_APPEAL_RESULT'
        | 'PENALTY_APPEAL_RESULT';
      payload?: Prisma.InputJsonValue;
      channel: 'QQ' | 'IN_APP';
      recipientId?: string;
    },
    now: Date
  ) {
    // This first slice has no external transport. The durable outbox and simulated receipt commit
    // atomically with the business operation; unique keys also guard reprocessing/retries.
    await tx.activityOutbox.create({
      data: { ...data, createdAt: now, mockDelivery: { create: { deliveredAt: now } } }
    });
  }
  async create(body: Record<string, unknown>, token?: string | null): Promise<ActivityWriteResult> {
    const input = validateCreateActivity(body);
    const actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`activity-create:${actor.accountId}`, 30, 3600);
    const result = await this.auth.transaction(async (tx) => {
      const fresh = await this.actorLocked(tx, token, actor);
      if (fresh.account.membership !== 'MEMBER')
        throw new AccountError('FORBIDDEN', '仅正式成员可以发布活动', 403);
      const fingerprint = tokenDigest(JSON.stringify(input));
      const existing = await tx.activity.findUnique({
        where: {
          organizerId_idempotencyKey: { organizerId: fresh.accountId, idempotencyKey: input.idempotencyKey }
        },
        select: { id: true, requestFingerprint: true }
      });
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) conflict('发布内容已变化，请使用新的提交标识');
        return { activity: await this.read(tx, existing.id, fresh.accountId), replayed: true };
      }
      const missingDescription = missingActivityDescriptionFields(input.description);
      if (missingDescription.arrangement) invalid('description', '请填写活动安排');
      if (missingDescription.requirements) invalid('requirements', '请填写参与要求');
      const standing =
        input.scene === 'OFFLINE'
          ? { points: 0 }
          : await settleActivityStanding(tx, fresh.accountId, this.auth.now(), {
              points: fresh.account.activityPoints ?? 0,
              decayAt: fresh.account.activityDecayAt ?? null
            });
      if (standing.points >= 3)
        return new AccountError('FORBIDDEN', '履约点数达到3点，暂不能新报名或发起活动', 403);
      if (input.album?.categoryId) {
        await lock(tx, `album-category:${input.album.categoryId}`);
        await this.auth.requireAccount(tx, token);
        if (
          !(await tx.albumCategory.findFirst({
            where: {
              id: input.album.categoryId,
              active: true,
              primary: input.scene === 'OFFLINE' ? 'OFFLINE' : 'GAME'
            },
            select: { id: true }
          }))
        )
          invalid('albumCategoryId', '二级分类不存在或已停用');
      }
      const duty = await this.resolveDuty(input);
      const now = this.auth.now();
      const startsAt = parseBeijingActivityTime(input.startsAt, 'startsAt');
      if (startsAt <= now) invalid('startsAt', '预定开始须晚于当前时间');
      const offline = input.offline;
      const cutoff = offline
        ? parseBeijingActivityTime(offline.registrationClosesAt, 'registrationClosesAt')
        : null;
      if (cutoff && cutoff <= now) invalid('registrationClosesAt', '报名截止须晚于发布时间');
      const periods = input.series
        ? generateSeriesPeriods(startsAt, input.series)
        : [{ startsAt, endsAt: parseBeijingActivityTime(input.endsAt, 'endsAt') }];
      const series = input.series
        ? await tx.activitySeries.create({
            data: {
              weekdays: input.series.weekdays,
              durationMinutes: input.series.durationMinutes,
              totalPeriods: periods.length,
              endDate: input.series.end.kind === 'DATE' ? input.series.end.date : null,
              createdAt: now
            },
            select: { id: true }
          })
        : null;
      let firstId = '';
      for (const [index, period] of periods.entries()) {
        const row = await tx.activity.create({
          data: {
            organizerId: fresh.accountId,
            idempotencyKey: index ? `${input.idempotencyKey}:period:${index + 1}` : input.idempotencyKey,
            requestFingerprint: fingerprint,
            title: input.title,
            description: input.description,
            category: input.category,
            scene: input.scene ?? 'GAME',
            mode: input.mode ?? 'SINGLE',
            ...(offline
              ? {
                  location: offline.location,
                  meetingInstructions: offline.meetingInstructions,
                  registrationClosesAt: cutoff,
                  capacityUnlimited: offline.capacity === null
                }
              : {}),
            ...(series
              ? {
                  seriesId: series.id,
                  periodNumber: index + 1,
                  registrationClosesAt: new Date(period.startsAt.getTime() - 30 * 60000)
                }
              : {}),
            ...(offline || series ? { completionEnabledAt: null } : {}),
            ...(duty ? { dutyId: duty.id, dutySnapshot: duty as unknown as Prisma.InputJsonValue } : {}),
            ...period,
            createdAt: now,
            seats: {
              create: input.seats.map((seat, position) => ({
                position,
                groupKey: duty?.finalSeats[position]?.groupKey ?? null,
                kind: seat.kind,
                role: seat.kind === 'ROLE' ? seat.role : null,
                job: seat.kind === 'JOB' ? seat.job : null
              }))
            }
          },
          select: { id: true }
        });
        if (!index) firstId = row.id;
      }
      if (input.createAlbum) {
        const album = await tx.album.create({
          data: {
            creatorId: fresh.accountId,
            name: input.album!.name,
            categoryId: input.album!.categoryId,
            primary: offline ? 'OFFLINE' : 'GAME',
            uploadMode: 'ACTIVITY',
            activityId: firstId,
            seriesId: series?.id ?? null,
            createdAt: now
          }
        });
        await tx.albumAudit.create({
          data: {
            albumId: album.id,
            actorId: fresh.accountId,
            action: 'ALBUM_CREATED_INITIAL_COVER',
            reason: '新相册首次成功上传时初始化封面'
          }
        });
      }
      if (!offline && !series)
        await this.event(
          tx,
          {
            eventKey: `activity-published:${firstId}`,
            activityId: firstId,
            kind: 'ACTIVITY_PUBLISHED',
            channel: 'QQ'
          },
          now
        );
      await notifyQqActivity(tx, firstId, 'PUBLISHED', now);
      return { activity: await this.read(tx, firstId, fresh.accountId), replayed: false };
    });
    if (result instanceof AccountError) throw result;
    return result;
  }
  async register(
    id: string,
    body: Record<string, unknown>,
    token?: string | null,
    receivedAt = this.auth.now()
  ): Promise<ActivityWriteResult> {
    const key = activityId(id),
      input = validateActivityRegistration(body);
    const actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`activity-register:${actor.accountId}`, 120, 900);
    return this.registerResolved(
      async (tx) => ({
        id: key,
        actor: await this.actorLocked(tx, token, actor),
        revalidate: async () => {
          await this.auth.requireAccount(tx, token);
        }
      }),
      () => input,
      receivedAt
    );
  }
  // Internal server adapters resolve their own authenticated actor and target in this transaction.
  // HTTP callers never supply an account ID or an actor resolver.
  protected async registerResolved(
    resolve: (tx: Tx) => Promise<{
      id: string;
      actor: RegistrationActor;
      revalidate: () => Promise<void>;
    }>,
    resolveInput: (row: ActivityRegistrationRow) => RegisterActivityInput,
    receivedAt?: Date
  ): Promise<ActivityWriteResult> {
    const result = await this.auth.transaction(async (tx) => {
      const { id, actor: fresh, revalidate } = await resolve(tx),
        key = activityId(id);
      await this.lockActivityScope(tx, key);
      // Session expiry or the trusted adapter's binding/account can change while waiting.
      await revalidate();
      const row = await tx.activity.findUnique({ where: { id: key }, select: activitySelect });
      if (!row) throw missing();
      if (row.cancelledAt) return new AccountError('FORBIDDEN', '活动已取消', 403);
      if (row.mode === 'SERIES' && row.periodNumber !== 1)
        return new AccountError('FORBIDDEN', '本期不接受单独报名，请查看首期', 403);
      const input = validateActivityRegistration({ ...resolveInput(row) });
      const own = row.seats.find((seat) => seat.registration?.accountId === fresh.accountId)?.registration;
      if (own) {
        if ((row.scene !== 'OFFLINE' && own.seatId !== input.seatId) || own.job !== input.job)
          conflict('你已报名该活动，不能重复占用席位');
        return { activity: activityDetail(row, fresh.accountId, this.auth.now()), replayed: true };
      }
      if (row.mode === 'SERIES' && row.series?.state !== 'RECRUITING')
        return new AccountError('FORBIDDEN', '系列已锁定，不再接受报名', 403);
      const standing =
        row.scene === 'OFFLINE'
          ? { points: 0 }
          : await settleActivityStanding(tx, fresh.accountId, this.auth.now(), {
              points: fresh.account.activityPoints ?? 0,
              decayAt: fresh.account.activityDecayAt ?? null
            });
      if (standing.points >= 3)
        return new AccountError('FORBIDDEN', '履约点数达到3点，暂不能新报名或发起活动', 403);
      if (
        (row.scene === 'OFFLINE' || row.mode === 'SERIES'
          ? this.auth.now()
          : (receivedAt ?? this.auth.now())) >=
        (row.registrationClosesAt ?? new Date(row.startsAt.getTime() - 30 * 60000))
      ) {
        throw new AccountError('FORBIDDEN', '报名已截止', 403);
      }
      if (row.scene === 'OFFLINE' && (input.seatId !== null || input.job !== null))
        invalid('registration', '线下报名无需选择职业席位');
      let seat =
        row.scene === 'OFFLINE'
          ? row.seats.find((item) => !item.registration)
          : row.seats.find((item) => item.id === input.seatId);
      if (row.scene === 'OFFLINE' && row.capacityUnlimited && !seat) {
        const appended = await tx.activitySeat.create({
          data: { activityId: row.id, position: row.seats.length, kind: 'ANY' }
        });
        seat = { ...appended, registration: null };
      }
      if (row.scene === 'OFFLINE' && !seat) conflict('报名人数已达上限');
      if (!seat) invalid('seatId', '请选择本活动的席位');
      if (seat.registration) conflict('此席位已被占用，请刷新后选择其他席位');
      if (row.category === 'SOCIAL') {
        if (input.job !== null) invalid('job', '非副本聚会无需选择职业');
      } else if (!input.job || !jobMeetsSeat(requirement(seat), input.job))
        invalid('job', '职业不符合该席位要求');
      const now = this.auth.now();
      const created = await tx.activityRegistration.create({
        data: {
          activityId: row.id,
          seatId: seat.id,
          accountId: fresh.accountId,
          job: input.job,
          createdAt: now
        },
        select: { id: true }
      });
      await this.event(
        tx,
        {
          eventKey: `registration-created:${created.id}`,
          activityId: row.id,
          registrationId: created.id,
          kind:
            row.scene === 'OFFLINE' || row.mode === 'SERIES'
              ? 'REGISTRATION_CONFIRMED'
              : 'REGISTRATION_CREATED',
          channel: 'IN_APP',
          recipientId: row.scene === 'OFFLINE' || row.mode === 'SERIES' ? fresh.accountId : row.organizerId
        },
        now
      );
      // These modes already acknowledge the participant; add only the missing organizer message.
      if (row.scene === 'OFFLINE' || row.mode === 'SERIES')
        await emitMessage(tx, {
          recipientId: row.organizerId,
          actorId: fresh.accountId,
          kind: 'REGISTRATION_CREATED',
          sourceType: 'activity',
          sourceId: row.id,
          eventKey: `registration-created-organizer:${created.id}`,
          createdAt: now
        });
      await tx.activity.update({ where: { id: row.id }, data: { revision: { increment: 1 } } });
      return { activity: await this.read(tx, row.id, fresh.accountId), replayed: false };
    });
    if (result instanceof AccountError) throw result;
    return result;
  }
  async moveRegistration(
    id: string,
    body: Record<string, unknown>,
    token?: string | null,
    receivedAt = this.auth.now()
  ): Promise<ActivityWriteResult> {
    const key = activityId(id),
      input = validateActivityRegistrationMove(body);
    const actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`activity-register:${actor.accountId}`, 120, 900);
    return this.auth.transaction(async (tx) => {
      const fresh = await this.actorLocked(tx, token, actor);
      await lock(tx, `activity:${key}`);
      await this.auth.requireAccount(tx, token);
      const row = await tx.activity.findUnique({ where: { id: key }, select: activitySelect });
      if (!row) throw missing();
      if (row.scene === 'OFFLINE' || row.mode === 'SERIES')
        throw new AccountError('FORBIDDEN', '该活动不支持单次换位', 403);
      if (row.cancelledAt) throw new AccountError('FORBIDDEN', '活动已取消', 403);
      const own = row.seats.find((seat) => seat.registration?.accountId === fresh.accountId)?.registration;
      if (!own) conflict('你尚未报名该活动，请刷新后重试');
      // An identical retry is harmless even after the cutoff; no new move is performed.
      if (own.seatId === input.seatId && own.job === input.job) {
        return { activity: activityDetail(row, fresh.accountId, this.auth.now()), replayed: true };
      }
      if (own.seatId !== input.expectedSeatId) conflict('你的席位已变化，请刷新后重新选择');
      if (receivedAt.getTime() >= row.startsAt.getTime() - 30 * 60000) {
        throw new AccountError('FORBIDDEN', '报名已截止，不能更换席位', 403);
      }
      const seat = row.seats.find((item) => item.id === input.seatId);
      if (!seat) invalid('seatId', '请选择本活动的席位');
      if (seat.id === own.seatId) invalid('seatId', '请选择其他空席位');
      if (seat.registration) conflict('此席位已被占用，请刷新后选择其他席位');
      if (row.category === 'SOCIAL') {
        if (input.job !== null) invalid('job', '非副本聚会无需选择职业');
      } else if (!input.job || !jobMeetsSeat(requirement(seat), input.job))
        invalid('job', '职业不符合该席位要求');
      // Keep the registration identity/time and its durable events. Updating the unique seat
      // relation releases the old seat and claims the target atomically, never touching others.
      const moved = await tx.activityRegistration.updateMany({
        where: {
          id: own.id,
          activityId: row.id,
          accountId: fresh.accountId,
          seatId: input.expectedSeatId
        },
        data: { seatId: seat.id, job: input.job }
      });
      if (moved.count !== 1) conflict('你的席位已变化，请刷新后重新选择');
      await tx.activity.update({ where: { id: row.id }, data: { revision: { increment: 1 } } });
      return { activity: await this.read(tx, row.id, fresh.accountId), replayed: false };
    });
  }
  async history(id: string, url: URL, token?: string | null): Promise<ActivityHistory> {
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.auth.requireAccount(tx, token);
        if (!isMemberId(id)) throw missing();
        const row = await tx.activity.findUnique({
          where: { id: id.toLowerCase() },
          select: { organizerId: true }
        });
        if (!row) throw missing();
        const pageValue = url.searchParams.get('page') ?? '1';
        if (!/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(Number(pageValue)))
          invalid('page', '页码无效');
        const scope = row.organizerId === actor.accountId ? 'activity' : 'own';
        // Admin identity never grants another member's history. Apply the same filter before count and pagination.
        const where = {
          activityId: id.toLowerCase(),
          ...(scope === 'own' ? { actorId: actor.accountId } : {})
        };
        const pageSize = 20,
          total = await tx.activityCommand.count({ where });
        const totalPages = Math.ceil(total / pageSize),
          page = Math.min(Number(pageValue), Math.max(1, totalPages));
        const rows = await tx.activityCommand.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, kind: true, createdAt: true, actor: { select: { displayName: true } } }
        });
        const labels: Record<string, string> = {
          ACCOUNT_DISABLED_CANCEL: '账号停用，取消活动',
          ACCOUNT_DISABLED_WITHDRAW: '账号停用，取消报名',
          SERIES_DESCRIPTION_EDIT: '修改未来期次说明',
          OFFLINE_EDIT: '修改线下活动',
          ORDINARY_WITHDRAW: '退出报名',
          ORDINARY_MOVE: '更换首期席位',
          OFFLINE_CANCEL: '取消线下活动',
          SERIES_RESCHEDULE_PERIOD: '确认已征得全员同意，调整本期时间，其他期次不变',
          SERIES_CANCEL_PERIOD: '确认已征得全员同意，无责取消本期，后续期次按原计划举行',
          SERIES_FORM: '确认长期活动成团',
          SERIES_READY: '长期活动满员待确认',
          SERIES_AUTO_CANCEL: '系统取消未成团的长期活动',
          WITHDRAW: '退出报名',
          CANCEL: '取消活动',
          EDIT: '修改活动',
          CONTINUE: '确认继续举行',
          ATTENDANCE: '登记或更正到场结果',
          ATTENDANCE_APPEAL: '提交到场申诉',
          ATTENDANCE_DECISION: '处理到场申诉',
          AUTO_COMPLETION: '系统结算正常完成',
          AUTO_CANCEL: '缺人且未决定，系统取消活动'
        };
        return {
          scope,
          page,
          pageSize,
          total,
          totalPages,
          items: rows.map((item) => ({
            id: item.id,
            action: labels[item.kind] ?? '活动操作',
            actorName: item.actor ? item.actor.displayName || '成员' : '系统',
            createdAt: item.createdAt.toISOString()
          }))
        };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
  }
  async detail(id: string, token?: string | null): Promise<ActivityDetail> {
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token);
      if (!isMemberId(id)) throw missing();
      return this.read(tx, id.toLowerCase(), actor.accountId);
    });
  }
  async list(url: URL, token?: string | null): Promise<ActivityList> {
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token),
        now = this.auth.now();
      const upcoming = url.searchParams.get('upcoming');
      if (upcoming !== null && upcoming !== '1') invalid('upcoming', '查询参数无效');
      const month =
        url.searchParams.get('month') ??
        (() => {
          const instant = now.getTime();
          const shifted = new Date(instant + BEIJING_OFFSET_MS);
          const year = shifted.getUTCFullYear();
          // Keep the original ISO fallback for clocks outside the shared civil-time range.
          return Number.isSafeInteger(instant) && year >= 0 && year <= 9999
            ? beijingMonthKey(instant)
            : shifted.toISOString().slice(0, 7);
        })();
      if (
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
        Number(month.slice(0, 4)) < 1000 ||
        Number(month.slice(0, 4)) > 9999
      )
        invalid('month', '月份无效');
      const calendar = url.searchParams.get('calendar');
      if (calendar !== null && calendar !== '1') invalid('calendar', '查询参数无效');
      let start = fromBeijingParts({
        year: Number(month.slice(0, 4)),
        month: Number(month.slice(5, 7)),
        day: 1,
        hour: 0,
        minute: 0
      });
      const parts = toBeijingParts(start);
      let end: Date;
      if (parts.year === 9999 && parts.month === 12) {
        // The original upper boundary reaches year 10000, outside the shared core.
        const next = new Date(start.getTime() + BEIJING_OFFSET_MS);
        next.setUTCMonth(next.getUTCMonth() + 1);
        end = new Date(next.getTime() - BEIJING_OFFSET_MS);
      } else {
        end = fromBeijingParts({
          year: parts.year + (parts.month === 12 ? 1 : 0),
          month: parts.month === 12 ? 1 : parts.month + 1,
          day: 1,
          hour: 0,
          minute: 0
        });
      }
      if (calendar === '1' && !upcoming) {
        const weekday = toBeijingParts(start).weekday;
        start = new Date(start.getTime() - weekday * 86_400_000);
        end = new Date(start.getTime() + 42 * 86_400_000);
      }
      const rows = await tx.activity.findMany({
        where: upcoming
          ? {
              cancelledAt: null,
              startsAt: { gt: now },
              AND: [
                {
                  OR: [
                    { scene: 'OFFLINE', registrationClosesAt: { gt: now } },
                    {
                      scene: 'GAME',
                      AND: [
                        {
                          OR: [
                            { registrationClosesAt: { gt: now } },
                            {
                              registrationClosesAt: null,
                              startsAt: { gt: new Date(now.getTime() + 30 * 60000) }
                            }
                          ]
                        },
                        { OR: [{ mode: 'SINGLE' }, { periodNumber: 1, series: { state: 'RECRUITING' } }] }
                      ]
                    }
                  ]
                },
                { OR: [{ capacityUnlimited: true }, { seats: { some: { registration: { is: null } } } }] }
              ]
            }
          : { startsAt: { gte: start, lt: end } },
        ...(upcoming ? { take: 3 } : {}),
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        select: activityListSelect(actor.accountId)
      });
      return {
        items: rows.map((row) => activitySummary(row, actor.accountId, now)),
        serverNow: now.toISOString(),
        timeZone: 'Asia/Shanghai'
      };
    });
  }
  async mine(token?: string | null, url?: URL): Promise<MyActivities> {
    // Keep pagination totals and rows on one snapshot while concurrent activities change.
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.auth.requireAccount(tx, token),
          now = this.auth.now();
        const section = async (kind: 'registered' | 'published') => {
          const periodValue = url?.searchParams.get(`${kind}Period`) ?? 'current';
          if (periodValue !== 'current' && periodValue !== 'history')
            invalid(`${kind}Period`, '活动时间范围无效');
          const period: ActivityPeriod = periodValue;
          const pageValue = url?.searchParams.get(`${kind}Page`) ?? '1';
          if (!/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(Number(pageValue)))
            invalid(`${kind}Page`, '页码无效');
          const pageSize = 10;
          const where: Prisma.ActivityWhereInput = {
            ...(kind === 'published'
              ? { organizerId: actor.accountId }
              : { registrations: { some: { accountId: actor.accountId } } }),
            ...(period === 'current'
              ? { cancelledAt: null, endsAt: { gt: now } }
              : { OR: [{ cancelledAt: { not: null } }, { endsAt: { lte: now } }] })
          };
          const total = await tx.activity.count({ where });
          const totalPages = Math.ceil(total / pageSize),
            page = Math.min(Number(pageValue), Math.max(1, totalPages));
          const rows = await tx.activity.findMany({
            where,
            skip: (page - 1) * pageSize,
            take: pageSize,
            orderBy: [{ startsAt: period === 'current' ? 'asc' : 'desc' }, { id: 'asc' }],
            select: activityListSelect(actor.accountId)
          });
          const pagination: MyActivitiesPagination = { page, pageSize, total, totalPages, period };
          return { items: rows.map((row) => activitySummary(row, actor.accountId, now)), pagination };
        };
        const [published, registered] = await Promise.all([section('published'), section('registered')]);
        return {
          published: published.items,
          registered: registered.items,
          publishedPagination: published.pagination,
          registeredPagination: registered.pagination,
          serverNow: now.toISOString(),
          timeZone: 'Asia/Shanghai'
        };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
  }
}
