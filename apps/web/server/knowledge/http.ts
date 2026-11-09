import { resolveRequestSource } from '../auth/request-source';
import { AccountError } from '@artzoo/domain';
import { failure, success, sessionToken, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { KnowledgeService } from './service';
export async function readKnowledgeBody(request: Request): Promise<Record<string, unknown>> {
  // JSON transport guard; binary images use their separate multipart route.
  const limit = 1024 * 1024;
  if (Number(request.headers.get('content-length')) > limit)
    throw new AccountError('VALIDATION_ERROR', '请求内容过大', 400);
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError('VALIDATION_ERROR', '请求内容不能为空', 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new AccountError('VALIDATION_ERROR', '请求内容过大', 400);
    }
    chunks.push(item.value);
  }
  let result: unknown;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AccountError('VALIDATION_ERROR', '请求JSON格式无效', 400);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new AccountError('VALIDATION_ERROR', '请求格式无效', 400);
  return result as Record<string, unknown>;
}
export async function handleKnowledge(
  request: Request,
  action:
    | 'list'
    | 'detail'
    | 'history'
    | 'restore'
    | 'remove'
    | 'categories'
    | 'comments'
    | 'remove-comment'
    | 'audits'
    | 'read'
    | 'like'
    | 'collect',
  articleId = '',
  commentId = ''
) {
  try {
    const write = request.method !== 'GET';
    let body: Record<string, unknown> = {};
    if (write) {
      validateOrigin(request);
      body = await readKnowledgeBody(request);
    }
    const token = await sessionToken(),
      auth = getAccountService();
    if (write) {
      await auth.limitWriteSource(resolveRequestSource(request), token);
      const actor = await auth.requireAccount(auth.db, token);
      await auth.rate(`knowledge-write:${actor.accountId}`, 120, 900);
    }
    const service = new KnowledgeService(auth),
      url = new URL(request.url);
    if (action === 'list')
      return success(
        write ? await service.create(body, token) : await service.list(url, token),
        write ? 201 : 200
      );
    if (action === 'detail')
      return success(
        write ? await service.edit(articleId, body, token) : await service.detail(articleId, token)
      );
    if (action === 'categories')
      return success(
        write
          ? await service.saveCategory(body, token)
          : await service.categories(token, url.searchParams.get('all') === '1')
      );
    if (action === 'read') return success(await service.read(articleId, body, token));
    if (action === 'like' || action === 'collect')
      return success(await service.interact(articleId, action, body, token));
    if (action === 'history') return success(await service.history(articleId, url, token));
    if (action === 'restore') return success(await service.restore(articleId, body, token));
    if (action === 'remove') return success(await service.remove(articleId, body, token));
    if (action === 'comments')
      return success(
        write ? await service.comment(articleId, body, token) : await service.comments(articleId, url, token)
      );
    if (action === 'remove-comment')
      return success(await service.removeComment(articleId, commentId, body, token));
    return success(await service.audits(articleId, token));
  } catch (error) {
    return failure(error, 'knowledge/http');
  }
}
