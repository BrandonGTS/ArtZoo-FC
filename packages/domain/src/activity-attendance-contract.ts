import { invalid } from './account-contract.js';
import { activityId, type ActivityPerson } from './activity-contract.js';
export type AttendanceStatus = 'PRESENT' | 'ABSENT';
export interface AttendanceAppeal {
  id: string;
  registrationId: string;
  attendanceRevision: number;
  requestedStatus: AttendanceStatus;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  revision: number;
  decisionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
}
export interface ActivityAttendance {
  activityId: string;
  serverNow: string;
  startsAt: string;
  endsAt: string;
  isOrganizer: boolean;
  eligible: boolean;
  windowOpen: boolean;
  autoAbsence: boolean;
  cancelled: boolean;
  items: {
    registrationId: string;
    participant: ActivityPerson;
    status: AttendanceStatus | null;
    source: string | null;
    revision: number;
    recordedAt: string | null;
    updatedAt: string | null;
    completion: { status: 'PENDING' | 'CREDITED' | 'NOT_CREDITED'; evaluatedAt: string | null } | null;
    canEdit: boolean;
    canAppeal: boolean;
    appeal: AttendanceAppeal | null;
  }[];
}
export interface AttendanceAppealPage {
  items: (AttendanceAppeal & {
    activityId: string;
    activityTitle: string;
    participantName: string;
    currentStatus: AttendanceStatus | null;
  })[];
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
}
export interface AttendanceCommand {
  idempotencyKey: string;
  expectedAttendanceRevision: number;
}
export interface RecordAttendanceInput extends AttendanceCommand {
  registrationId: string;
  status: AttendanceStatus;
}
export interface SubmitAttendanceAppealInput extends AttendanceCommand {
  registrationId: string;
  requestedStatus: AttendanceStatus;
  reason: string;
}
export interface DecideAttendanceAppealInput extends AttendanceCommand {
  expectedAppealRevision: number;
  decision: 'APPROVE' | 'REJECT';
  reason: string;
}
function exact(body: Record<string, unknown>, keys: string[]) {
  if (Object.keys(body).some((key) => !keys.includes(key))) invalid('attendance', '包含不允许提交的字段');
}
function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(field, '记录版本无效，请刷新后重试');
  return value as number;
}
function command(body: Record<string, unknown>): AttendanceCommand {
  return {
    idempotencyKey: activityId(body.idempotencyKey, 'idempotencyKey'),
    expectedAttendanceRevision: revision(body.expectedAttendanceRevision, 'expectedAttendanceRevision')
  };
}
function status(value: unknown): AttendanceStatus {
  if (value !== 'PRESENT' && value !== 'ABSENT') invalid('status', '请选择到场或未到场');
  return value;
}
function reason(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 1000 ||
    /[\p{Cc}\p{Cf}]/u.test(value.replace(/\r?\n/g, ''))
  )
    invalid('reason', '请填写1至1000字的原因');
  return value.trim();
}
export function validateAttendance(body: Record<string, unknown>): RecordAttendanceInput {
  exact(body, ['idempotencyKey', 'expectedAttendanceRevision', 'registrationId', 'status']);
  return {
    ...command(body),
    registrationId: activityId(body.registrationId, 'registrationId'),
    status: status(body.status)
  };
}
export function validateAttendanceAppeal(body: Record<string, unknown>): SubmitAttendanceAppealInput {
  exact(body, [
    'idempotencyKey',
    'expectedAttendanceRevision',
    'registrationId',
    'requestedStatus',
    'reason'
  ]);
  return {
    ...command(body),
    registrationId: activityId(body.registrationId, 'registrationId'),
    requestedStatus: status(body.requestedStatus),
    reason: reason(body.reason)
  };
}
export function validateAttendanceDecision(body: Record<string, unknown>): DecideAttendanceAppealInput {
  exact(body, [
    'idempotencyKey',
    'expectedAttendanceRevision',
    'expectedAppealRevision',
    'decision',
    'reason'
  ]);
  if (body.decision !== 'APPROVE' && body.decision !== 'REJECT') invalid('decision', '请选择同意或驳回');
  return {
    ...command(body),
    expectedAppealRevision: revision(body.expectedAppealRevision, 'expectedAppealRevision'),
    decision: body.decision,
    reason: reason(body.reason)
  };
}
