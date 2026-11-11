import { AccountError } from '@artzoo/domain';

/** The caller derives both eligibility flags from the locked target and authenticated actor. */
export function deletionIntent(
  body: Record<string, unknown>,
  ordinaryEligible: boolean,
  moderationEligible: boolean,
  ordinaryReason: string,
  limit: number
) {
  const intent = body.intent;
  if (intent !== 'SELF' && intent !== 'MODERATE')
    throw new AccountError('VALIDATION_ERROR', '删除操作无效', 400);
  if (intent === 'SELF') {
    if (!ordinaryEligible) throw new AccountError('FORBIDDEN', '没有普通删除权限', 403);
    return { moderate: false, reason: ordinaryReason };
  }
  if (!moderationEligible) throw new AccountError('FORBIDDEN', '仅管理员可以处理违规内容', 403);
  if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > limit)
    throw new AccountError('VALIDATION_ERROR', '请填写有效的处理原因', 400);
  return { moderate: true, reason: body.reason.trim() };
}
