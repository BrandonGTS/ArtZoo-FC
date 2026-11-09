import { invalid } from './account-contract.js';
import { beijingDateKey } from './beijing-time.js';
import { teamSessionInCycle, type TeamCycleWindow } from './team-cycle.js';
import {
  activityId,
  jobMeetsSeat,
  parseBeijingActivityTime,
  validateSeatRequirement,
  ACTIVITY_JOBS,
  type SeatRequirement
} from './activity-contract.js';
export const TEAM_POSITIONS = ['MT', 'ST', 'H1', 'H2', 'D1', 'D2', 'D3', 'D4'] as const;
export type TeamChoice = 'CAN' | 'CANNOT';
export interface TeamPerson {
  id: string;
  displayName: string | null;
  gameRegion: string | null;
  gameServer: string | null;
  avatarUrl: string | null;
}
export interface TeamSeatView {
  id: string;
  position: number;
  requirement: SeatRequirement;
  pendingApplicationCount: number;
  member: { id: string; person: TeamPerson; job: string } | null;
}
export interface TeamSummary {
  id: string;
  name: string;
  description: string;
  dutyName: string;
  progress: string;
  strategy: string;
  commonTimes: string;
  createdAt: string;
  recruitmentCompletedAt: string | null;
  state: string;
  revision: number;
  creator: TeamPerson;
  isCreator: boolean;
  isMember: boolean;
  seats: TeamSeatView[];
}
export interface TeamApplicationView {
  id: string;
  seatPosition: number;
  person: TeamPerson;
  job: string;
  note: string;
  state: string;
}
export type TeamParticipationStatus = 'PRESENT' | 'LEAVE' | 'ABSENT';
export interface TeamParticipationChangeView {
  id: string;
  status: TeamParticipationStatus;
  reason: string;
  actor: TeamPerson;
  recordedAt: string;
}
export interface TeamSessionView {
  id: string;
  startsAt: string;
  endsAt: string;
  state: 'PROPOSED' | 'CONFIRMED' | 'CANCELLED';
  timeVersion: number;
  feedback: { person: TeamPerson; choice: TeamChoice | null }[];
  myChoice: TeamChoice | null;
  members: {
    id: string;
    person: TeamPerson;
    position: number;
    job: string;
    state: string;
    records: TeamParticipationChangeView[];
    leave: { reason: string; recordedById: string; createdAt: string } | null;
  }[];
  substitutes: {
    id: string;
    position: number;
    person: TeamPerson | null;
    displayName: string | null;
    gameRegion: string | null;
    gameServer: string | null;
    job: string;
    records: TeamParticipationChangeView[];
  }[];
}
export interface TeamDetail extends TeamSummary {
  currentAccountId: string;
  serverNow: string;
  qqGroupId: string | null;
  applications: TeamApplicationView[];
  sessions: TeamSessionView[] | null;
}
export interface TeamList {
  items: TeamSummary[];
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
}
export const TEAM_PAGE_SIZE = 15;
export interface TeamWriteResult {
  team: TeamDetail;
  replayed: boolean;
}
export interface TeamSeatInput {
  position: number;
  requirement: SeatRequirement;
}
export interface TeamMetadataInput {
  name: string;
  description: string;
  dutyName: string;
  progress: string;
  strategy: string;
  commonTimes: string;
  qqGroupId: string | null;
}
export interface CreateTeamInput extends TeamMetadataInput {
  idempotencyKey: string;
  seats: TeamSeatInput[];
}
export function teamExact(body: Record<string, unknown>, keys: string[]) {
  if (Object.keys(body).some((key) => !keys.includes(key))) invalid('team', '包含不允许提交的字段');
}
export function teamText(value: unknown, field: string, max: number, required = true): string {
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
export function teamPosition(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 7)
    invalid('position', '请选择固定队席位');
  return Number(value);
}
export function teamJob(value: unknown): string {
  if (!ACTIVITY_JOBS.some((job) => job.name === value)) invalid('job', '请选择有效职业');
  return value as string;
}
export function teamCommand(body: Record<string, unknown>, fields: string[] = []) {
  teamExact(body, ['idempotencyKey', 'expectedRevision', ...fields]);
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
    invalid('expectedRevision', '队伍版本无效');
  return {
    idempotencyKey: activityId(body.idempotencyKey, 'idempotencyKey'),
    expectedRevision: Number(body.expectedRevision)
  };
}
export function validateCreateTeam(body: Record<string, unknown>): CreateTeamInput {
  teamExact(body, [
    'idempotencyKey',
    'name',
    'description',
    'dutyName',
    'progress',
    'strategy',
    'commonTimes',
    'qqGroupId',
    'seats'
  ]);
  if (!Array.isArray(body.seats) || body.seats.length !== 8) invalid('seats', '固定队须保留MT至D4的八个席位');
  const seats = body.seats.map((value, position) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('seats', '席位格式无效');
    const seat = value as Record<string, unknown>;
    teamExact(seat, ['position', 'requirement']);
    if (teamPosition(seat.position) !== position) invalid('seats', '席位须按MT至D4顺序设置');
    const requirement = validateSeatRequirement(seat.requirement);
    if (requirement.kind === 'ANY') invalid('seats', '请选择职能或具体职业要求');
    return { position, requirement };
  });
  return { idempotencyKey: activityId(body.idempotencyKey, 'idempotencyKey'), ...teamMetadata(body), seats };
}
export function teamMetadata(body: Record<string, unknown>): TeamMetadataInput {
  return {
    name: teamText(body.name, 'name', 100),
    description: teamText(body.description, 'description', 2000, false),
    dutyName: teamText(body.dutyName, 'dutyName', 200),
    progress: teamText(body.progress, 'progress', 500),
    strategy: teamText(body.strategy, 'strategy', 2000),
    commonTimes: teamText(body.commonTimes, 'commonTimes', 500),
    qqGroupId: body.qqGroupId === null ? null : teamText(body.qqGroupId, 'qqGroupId', 100, false) || null
  };
}
export function teamApplicationInput(
  body: Record<string, unknown>,
  requirement: SeatRequirement
): { job: string; note: string } {
  const job = requirement.kind === 'JOB' ? requirement.job : teamJob(body.job);
  if (requirement.kind === 'JOB' && body.job != null && body.job !== job)
    invalid('job', '职业不符合席位要求');
  if (!jobMeetsSeat(requirement, job)) invalid('job', '职业不符合席位要求');
  return { job, note: teamText(body.note, 'note', 1000) };
}
export function teamPage(value: unknown): number {
  if (value == null) return 1;
  if (typeof value !== 'string' || !/^[1-9]\d{0,8}$/.test(value)) invalid('page', '页码无效');
  return Number(value);
}

export function teamTimes(body: Record<string, unknown>): { startsAt: Date; endsAt: Date } {
  const startsAt = parseBeijingActivityTime(body.startsAt, 'startsAt'),
    endsAt = parseBeijingActivityTime(body.endsAt, 'endsAt');
  if (endsAt <= startsAt) invalid('endsAt', '结束时间须晚于开始');
  return { startsAt, endsAt };
}

/** Multiple sessions may share a Beijing date; only identical intervals are duplicates. */
export function teamBatchTimes(
  body: Record<string, unknown>,
  window: TeamCycleWindow
): { startsAt: Date; endsAt: Date }[] {
  if (!Array.isArray(body.sessions) || !body.sessions.length) {
    invalid('sessions', '请至少添加一场下周排期');
  }
  const intervals = new Set<string>();
  return body.sessions.map((value, index) => {
    const field = `sessions.${index}`,
      label = `第${index + 1}项`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, `${label}场次格式无效`);
    const session = value as Record<string, unknown>;
    if (Object.keys(session).some((key) => !['startsAt', 'endsAt'].includes(key)))
      invalid(field, `${label}包含不允许提交的字段`);
    const startsAt = parseBeijingActivityTime(session.startsAt, `${field}.startsAt`);
    const endsAt = parseBeijingActivityTime(session.endsAt, `${field}.endsAt`);
    const date = beijingDateKey(startsAt);
    if (endsAt <= startsAt) invalid(`${field}.endsAt`, `${date}结束时间须晚于开始`);
    if (!teamSessionInCycle(startsAt, window))
      invalid(`${field}.startsAt`, `${date}开场时间须在所选周范围内`);
    const interval = `${startsAt.getTime()}/${endsAt.getTime()}`;
    if (intervals.has(interval)) invalid(`${field}.startsAt`, `${date}已添加完全相同的时间段`);
    intervals.add(interval);
    return { startsAt, endsAt };
  });
}

export interface TeamHistoryPage extends TeamHistory {
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface TeamHistory {
  items: {
    teamId: string;
    teamName: string;
    teamState: string;
    sessions: {
      id: string;
      startsAt: string;
      endsAt: string;
      state: string;
      position: number;
      job: string;
      participation: 'MEMBER' | 'NEEDS_SUBSTITUTE' | 'LEAVE' | 'SUBSTITUTE';
      reason: string | null;
      records: TeamParticipationChangeView[];
    }[];
  }[];
}
