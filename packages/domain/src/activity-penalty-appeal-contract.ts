import { invalid } from './account-contract.js';
import { activityId } from './activity-contract.js';
export const PENALTY_APPEAL_WINDOW = 7 * 86400000;
export type AppealablePenaltyReason =
  'LATE_WITHDRAWAL' | 'LATE_CANCELLATION' | 'SERIES_UNAGREED_ABSENCE' | 'SERIES_UNCOMMUNICATED_EXIT';
export interface PenaltyAppeal {
  id: string;
  penaltyId: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  revision: number;
  createdAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
}
export interface MyActivityPenalty {
  id: string;
  reason: AppealablePenaltyReason;
  points: number;
  createdAt: string;
  reversedAt: string | null;
  activityId: string;
  activityTitle: string;
  expiresAt: string;
  canAppeal: boolean;
  latestAppeal: PenaltyAppeal | null;
}
export interface PenaltyPage {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface MyActivityPenalties extends PenaltyPage {
  serverNow: string;
  points: number;
  restricted: boolean;
  items: MyActivityPenalty[];
}
export interface PenaltyAppealPage extends PenaltyPage {
  items: (PenaltyAppeal & {
    participantName: string;
    activityId: string;
    activityTitle: string;
    penaltyReason: AppealablePenaltyReason;
    penaltyPoints: number;
    penaltyCreatedAt: string;
    reversedAt: string | null;
  })[];
}
export interface SubmitPenaltyAppealInput {
  idempotencyKey: string;
  expectedLatestAppealId: string | null;
  reason: string;
}
export interface DecidePenaltyAppealInput {
  idempotencyKey: string;
  expectedAppealRevision: number;
  decision: 'APPROVE' | 'REJECT';
  reason: string;
}
export function penaltyAppealDeadline(createdAt: Date) {
  return new Date(createdAt.getTime() + PENALTY_APPEAL_WINDOW);
}
export function penaltyAppealWindowOpen(createdAt: Date, now: Date) {
  return now >= createdAt && now < penaltyAppealDeadline(createdAt);
}
function exact(body: Record<string, unknown>, keys: string[]) {
  if (Object.keys(body).some((key) => !keys.includes(key))) invalid('appeal', '包含不允许提交的字段');
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
export function validatePenaltyAppeal(body: Record<string, unknown>): SubmitPenaltyAppealInput {
  exact(body, ['idempotencyKey', 'expectedLatestAppealId', 'reason']);
  return {
    idempotencyKey: activityId(body.idempotencyKey, 'idempotencyKey'),
    reason: reason(body.reason),
    expectedLatestAppealId:
      body.expectedLatestAppealId === null
        ? null
        : activityId(body.expectedLatestAppealId, 'expectedLatestAppealId')
  };
}
export function validatePenaltyAppealDecision(body: Record<string, unknown>): DecidePenaltyAppealInput {
  exact(body, ['idempotencyKey', 'expectedAppealRevision', 'decision', 'reason']);
  if (!Number.isSafeInteger(body.expectedAppealRevision) || (body.expectedAppealRevision as number) < 0)
    invalid('expectedAppealRevision', '申诉版本无效，请刷新');
  if (body.decision !== 'APPROVE' && body.decision !== 'REJECT') invalid('decision', '请选择同意或驳回');
  return {
    idempotencyKey: activityId(body.idempotencyKey, 'idempotencyKey'),
    expectedAppealRevision: body.expectedAppealRevision as number,
    decision: body.decision,
    reason: reason(body.reason)
  };
}
