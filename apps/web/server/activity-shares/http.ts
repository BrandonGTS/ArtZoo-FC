import { withUploadSlot } from '../media/upload-gate';
import { resolveRequestSource } from '../auth/request-source';
import { failure, responseHeaders, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { AccountError } from '@artzoo/domain';
import { readPhotoBody, validatePhotoRequest } from '../albums/http';
import { ActivityShareService } from './service';
import { activityShareMediaBudget } from './media-budget-runtime';
// Maximum valid share payload (including 100 UUIDs and UTF-8 text) fits within 16 KiB.
// Keep the account/authentication endpoint's existing 8 KiB default unchanged.
async function readShareBody(request: Request): Promise<Record<string, unknown>> {
  const max = 16 * 1024;
  if (Number(request.headers.get('content-length')) > max)
    throw new AccountError('VALIDATION_ERROR', '请求内容过大', 400);
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError('VALIDATION_ERROR', '请求内容不能为空', 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > max) {
        await reader.cancel();
        throw new AccountError('VALIDATION_ERROR', '请求内容过大', 400);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new AccountError('VALIDATION_ERROR', '请求JSON格式无效', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AccountError('VALIDATION_ERROR', '请求格式无效', 400);
  return value as Record<string, unknown>;
}
export async function handleActivityShares(
  request: Request,
  action: 'list' | 'get' | 'mutate' | 'create' | 'for-activity' | 'upload' | 'media' | 'info',
  id = ''
) {
  try {
    const token = await sessionToken(),
      auth = getAccountService(),
      service = new ActivityShareService(
        auth,
        undefined,
        action === 'upload' ? await activityShareMediaBudget(auth) : null
      ),
      url = new URL(request.url);
    if (action === 'media') {
      const result = await service.media(id, url.searchParams.get('variant') ?? 'preview', token);
      return new Response(new Uint8Array(result.bytes), {
        headers: {
          ...responseHeaders,
          'Content-Type': result.mime,
          'Content-Disposition': url.searchParams.get('variant') === 'original' ? 'attachment' : 'inline',
          'Cross-Origin-Resource-Policy': 'same-origin'
        }
      });
    }
    if (action === 'info') return success(await service.publicInfo(token));
    if (action === 'upload') {
      validatePhotoRequest(request);
      const actor = await auth.requireAccount(auth.db, token, true);
      await auth.checkWriteSource(resolveRequestSource(request), token);
      await auth.limitWriteParsing(resolveRequestSource(request), actor.accountId);
      return await withUploadSlot(async () => {
        const file = await readPhotoBody(request);
        if (file.body.periodActivityId !== null)
          throw new AccountError('VALIDATION_ERROR', '上传字段无效', 400);
        await auth.limitWriteSource(resolveRequestSource(request), token);
        return success(await service.upload(id, file.body, file.input, file.name, token), 201);
      });
    }
    let body: Record<string, unknown> = {};
    if (request.method !== 'GET') {
      validateOrigin(request);
      body = await readShareBody(request);
      await auth.requireAccount(auth.db, token, true);
      await auth.limitWriteSource(resolveRequestSource(request), token);
    }
    if (action === 'create') return success(await service.create(body, token), 201);
    if (action === 'mutate') return success(await service.mutate(id, body, token));
    if (action === 'for-activity') return success(await service.forActivity(id, url, token));
    if (action === 'get') return success(await service.get(id, url, token));
    return success(await service.list(url, token));
  } catch (error) {
    return failure(error, 'activity-shares/http');
  }
}
