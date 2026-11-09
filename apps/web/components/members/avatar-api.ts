import type { ApiResult, AvatarCrop, MemberProfile } from '@artzoo/domain';
import { AccountApiError } from '../account/api';

export async function uploadAvatar(file: File, crop: AvatarCrop, revision: number): Promise<MemberProfile> {
  const data = new FormData();
  data.set('file', file);
  data.set('crop', JSON.stringify(crop));
  data.set('revision', String(revision));
  let response: Response;
  try {
    response = await fetch('/api/me/avatar', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-ArtZoo-Request': '1' },
      body: data,
      signal: AbortSignal.timeout(60_000)
    });
  } catch {
    throw new AccountApiError({
      code: 'NETWORK_ERROR',
      message: '网络响应中断，暂时无法确认头像是否保存，请重新读取资料后检查。'
    });
  }
  let result: ApiResult<MemberProfile>;
  try {
    result = await response.json();
  } catch {
    throw new AccountApiError({
      code: 'SERVICE_UNAVAILABLE',
      message: '服务暂时无法响应，请重新读取资料后检查。'
    });
  }
  if (
    !result ||
    typeof result.ok !== 'boolean' ||
    (!result.ok && (!result.error || typeof result.error.message !== 'string'))
  ) {
    throw new AccountApiError({
      code: 'SERVICE_UNAVAILABLE',
      message: '服务返回内容异常，请重新读取资料后检查。'
    });
  }
  if (!result.ok) throw new AccountApiError(result.error);
  if (!response.ok)
    throw new AccountApiError({
      code: 'SERVICE_UNAVAILABLE',
      message: '头像保存未完成，请重新读取资料后检查。'
    });
  return result.data;
}
