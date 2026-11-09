import { withUploadSlot } from '../media/upload-gate';
import { readBoundedMultipart } from '../media/multipart';
import { resolveRequestSource } from '../auth/request-source';
import { AccountError } from '@artzoo/domain';
import { validateAvatarOrigin } from '../media/http';
import { quickCommand, quickInvalid } from './contract';
import { MANUAL_ICON_MAX_BYTES, type ManualIconFile } from './manual-icon';
import type { QuickLinkService } from './service';

const MAX_BODY = MANUAL_ICON_MAX_BYTES + 16_384;
function validateQuickIconSize(request: Request) {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) quickInvalid('请求内容过大');
}
export async function readQuickIconBody(
  request: Request
): Promise<{ command: Record<string, unknown>; file: ManualIconFile }> {
  validateQuickIconSize(request);
  const form = await readBoundedMultipart(request, {
    maxBytes: MAX_BODY,
    timeoutMs: 15_000,
    emptyMessage: '请选择图片',
    oversizeMessage: '请求内容过大',
    timeoutMessage: '上传超时，请重新选择图片'
  });
  if (
    [...form.keys()].some((key) => !['command', 'file'].includes(key)) ||
    ['command', 'file'].some((key) => form.getAll(key).length !== 1)
  )
    quickInvalid('上传字段无效');
  const raw = form.get('command'),
    file = form.get('file');
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 8192) quickInvalid('操作参数无效或过大');
  if (!(file instanceof File) || !file.size || file.size > MANUAL_ICON_MAX_BYTES)
    quickInvalid('图片大小需在 2 MB 以内');
  let command: unknown;
  try {
    command = JSON.parse(raw);
  } catch {
    return quickInvalid('请求JSON格式无效');
  }
  if (!command || typeof command !== 'object' || Array.isArray(command)) quickInvalid('请求格式无效');
  const body = command as Record<string, unknown>;
  if (quickCommand(body).action !== 'update') quickInvalid('手动图标仅支持修改现有快捷入口');
  return {
    command: body,
    file: { input: Buffer.from(await file.arrayBuffer()), name: file.name, type: file.type }
  };
}
// The adapter and service both authorize. Body bytes and decoding are unavailable
// to unauthenticated callers; the service still verifies again after all locks.
export async function submitQuickIconUpload(
  request: Request,
  service: QuickLinkService,
  token?: string | null
) {
  if (request.method !== 'POST') throw new AccountError('NOT_FOUND', '接口不存在', 404);
  validateAvatarOrigin(request);
  validateQuickIconSize(request);
  await service.authorizeIconUpload(token);
  const actor = await service.auth.requireAccount(service.auth.db, token);
  await service.auth.checkWriteSource(resolveRequestSource(request), token);
  await service.auth.limitWriteParsing(resolveRequestSource(request), actor.accountId);
  return withUploadSlot(async () => {
    const parsed = await readQuickIconBody(request);
    await service.auth.limitWriteSource(resolveRequestSource(request), token);
    return service.mutateWithIcon(parsed.command, token, parsed.file);
  }, '图标处理繁忙，请稍后再试');
}
export async function handleQuickIconUpload(request: Request) {
  const { failure, sessionToken, success } = await import('../auth/http');
  try {
    // Reject source/method before obtaining a database service or cookie.
    if (request.method !== 'POST') throw new AccountError('NOT_FOUND', '接口不存在', 404);
    validateAvatarOrigin(request);
    validateQuickIconSize(request);
    const { getAccountService } = await import('../auth/runtime');
    const { QuickLinkService } = await import('./service');
    return success(
      await submitQuickIconUpload(request, new QuickLinkService(getAccountService()), await sessionToken())
    );
  } catch (error) {
    return failure(error, 'quick-links/upload-http');
  }
}
