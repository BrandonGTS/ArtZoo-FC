import { invalid } from './account-contract.js';
import { activityId } from './activity-contract.js';

export interface CancelSeriesPeriodInput {
  idempotencyKey: string;
  expectedRevision: number;
  allMembersAgreed: true;
}

// This attests to the organizer's off-site consultation, not an online vote.
export function validateSeriesPeriodCancellation(body: Record<string, unknown>): CancelSeriesPeriodInput {
  if (
    Object.keys(body).some((key) => !['idempotencyKey', 'expectedRevision', 'allMembersAgreed'].includes(key))
  ) {
    invalid('cancellation', '包含不允许提交的字段');
  }
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) {
    invalid('expectedRevision', '活动版本无效，请刷新后重试');
  }
  if (body.allMembersAgreed !== true) invalid('allMembersAgreed', '请先确认已征得全员同意');
  return {
    idempotencyKey: activityId(body.idempotencyKey, 'idempotencyKey'),
    expectedRevision: Number(body.expectedRevision),
    allMembersAgreed: true
  };
}
