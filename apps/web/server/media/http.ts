import { readBoundedMultipart } from './multipart';
import { AccountError, AVATAR_RULES, profileRevision } from '@artzoo/domain';
import { securityPolicy } from '../auth/security';
import { avatarCrop } from './processor';

const MAX_BODY = AVATAR_RULES.maxBytes + 16_384;
export function validateAvatarOrigin(request: Request): void {
  if (
    request.headers.get('origin') !== securityPolicy(request.url).origin ||
    request.headers.get('x-artzoo-request') !== '1' ||
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'multipart/form-data'
  ) {
    throw new AccountError('FORBIDDEN', '请求来源或格式无效', 403);
  }
}
export async function readAvatarBody(request: Request) {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY))
    throw new AccountError('VALIDATION_ERROR', '请求内容过大', 400);
  const form = await readBoundedMultipart(request, {
    maxBytes: MAX_BODY,
    timeoutMs: 15_000,
    emptyMessage: '请选择图片',
    oversizeMessage: '请求内容过大',
    timeoutMessage: '上传超时，请重新选择图片'
  });
  if (
    [...form.keys()].some((key) => !['file', 'crop', 'revision'].includes(key)) ||
    ['file', 'crop', 'revision'].some((key) => form.getAll(key).length !== 1)
  )
    throw new AccountError('VALIDATION_ERROR', '上传字段无效', 400);
  const file = form.get('file'),
    rawCrop = form.get('crop'),
    rawRevision = form.get('revision');
  if (!(file instanceof File) || file.size === 0 || file.size > AVATAR_RULES.maxBytes)
    throw new AccountError('VALIDATION_ERROR', '图片大小需在 10 MB 以内', 400);
  if (
    typeof rawCrop !== 'string' ||
    rawCrop.length > 256 ||
    typeof rawRevision !== 'string' ||
    !/^\d{1,10}$/.test(rawRevision)
  )
    throw new AccountError('VALIDATION_ERROR', '裁剪或资料版本无效', 400);
  let crop: unknown;
  try {
    crop = JSON.parse(rawCrop);
  } catch {
    throw new AccountError('VALIDATION_ERROR', '裁剪参数无效', 400);
  }
  return {
    input: Buffer.from(await file.arrayBuffer()),
    crop: avatarCrop(crop),
    revision: profileRevision(Number(rawRevision))
  };
}
