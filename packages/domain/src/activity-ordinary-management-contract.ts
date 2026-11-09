import { invalid } from './account-contract.js';
import {
  activityId,
  parseBeijingActivityTime,
  validateActivityRegistrationMove
} from './activity-contract.js';

export type OrdinaryManagementAction = 'withdraw' | 'move' | 'cancel' | 'reschedule';
export interface OrdinaryCommand {
  idempotencyKey: string;
  expectedRevision: number;
}
export type OrdinaryManagementInput =
  | (OrdinaryCommand & { action: 'withdraw'; expectedRegistrationId: string })
  | (OrdinaryCommand & {
      action: 'move';
      expectedRegistrationId: string;
      expectedSeatId: string;
      seatId: string;
      job: string | null;
    })
  | (OrdinaryCommand & { action: 'cancel'; confirmed: true })
  | (OrdinaryCommand & { action: 'reschedule'; startsAt: string; endsAt: string; allMembersAgreed: true });
export function ordinaryManagementTime(value: unknown, field: string): string {
  const time =
    typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value) ? value + ':00+08:00' : value;
  parseBeijingActivityTime(time, field);
  return time as string;
}
export function validateOrdinaryManagement(
  action: unknown,
  body: Record<string, unknown>
): OrdinaryManagementInput {
  if (!['withdraw', 'move', 'cancel', 'reschedule'].includes(String(action)))
    invalid('action', '管理操作无效');
  const extra =
    action === 'withdraw'
      ? ['expectedRegistrationId']
      : action === 'move'
        ? ['expectedRegistrationId', 'expectedSeatId', 'seatId', 'job']
        : action === 'cancel'
          ? ['confirmed']
          : ['startsAt', 'endsAt', 'allMembersAgreed'];
  if (Object.keys(body).some((key) => !['idempotencyKey', 'expectedRevision', ...extra].includes(key)))
    invalid('management', '包含不允许提交的字段');
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
    invalid('expectedRevision', '活动版本无效，请刷新后重试');
  const command = {
    idempotencyKey: activityId(body.idempotencyKey, 'idempotencyKey'),
    expectedRevision: Number(body.expectedRevision)
  };
  if (action === 'withdraw')
    return {
      ...command,
      action,
      expectedRegistrationId: activityId(body.expectedRegistrationId, 'expectedRegistrationId')
    };
  if (action === 'move')
    return {
      ...command,
      action,
      expectedRegistrationId: activityId(body.expectedRegistrationId, 'expectedRegistrationId'),
      ...validateActivityRegistrationMove({
        expectedSeatId: body.expectedSeatId,
        seatId: body.seatId,
        job: body.job
      })
    };
  if (action === 'cancel') {
    if (body.confirmed !== true) invalid('confirmed', '请确认取消活动');
    return { ...command, action, confirmed: true };
  }
  if (body.allMembersAgreed !== true) invalid('allMembersAgreed', '请先确认已征得全员同意');
  const startsAt = ordinaryManagementTime(body.startsAt, 'startsAt'),
    endsAt = ordinaryManagementTime(body.endsAt, 'endsAt');
  if (Date.parse(endsAt) <= Date.parse(startsAt)) invalid('endsAt', '结束时间须晚于开始时间');
  return { ...command, action: 'reschedule', startsAt, endsAt, allMembersAgreed: true };
}
