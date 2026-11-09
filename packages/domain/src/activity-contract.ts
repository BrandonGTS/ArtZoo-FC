import { BEIJING_OFFSET_MS } from './beijing-time.js';
import {
  validateSeriesInput,
  generateSeriesPeriods,
  type ActivityScene,
  type ActivityMode,
  type OfflineActivityInput,
  type ActivitySeriesInput,
  type ActivitySeriesSummary
} from './activity-series-contract.js';
import { invalid } from './account-contract.js';
import { isMemberId } from './member-contract.js';
import {
  dutyPresetSeats,
  validateDutySelection,
  type DutySelection,
  type DutySnapshot,
  type DutyGroupKey
} from './duty-contract.js';

export type ActivityCategory = 'DUNGEON' | 'SOCIAL';
export type ActivityRole = 'TANK' | 'HEALER' | 'DAMAGE';
export const ACTIVITY_JOBS = [
  { name: '骑士', role: 'TANK' },
  { name: '战士', role: 'TANK' },
  { name: '暗黑骑士', role: 'TANK' },
  { name: '绝枪战士', role: 'TANK' },
  { name: '白魔法师', role: 'HEALER' },
  { name: '学者', role: 'HEALER' },
  { name: '占星术士', role: 'HEALER' },
  { name: '贤者', role: 'HEALER' },
  { name: '武僧', role: 'DAMAGE' },
  { name: '龙骑士', role: 'DAMAGE' },
  { name: '忍者', role: 'DAMAGE' },
  { name: '武士', role: 'DAMAGE' },
  { name: '钐镰客', role: 'DAMAGE' },
  { name: '蝰蛇剑士', role: 'DAMAGE' },
  { name: '吟游诗人', role: 'DAMAGE' },
  { name: '机工士', role: 'DAMAGE' },
  { name: '舞者', role: 'DAMAGE' },
  { name: '黑魔法师', role: 'DAMAGE' },
  { name: '召唤师', role: 'DAMAGE' },
  { name: '赤魔法师', role: 'DAMAGE' },
  { name: '绘灵法师', role: 'DAMAGE' }
] as const;
export type SeatRequirement =
  { kind: 'ANY' } | { kind: 'ROLE'; role: ActivityRole } | { kind: 'JOB'; job: string };
// Transport/resource bounds, not FF14 party composition rules.
export const ACTIVITY_LIMITS = { title: 100, description: 2000, seats: 200 } as const;
export const ACTIVITY_ALBUM_NAME_PREFIX = '活动关联 - ';
export const ACTIVITY_ALBUM_NAME_LIMIT = ACTIVITY_LIMITS.title + ACTIVITY_ALBUM_NAME_PREFIX.length;
export function activityAlbumName(title: string): string {
  return ACTIVITY_ALBUM_NAME_PREFIX + title.trim();
}
export interface CreateActivityInput {
  scene?: ActivityScene;
  mode?: ActivityMode;
  offline?: OfflineActivityInput;
  series?: ActivitySeriesInput;
  createAlbum?: boolean;
  album?: { name: string; categoryId: string | null };
  idempotencyKey: string;
  title: string;
  description: string;
  category: ActivityCategory;
  startsAt: string;
  endsAt: string;
  seats: SeatRequirement[];
  dutySelection: DutySelection | null;
}
export interface RegisterActivityInput {
  seatId: string | null;
  job: string | null;
}
export interface MoveActivityRegistrationInput extends RegisterActivityInput {
  seatId: string;
  expectedSeatId: string;
}
export type ActivityPeriod = 'current' | 'history';
export interface MyActivitiesPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  period: ActivityPeriod;
}
export interface ActivityPerson {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
}
export type ActivityStatus =
  'OPEN' | 'FULL' | 'REGISTRATION_CLOSED' | 'IN_PROGRESS' | 'TIME_ENDED' | 'CANCELLED';
export interface ActivityRegistration {
  id: string;
  seatId: string;
  job: string | null;
  rescheduleExitAllowed: boolean;
  registeredAt: string;
  participant: ActivityPerson;
}
export interface ActivitySeat {
  id: string;
  position: number;
  groupKey: DutyGroupKey | null;
  requirement: SeatRequirement;
  registration: ActivityRegistration | null;
}
export interface ActivityParticipation {
  id: string;
  status: 'ACTIVE' | 'WITHDRAWN' | 'CANCELLED';
  job: string | null;
  exitedAt: string | null;
}
export interface ActivitySummary {
  scene?: ActivityScene;
  mode?: ActivityMode;
  location?: string | null;
  meetingInstructions?: string | null;
  capacityUnlimited?: boolean;
  series?: ActivitySeriesSummary | null;
  revision: number;
  cancelledAt: string | null;
  cancellationReason: string | null;
  continuedAt: string | null;
  myParticipation: ActivityParticipation | null;
  duty: DutySnapshot | null;
  id: string;
  title: string;
  description: string;
  category: ActivityCategory;
  startsAt: string;
  endsAt: string;
  registrationClosesAt: string;
  createdAt: string;
  organizer: ActivityPerson;
  capacity: number;
  registeredCount: number;
  participants: ActivityPerson[];
  status: ActivityStatus;
  isOrganizer: boolean;
  myRegistration: ActivityRegistration | null;
}
export interface ActivityDetail extends ActivitySummary {
  seats: ActivitySeat[];
  serverNow: string;
  timeZone: 'Asia/Shanghai';
}
export interface ActivityHistory {
  items: { id: string; action: string; actorName: string; createdAt: string }[];
  scope: 'activity' | 'own';
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface ActivityList {
  items: ActivitySummary[];
  serverNow: string;
  timeZone: 'Asia/Shanghai';
}
export interface ActivityWriteResult {
  activity: ActivityDetail;
  replayed: boolean;
}
export interface ActivityNotification {
  id: string;
  activityId: string;
  activityTitle: string;
  participant: ActivityPerson;
  createdAt: string;
  kind: 'REGISTRATION_CREATED';
  channel: 'IN_APP';
  delivery: 'SIMULATED';
}
export interface MyActivities {
  published: ActivitySummary[];
  registered: ActivitySummary[];
  publishedPagination: MyActivitiesPagination;
  registeredPagination: MyActivitiesPagination;
  serverNow: string;
  timeZone: 'Asia/Shanghai';
}
function exact(body: Record<string, unknown>, keys: string[], field: string) {
  if (Object.keys(body).some((key) => !keys.includes(key))) invalid(field, '包含不允许提交的字段');
}
function text(value: unknown, field: string, max: number, required = true): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value.replace(/\r?\n/g, ''))
  )
    invalid(field, '内容格式或长度无效');
  const result = value.trim();
  if (required && !result) invalid(field, '请填写内容');
  return result;
}
export function activityId(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !isMemberId(value)) invalid(field, '标识无效');
  return value.toLowerCase();
}
export function parseBeijingActivityTime(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?\+08:00$/.test(value))
    invalid(field, '请选择有效北京时间');
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    new Date(parsed.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, value.includes('.') ? 23 : 19) +
      '+08:00' !==
      value
  )
    invalid(field, '请选择有效北京时间');
  return parsed;
}
export function validateSeatRequirement(value: unknown): SeatRequirement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('seats', '席位要求无效');
  const seat = value as Record<string, unknown>;
  if (seat.kind === 'ANY') {
    exact(seat, ['kind'], 'seats');
    return { kind: 'ANY' };
  }
  if (seat.kind === 'ROLE' && ['TANK', 'HEALER', 'DAMAGE'].includes(String(seat.role))) {
    exact(seat, ['kind', 'role'], 'seats');
    return { kind: 'ROLE', role: seat.role as ActivityRole };
  }
  if (seat.kind === 'JOB' && ACTIVITY_JOBS.some((job) => job.name === seat.job)) {
    exact(seat, ['kind', 'job'], 'seats');
    return { kind: 'JOB', job: seat.job as string };
  }
  return invalid('seats', '席位要求无效');
}
export function validateCreateActivity(body: Record<string, unknown>): CreateActivityInput {
  exact(
    body,
    [
      'idempotencyKey',
      'title',
      'description',
      'category',
      'startsAt',
      'endsAt',
      'seats',
      'dutySelection',
      'scene',
      'mode',
      'offline',
      'series',
      'createAlbum',
      'album'
    ],
    'activity'
  );
  if (body.createAlbum !== undefined && typeof body.createAlbum !== 'boolean')
    invalid('createAlbum', '关联相册选择无效');
  const title = text(body.title, 'title', ACTIVITY_LIMITS.title);
  let album: Pick<CreateActivityInput, 'createAlbum' | 'album'> = {};
  if (body.createAlbum === true) {
    if (!body.album || typeof body.album !== 'object' || Array.isArray(body.album))
      invalid('albumName', '请填写关联相册信息');
    const config = body.album as Record<string, unknown>;
    exact(config, ['name', 'categoryId'], 'album');
    if (!Object.hasOwn(config, 'categoryId')) invalid('albumCategoryId', '请明确相册分类，未分类时提交null');
    const name = text(config.name, 'albumName', ACTIVITY_ALBUM_NAME_LIMIT);
    // Existing callers may still supply a short custom name. Only the complete
    // derived activity name can exceed the ordinary 100-character bound.
    if (name.length > 100 && name !== activityAlbumName(title))
      invalid('albumName', '相册名称内容或长度无效');
    album = {
      createAlbum: true,
      album: {
        name,
        categoryId: config.categoryId == null ? null : activityId(config.categoryId, 'albumCategoryId')
      }
    };
  } else if (body.album != null) invalid('album', '未选择建立关联相册');
  const scene = body.scene ?? 'GAME',
    mode = body.mode ?? 'SINGLE';
  if (scene !== 'GAME' && scene !== 'OFFLINE') invalid('scene', '活动场景无效');
  if (mode !== 'SINGLE' && mode !== 'SERIES') invalid('mode', '活动模式无效');
  if (scene === 'OFFLINE') {
    if (mode !== 'SINGLE' || body.series != null || body.category !== 'SOCIAL' || body.dutySelection != null)
      invalid('scene', '线下活动不使用游戏副本或长期排期');
    const raw = body.offline;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('offline', '请填写线下活动信息');
    const offline = raw as Record<string, unknown>;
    exact(offline, ['location', 'meetingInstructions', 'registrationClosesAt', 'capacity'], 'offline');
    const capacity = offline.capacity;
    if (
      capacity !== null &&
      (!Number.isInteger(capacity) || Number(capacity) < 1 || Number(capacity) > ACTIVITY_LIMITS.seats)
    )
      invalid('capacity', '人数上限须为1至200人，或选择不限人数');
    const start = parseBeijingActivityTime(body.startsAt, 'startsAt'),
      end = parseBeijingActivityTime(body.endsAt, 'endsAt');
    const cutoff = parseBeijingActivityTime(offline.registrationClosesAt, 'registrationClosesAt');
    if (end <= start) invalid('endsAt', '预定结束必须晚于开始');
    if (cutoff > start) invalid('registrationClosesAt', '报名截止不能晚于开始时间');
    if (!Array.isArray(body.seats) || body.seats.length)
      invalid('seats', '线下人数由人数上限设置，不提交游戏席位');
    return {
      ...album,
      idempotencyKey: activityId(body.idempotencyKey, 'idempotencyKey'),
      title: text(body.title, 'title', ACTIVITY_LIMITS.title),
      description: text(body.description, 'description', ACTIVITY_LIMITS.description, false),
      category: 'SOCIAL',
      scene: 'OFFLINE',
      mode: 'SINGLE',
      dutySelection: null,
      startsAt: body.startsAt as string,
      endsAt: body.endsAt as string,
      seats: Array.from({ length: capacity === null ? 0 : Number(capacity) }, () => ({
        kind: 'ANY' as const
      })),
      offline: {
        location: text(offline.location, 'location', 500),
        meetingInstructions: text(offline.meetingInstructions, 'meetingInstructions', 2000, false),
        registrationClosesAt: offline.registrationClosesAt as string,
        capacity: capacity as number | null
      }
    };
  }
  if (body.offline != null) invalid('offline', '游戏活动不能提交线下信息');
  const series = mode === 'SERIES' ? validateSeriesInput(body.series) : undefined;
  if (mode === 'SINGLE' && body.series != null) invalid('series', '单次活动不能提交重复排期');
  if (body.category !== 'DUNGEON' && body.category !== 'SOCIAL') invalid('category', '活动分类无效');
  const start = parseBeijingActivityTime(body.startsAt, 'startsAt'),
    end = parseBeijingActivityTime(body.endsAt, 'endsAt');
  if (end <= start) invalid('endsAt', '预定结束必须晚于开始');
  if (!Array.isArray(body.seats) || body.seats.length < 1 || body.seats.length > ACTIVITY_LIMITS.seats)
    invalid('seats', '请设置1至200个席位');
  if (series) {
    const generated = generateSeriesPeriods(start, series);
    if (end.getTime() !== generated[0]!.endsAt.getTime()) invalid('endsAt', '结束时间须符合每期时长');
  }
  const seats = body.seats.map(validateSeatRequirement);
  const dutySelection = body.category === 'DUNGEON' ? validateDutySelection(body.dutySelection) : null;
  if (body.category === 'SOCIAL' && body.dutySelection != null)
    invalid('dutySelection', '非副本聚会不能选择副本');
  if (
    dutySelection?.type === 'OTHER' &&
    dutySelection.partyComposition !== 'CUSTOM' &&
    seats.length !== dutyPresetSeats(dutySelection.partyComposition).length
  )
    invalid('seats', '席位人数必须符合所选编制');
  if (body.category === 'SOCIAL' && seats.some((seat) => seat.kind !== 'ANY'))
    invalid('seats', '非副本聚会使用不限席位');
  return {
    ...album,
    ...(series ? { scene: 'GAME' as const, mode: 'SERIES' as const, series } : {}),
    idempotencyKey: activityId(body.idempotencyKey, 'idempotencyKey'),
    title: text(body.title, 'title', ACTIVITY_LIMITS.title),
    description: text(body.description, 'description', ACTIVITY_LIMITS.description, false),
    category: body.category,
    dutySelection,
    startsAt: body.startsAt as string,
    endsAt: body.endsAt as string,
    seats
  };
}
export function validateActivityRegistration(body: Record<string, unknown>): RegisterActivityInput {
  exact(body, ['seatId', 'job'], 'registration');
  if (body.job !== null && !ACTIVITY_JOBS.some((job) => job.name === body.job))
    invalid('job', '请选择有效职业');
  return {
    seatId: body.seatId === null ? null : activityId(body.seatId, 'seatId'),
    job: body.job as string | null
  };
}
export function validateActivityRegistrationMove(
  body: Record<string, unknown>
): MoveActivityRegistrationInput {
  exact(body, ['expectedSeatId', 'seatId', 'job'], 'registration');
  return {
    ...validateActivityRegistration({ seatId: body.seatId, job: body.job }),
    seatId: activityId(body.seatId, 'seatId'),
    expectedSeatId: activityId(body.expectedSeatId, 'expectedSeatId')
  };
}
export function jobMeetsSeat(requirement: SeatRequirement, job: string): boolean {
  const found = ACTIVITY_JOBS.find((item) => item.name === job);
  return (
    !!found &&
    (requirement.kind === 'ANY' ||
      (requirement.kind === 'ROLE' ? found.role === requirement.role : found.name === requirement.job))
  );
}
export function activityStatus(
  startsAt: Date,
  endsAt: Date,
  now: Date,
  full: boolean,
  registrationClosesAt = new Date(startsAt.getTime() - 30 * 60000)
): ActivityStatus {
  if (now >= endsAt) return 'TIME_ENDED';
  if (now >= startsAt) return 'IN_PROGRESS';
  if (now >= registrationClosesAt) return 'REGISTRATION_CLOSED';
  return full ? 'FULL' : 'OPEN';
}
