import { withUploadSlot } from '../media/upload-gate';
import { readBoundedMultipart } from '../media/multipart';
import { resolveRequestSource } from '../auth/request-source';
import { AccountError } from '@artzoo/domain';
import { failure, responseHeaders, sessionToken, success, validateOrigin } from '../auth/http';
import { readActivityBody } from '../activities/http';
import { getAccountService } from '../auth/runtime';
import { securityPolicy } from '../auth/security';
import { PHOTO_RULES } from '../media/photo-contract';
import { DailyService } from './service';
import { dailyMediaBudget } from './media-budget-runtime';
import { bad, id } from './contract';
export function validatePhotoRequest(request: Request) {
  const max = PHOTO_RULES.maxBytes + 16384;
  if (
    request.headers.get('origin') !== securityPolicy(request.url).origin ||
    request.headers.get('x-artzoo-request') !== '1' ||
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    request.headers.get('content-type')?.split(';')[0]?.trim() !== 'multipart/form-data'
  )
    throw new AccountError('FORBIDDEN', '请求来源或格式无效', 403);
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > max)) bad('请求内容过大');
}
export async function readPhotoBody(request: Request) {
  validatePhotoRequest(request);
  const max = PHOTO_RULES.maxBytes + 16384;
  const form = await readBoundedMultipart(request, {
    maxBytes: max,
    timeoutMs: 60_000,
    emptyMessage: '请选择图片',
    oversizeMessage: '每张图片最多30MiB',
    timeoutMessage: '上传超时，请再次上传'
  });
  if (
    [...form.keys()].some((k) => !['file', 'batchId', 'batchIndex'].includes(k)) ||
    ['file', 'batchId', 'batchIndex'].some((k) => form.getAll(k).length !== 1)
  )
    bad('上传字段无效');
  const file = form.get('file'),
    index = form.get('batchIndex');
  if (!(file instanceof File) || !file.size || file.size > PHOTO_RULES.maxBytes) bad('每张图片最多30MiB');
  if (typeof index !== 'string' || !/^[0-9]$/.test(index)) bad('每批最多10张图片');
  return {
    input: Buffer.from(await file.arrayBuffer()),
    name: file.name,
    body: { batchId: form.get('batchId'), batchIndex: Number(index) }
  };
}

export async function handleDaily(request: Request, action: string, rawId = '') {
  try {
    const token = await sessionToken(),
      auth = getAccountService(),
      service = new DailyService(auth, undefined, action === 'upload' ? await dailyMediaBudget(auth) : null),
      url = new URL(request.url),
      key = rawId ? id(rawId) : '';
    if (action === 'media') {
      const variant = url.searchParams.get('variant') ?? 'preview',
        media = await service.media(key, variant, token);
      return new Response(new Uint8Array(media.bytes), {
        headers: {
          ...responseHeaders,
          'Content-Type': media.mime,
          'Content-Disposition': variant === 'original' ? 'attachment; filename="daily-image"' : 'inline',
          'Cross-Origin-Resource-Policy': 'same-origin'
        }
      });
    }
    const write = request.method !== 'GET';
    if (action === 'upload') {
      validatePhotoRequest(request);
      const actor = await auth.requireAccount(auth.db, token);
      await auth.checkWriteSource(resolveRequestSource(request), token);
      await auth.limitWriteParsing(resolveRequestSource(request), actor.accountId);
      return await withUploadSlot(async () => {
        const upload = await readPhotoBody(request);
        await auth.limitWriteSource(resolveRequestSource(request), token);
        return success(await service.upload(upload.body, upload.input, upload.name, token), 201);
      });
    }
    let body: Record<string, unknown> = {};
    if (write) {
      validateOrigin(request);
      const actor = await auth.requireAccount(auth.db, token);
      await auth.checkWriteSource(resolveRequestSource(request), token);
      await auth.limitWriteParsing(resolveRequestSource(request), actor.accountId);
      body = await readActivityBody(request);
      await auth.limitWriteSource(resolveRequestSource(request), token);
    }
    if (action === 'list')
      return success(write ? await service.create(body, token) : await service.list(url, token));
    if (action === 'detail')
      return success(write ? await service.update(key, body, token) : await service.get(key, token));
    if (action === 'comments')
      return success(write ? await service.comment(key, body, token) : await service.comments(key, token));
    if (action === 'audit') return success(await service.audits(key, token));
    if (action === 'notifications') return success(await service.notifications(token));
    if (action === 'like' || action === 'remove' || action === 'removeComment' || action === 'moderate')
      return success(await service[action](key, body, token));
    bad('接口不存在');
  } catch (error) {
    return failure(error, 'daily/http');
  }
}
