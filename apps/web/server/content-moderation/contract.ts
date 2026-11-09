import { AccountError } from '@artzoo/domain';
import { fields, key, text } from '../wishes/contract';

/** Explicit, single-target governance command. No author-delete/cancel semantics. */
export function moderationInput(body: Record<string, unknown>) {
  fields(body, ['idempotencyKey', 'expectedRevision', 'reason', 'confirmed']);
  if (body.confirmed !== true) throw new AccountError('VALIDATION_ERROR', '请确认违规删除及其后果', 400);
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
    throw new AccountError('VALIDATION_ERROR', '内容版本无效', 400);
  return {
    idempotencyKey: key(body.idempotencyKey),
    expectedRevision: Number(body.expectedRevision),
    reason: text(body.reason, '处理原因', 1000)
  };
}
