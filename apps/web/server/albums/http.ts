import { withUploadSlot } from '../media/upload-gate';
import { readBoundedMultipart } from '../media/multipart';
import { resolveRequestSource } from '../auth/request-source';
import { AccountError } from '@artzoo/domain';
import { failure, readBody, responseHeaders, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { securityPolicy } from '../auth/security';
import { AlbumService } from './service';
import { readPhotoCommandBody } from './command-body';
import { ALBUM_RULES, bad } from './contract';
import type { PhotoVariant } from './storage';
export function validatePhotoRequest(request: Request) {
  const max = ALBUM_RULES.maxBytes + 16384;
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
  const max = ALBUM_RULES.maxBytes + 16384;
  const form = await readBoundedMultipart(request, {
    maxBytes: max,
    timeoutMs: 60_000,
    emptyMessage: '请选择图片',
    oversizeMessage: '每张图片最多30MiB',
    timeoutMessage: '上传超时，请再次上传'
  });
  if (
    [...form.keys()].some((k) => !['file', 'batchId', 'batchIndex', 'periodActivityId'].includes(k)) ||
    ['file', 'batchId', 'batchIndex'].some((k) => form.getAll(k).length !== 1) ||
    form.getAll('periodActivityId').length > 1
  )
    bad('上传字段无效');
  const file = form.get('file'),
    index = form.get('batchIndex');
  if (!(file instanceof File) || !file.size || file.size > ALBUM_RULES.maxBytes) bad('每张图片最多30MiB');
  if (typeof index !== 'string' || !/^[0-9]$/.test(index)) bad('每批最多10张图片');
  return {
    input: Buffer.from(await file.arrayBuffer()),
    name: file.name,
    body: {
      batchId: form.get('batchId'),
      batchIndex: Number(index),
      periodActivityId: form.get('periodActivityId')
    }
  };
}
export async function handleAlbums(request: Request, action: string, id = '') {
  try {
    const token = await sessionToken(),
      auth = getAccountService(),
      service = new AlbumService(auth),
      url = new URL(request.url);
    if (action === 'media') {
      const media = await service.readMedia(
        id,
        (url.searchParams.get('variant') ?? 'preview') as PhotoVariant,
        token
      );
      return new Response(new Uint8Array(media.bytes), {
        headers: {
          ...responseHeaders,
          'Content-Type': media.mime,
          'Content-Disposition':
            url.searchParams.get('variant') === 'original'
              ? `attachment; filename*=UTF-8''${encodeURIComponent(media.filename).replace(/['()*]/g, (x) => '%' + x.charCodeAt(0).toString(16))}`
              : 'inline',
          'Cross-Origin-Resource-Policy': 'same-origin'
        }
      });
    }
    if (action === 'comment-media') {
      const media = await service.commentMedia(
        id,
        url.pathname.split('/').at(-1)!,
        (url.searchParams.get('variant') ?? 'preview') as PhotoVariant,
        token
      );
      return new Response(new Uint8Array(media.bytes), {
        headers: {
          ...responseHeaders,
          'Content-Type': media.mime,
          'Content-Disposition':
            url.searchParams.get('variant') === 'original'
              ? 'attachment; filename="comment-image"'
              : 'inline',
          'Cross-Origin-Resource-Policy': 'same-origin'
        }
      });
    }
    const write = request.method !== 'GET';
    if (action === 'upload' || action === 'comment-upload') {
      validatePhotoRequest(request);
      const actor = await auth.requireAccount(auth.db, token);
      await auth.checkWriteSource(resolveRequestSource(request), token);
      await auth.limitWriteParsing(resolveRequestSource(request), actor.accountId);
      return withUploadSlot(async () => {
        const upload = await readPhotoBody(request);
        await auth.limitWriteSource(resolveRequestSource(request), token);
        return success(
          await (action === 'upload'
            ? service.upload(id, upload.body, upload.input, upload.name, token)
            : service.uploadCommentMedia(id, upload.body, upload.input, upload.name, token)),
          201
        );
      }).catch((error) => failure(error, 'albums/http'));
    }
    let body: Record<string, unknown> = {};
    if (write) {
      validateOrigin(request);
      const actor = await auth.requireAccount(auth.db, token);
      await auth.checkWriteSource(resolveRequestSource(request), token);
      await auth.limitWriteParsing(resolveRequestSource(request), actor.accountId);
      body = await (action === 'photos' ? readPhotoCommandBody(request) : readBody(request));
      await auth.limitWriteSource(resolveRequestSource(request), token);
    }
    if (action === 'categories')
      return success(
        write
          ? await service.saveCategory(body, token)
          : await service.categories(token, url.searchParams.get('all') === '1')
      );
    if (action === 'list')
      return success(write ? await service.create(body, token) : await service.list(url, token));
    if (action === 'for-activity') return success(await service.forActivity(id, token));
    if (action === 'detail')
      return success(
        write ? await service.update(id, body, token, request.signal) : await service.detail(id, token)
      );
    if (action === 'member-photos') return success(await service.memberPhotos(id, url, token));
    if (action === 'photo-detail') return success(await service.photoDetail(id, token));
    if (action === 'photos')
      return success(
        write
          ? await service.mutatePhotos(id, body, token, request.signal)
          : await service.photos(id, url, token)
      );
    if (action === 'move-targets') return success(await service.moveTargets(id, url, token));
    if (action === 'viewer-photos') return success(await service.viewerPhotos(id, url, token));
    if (action === 'photo') return success(await service.updatePhoto(id, body, token, request.signal));
    if (action === 'like') return success(await service.like(id, body, token));
    if (action === 'comments')
      return success(write ? await service.comment(id, body, token) : await service.comments(id, url, token));
    if (action === 'comment') return success(await service.removeComment(id, body, token));
    if (action === 'featured')
      return success(await service.featured(url, token, url.searchParams.get('manage') === '1'));
    if (action === 'audit') return success(await service.audits(id, token));
    if (action === 'notifications') return success(await service.notifications(token));
    bad('接口不存在');
  } catch (error) {
    return failure(error, 'albums/http');
  }
}
