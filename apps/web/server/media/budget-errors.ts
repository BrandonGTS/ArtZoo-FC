import { AccountError, MediaBudgetError } from '@artzoo/domain';

/** Preserve non-quota failure identity and the existing HTTP handler; never serialize internal quota details. */
export function mediaBudgetError(error: unknown): unknown {
  if (!(error instanceof MediaBudgetError)) return error;
  if (error.code === 'MEDIA_BUDGET_DAILY_LIMIT')
    return new AccountError('MEDIA_DAILY_LIMIT', '今日图片上传额度已用完，请明天再试。', 429);
  if (error.code === 'MEDIA_BUDGET_GLOBAL_LIMIT')
    return new AccountError('MEDIA_GLOBAL_LIMIT', '站点图片空间已满，暂时无法上传，已有图片仍可查看。', 429);
  if (error.code === 'MEDIA_BUDGET_REPLAY_CONFLICT' || error.code === 'MEDIA_BUDGET_ALLOCATION_CONFLICT')
    return new AccountError('CONFLICT', '同次上传内容或处理结果已变化，请重新选择图片。', 409);
  return new AccountError('MEDIA_BUDGET_UNAVAILABLE', '图片上传暂时不可用，请稍后再试。', 503);
}
export function mediaUploadPendingError(): AccountError {
  return new AccountError('MEDIA_UPLOAD_PENDING', '该图片正在处理或结果待确认，请稍后重试。', 503);
}
