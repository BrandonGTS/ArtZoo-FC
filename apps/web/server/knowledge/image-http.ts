import { withUploadSlot } from '../media/upload-gate';
import { readBoundedMultipart } from '../media/multipart';
import { resolveRequestSource } from '../auth/request-source';
import { AccountError } from '@artzoo/domain';
import { failure, success, responseHeaders, sessionToken } from '../auth/http';
import { securityPolicy } from '../auth/security';
import { getAccountService } from '../auth/runtime';
import { getKnowledgeImageService } from './image-runtime';
import { KNOWLEDGE_IMAGE_RULES, type KnowledgeImageVariant } from './images';
export function validateKnowledgeImageRequest(request: Request) {
  const max = KNOWLEDGE_IMAGE_RULES.maxBytes + 16384;
  if (
    request.headers.get('origin') !== securityPolicy(request.url).origin ||
    request.headers.get('x-artzoo-request') !== '1' ||
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    request.headers.get('content-type')?.split(';')[0]?.trim() !== 'multipart/form-data'
  )
    throw new AccountError('FORBIDDEN', '请求来源或格式无效', 403);
  const bad = (message: string): never => {
    throw new AccountError('VALIDATION_ERROR', message, 400);
  };
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > max)) bad('每张图片最多30MiB');
}
export async function readKnowledgeImageBody(request: Request) {
  validateKnowledgeImageRequest(request);
  const max = KNOWLEDGE_IMAGE_RULES.maxBytes + 16384;
  const bad = (message: string): never => {
    throw new AccountError('VALIDATION_ERROR', message, 400);
  };
  const form = await readBoundedMultipart(request, {
    maxBytes: max,
    timeoutMs: 60_000,
    emptyMessage: '请选择图片',
    oversizeMessage: '每张图片最多30MiB',
    timeoutMessage: '上传超时'
  });
  if (
    [...form.keys()].some((k) => !['file', 'batchId', 'batchIndex'].includes(k)) ||
    ['file', 'batchId', 'batchIndex'].some((k) => form.getAll(k).length !== 1)
  )
    bad('上传字段无效');
  const file = form.get('file'),
    index = form.get('batchIndex');
  if (!(file instanceof File) || !file.size || file.size > KNOWLEDGE_IMAGE_RULES.maxBytes)
    return bad('每张图片最多30MiB');
  if (typeof index !== 'string' || !/^\d$/.test(index)) bad('每次选取最多10张图片');
  return {
    body: { batchId: form.get('batchId'), batchIndex: Number(index) },
    input: Buffer.from(await file.arrayBuffer()),
    name: file.name
  };
}
export async function handleKnowledgeImage(request: Request, imageId?: string) {
  try {
    if (request.method !== 'GET') validateKnowledgeImageRequest(request);
    const token = await sessionToken(),
      auth = getAccountService();
    const actor = await auth.requireAccount(auth.db, token);
    const service = getKnowledgeImageService(auth);
    if (request.method === 'GET') {
      const variant = (new URL(request.url).searchParams.get('variant') ??
          'preview') as KnowledgeImageVariant,
        media = await service.read(imageId ?? '', variant, token);
      return new Response(new Uint8Array(media.bytes), {
        headers: {
          ...responseHeaders,
          'Cache-Control': 'private, no-store',
          'Content-Type': media.mime,
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Content-Disposition':
            variant === 'original'
              ? `attachment; filename*=UTF-8''${encodeURIComponent(media.name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`
              : 'inline'
        }
      });
    }
    await auth.checkWriteSource(resolveRequestSource(request), token);
    await auth.limitWriteParsing(resolveRequestSource(request), actor.accountId);
    return await withUploadSlot(async () => {
      const upload = await readKnowledgeImageBody(request);
      await auth.limitWriteSource(resolveRequestSource(request), token);
      const actor = await auth.requireAccount(auth.db, token);
      await auth.rate(`knowledge-image:${actor.accountId}`, 120, 900);
      return success(await service.upload(upload.body, upload.input, upload.name, token), 201);
    });
  } catch (error) {
    return failure(error, 'knowledge/image-http');
  }
}
