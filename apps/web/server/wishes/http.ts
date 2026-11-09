import { withUploadSlot } from '../media/upload-gate';
import { resolveRequestSource } from '../auth/request-source';
import { failure, responseHeaders, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { AccountError } from '@artzoo/domain';
import { readPhotoBody, validatePhotoRequest } from '../daily/http';
import { WishService } from './service';
export type WishAction =
  | 'home'
  | 'interests'
  | 'list'
  | 'get'
  | 'create'
  | 'interest'
  | 'cancelInterest'
  | 'comment'
  | 'convert'
  | 'edit'
  | 'remove'
  | 'moderate'
  | 'comments'
  | 'upload'
  | 'media';
export async function handleWishes(request: Request, action: WishAction, id = '') {
  try {
    const token = await sessionToken(),
      auth = getAccountService(),
      service = new WishService(auth),
      url = new URL(request.url);
    if (action === 'media') {
      const variant = url.searchParams.get('variant') ?? 'preview',
        media = await service.media(id, variant, token);
      return new Response(new Uint8Array(media.bytes), {
        headers: {
          ...responseHeaders,
          'Content-Type': media.mime,
          'Content-Disposition': variant === 'original' ? 'attachment; filename="wish-image"' : 'inline',
          'Cross-Origin-Resource-Policy': 'same-origin'
        }
      });
    }
    if (action === 'upload') {
      validatePhotoRequest(request);
      const actor = await auth.requireAccount(auth.db, token);
      await auth.checkWriteSource(resolveRequestSource(request), token);
      await auth.limitWriteParsing(resolveRequestSource(request), actor.accountId);
      return await withUploadSlot(async () => {
        const upload = await readPhotoBody(request);
        await auth.limitWriteSource(resolveRequestSource(request), token);
        const result = await service.upload(upload.body, upload.input, upload.name, token);
        return success(result, result.replayed ? 200 : 201);
      });
    }
    const write = request.method === 'POST';
    let body: Record<string, unknown> = {};
    if (write) {
      validateOrigin(request);
      body = await readWishBody(request);
    }
    if (write) await auth.limitWriteSource(resolveRequestSource(request), token);
    if (action === 'home') return success(await service.home(url, token));
    if (action === 'interests') return success(await service.interests(id, url, token));
    if (action === 'comments') return success(await service.comments(id, url, token));
    if (action === 'list') return success(await service.list(new URL(request.url), token));
    if (action === 'get') return success(await service.get(id, new URL(request.url), token));
    if (action === 'create') {
      const result = await service.create(body, token);
      return success(result, result.replayed ? 200 : 201);
    }
    return success(await service[action](id, body, token));
  } catch (error) {
    return failure(error, 'wishes/http');
  }
}

async function readWishBody(request: Request): Promise<Record<string, unknown>> {
  const limit = 65536;
  if (Number(request.headers.get('content-length')) > limit)
    throw new AccountError('VALIDATION_ERROR', '请求内容过大', 400);
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError('VALIDATION_ERROR', '请求内容不能为空', 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new AccountError('VALIDATION_ERROR', '请求内容过大', 400);
    }
    chunks.push(next.value);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AccountError('VALIDATION_ERROR', '请求JSON格式无效', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new AccountError('VALIDATION_ERROR', '请求格式无效', 400);
  return body as Record<string, unknown>;
}
