import { AccountError, invalid } from './account-contract.js';
import {
  activityId,
  jobMeetsSeat,
  validateCreateActivity,
  type ActivityCategory,
  type CreateActivityInput,
  type SeatRequirement
} from './activity-contract.js';

// Input contracts only. The service must authorize the actor, resolve the duty catalog,
// and apply confirmed lifecycle/time rules inside the shared activity transaction.
export interface ActivityManagementCommand {
  idempotencyKey: string;
  expectedRevision: number;
}
export interface WithdrawActivityInput extends ActivityManagementCommand {
  expectedRegistrationId: string;
  expectedPenaltyPoints: 0 | 1;
}
export interface CancelActivityInput extends ActivityManagementCommand {
  expectedPenaltyPoints: 0 | 2;
}
export interface EditActivitySeat {
  id: string | null;
  requirement: SeatRequirement;
}
export interface EditActivityInput extends Omit<CreateActivityInput, 'seats'>, ActivityManagementCommand {
  seats: EditActivitySeat[];
}
export interface ExistingActivitySeat {
  id: string;
  registration: { job: string | null } | null;
}

function exact(body: Record<string, unknown>, keys: readonly string[], field: string) {
  if (Object.keys(body).some((key) => !keys.includes(key))) invalid(field, '包含不允许提交的字段');
}
function command(body: Record<string, unknown>): ActivityManagementCommand {
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) {
    invalid('expectedRevision', '活动版本无效，请刷新后重试');
  }
  return {
    idempotencyKey: activityId(body.idempotencyKey, 'idempotencyKey'),
    expectedRevision: body.expectedRevision as number
  };
}
export function validateActivityCancellation(body: Record<string, unknown>): CancelActivityInput {
  exact(body, ['idempotencyKey', 'expectedRevision', 'expectedPenaltyPoints'], 'cancellation');
  if (body.expectedPenaltyPoints !== 0 && body.expectedPenaltyPoints !== 2)
    invalid('expectedPenaltyPoints', '请重新确认本次取消的处罚');
  return { ...command(body), expectedPenaltyPoints: body.expectedPenaltyPoints };
}
export function validateActivityContinuation(body: Record<string, unknown>): ActivityManagementCommand {
  exact(body, ['idempotencyKey', 'expectedRevision'], 'continuation');
  return command(body);
}
export function validateActivityWithdrawal(body: Record<string, unknown>): WithdrawActivityInput {
  exact(
    body,
    ['idempotencyKey', 'expectedRevision', 'expectedRegistrationId', 'expectedPenaltyPoints'],
    'withdrawal'
  );
  if (body.expectedPenaltyPoints !== 0 && body.expectedPenaltyPoints !== 1)
    invalid('expectedPenaltyPoints', '请重新确认本次退出的处罚');
  return {
    ...command(body),
    expectedPenaltyPoints: body.expectedPenaltyPoints,
    expectedRegistrationId: activityId(body.expectedRegistrationId, 'expectedRegistrationId')
  };
}
export function validateActivityEdit(body: Record<string, unknown>): EditActivityInput {
  exact(
    body,
    [
      'idempotencyKey',
      'expectedRevision',
      'title',
      'description',
      'category',
      'startsAt',
      'endsAt',
      'seats',
      'dutySelection'
    ],
    'activity'
  );
  const operation = command(body);
  if (!Array.isArray(body.seats)) invalid('seats', '请设置活动席位');
  const ids = new Set<string>();
  const seats = body.seats.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('seats', '席位格式无效');
    const seat = value as Record<string, unknown>;
    exact(seat, ['id', 'requirement'], 'seats');
    const id = seat.id === null ? null : activityId(seat.id, 'seats');
    if (id && ids.has(id)) invalid('seats', '同一席位不能重复出现');
    if (id) ids.add(id);
    return { id, requirement: seat.requirement };
  });
  // Reuse the accepted publication bounds, Beijing parsing and composition checks.
  const validated = validateCreateActivity({
    idempotencyKey: operation.idempotencyKey,
    title: body.title,
    description: body.description,
    category: body.category,
    startsAt: body.startsAt,
    endsAt: body.endsAt,
    dutySelection: body.dutySelection,
    seats: seats.map((seat) => seat.requirement)
  });
  return {
    ...validated,
    ...operation,
    seats: seats.map((seat, index) => ({
      id: seat.id,
      requirement: validated.seats[index]!
    }))
  };
}

// Pass only current seats/active registrations from the locked database snapshot.
// No member is removed, moved or has their chosen job rewritten by an edit.
export function assertActivitySeatEditPreservesRegistrations(
  existing: readonly ExistingActivitySeat[],
  proposed: readonly EditActivitySeat[],
  category: ActivityCategory
): void {
  const old = new Map(existing.map((seat) => [seat.id, seat]));
  const next = new Map<string, EditActivitySeat>();
  for (const seat of proposed) {
    if (!seat.id) continue;
    if (!old.has(seat.id)) invalid('seats', '席位不属于该活动');
    if (next.has(seat.id)) invalid('seats', '同一席位不能重复出现');
    next.set(seat.id, seat);
  }
  for (const seat of existing) {
    if (!seat.registration) continue;
    const candidate = next.get(seat.id);
    if (!candidate) throw new AccountError('CONFLICT', '不能删除已报名席位，请保留该成员的席位', 409);
    const job = seat.registration.job;
    if (category === 'SOCIAL' ? job !== null : !job || !jobMeetsSeat(candidate.requirement, job)) {
      throw new AccountError('CONFLICT', '修改后的活动或席位要求不符合已有报名职业', 409);
    }
  }
}

// These point expectations do not authorize an operation. Services separately enforce
// owner/registration/version and pre-start eligibility under their transaction locks.
export function activityWithdrawalPenalty(startsAt: Date, now: Date, rescheduled: boolean): 0 | 1 {
  return !rescheduled && startsAt.getTime() - now.getTime() < 2 * 3600000 ? 1 : 0;
}
export function activityCancellationPenalty(
  startsAt: Date,
  now: Date,
  registered: number,
  capacity: number,
  continued: boolean
): 0 | 2 {
  const shortage = now.getTime() >= startsAt.getTime() - 30 * 60000 && registered < capacity && !continued;
  return !shortage && startsAt.getTime() - now.getTime() < 4 * 3600000 ? 2 : 0;
}
