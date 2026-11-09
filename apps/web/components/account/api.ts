import { markBackgroundRequest, withUserOperation } from '../user-operation';
import { safeAccountReturnTo, type ApiError, type ApiResult } from '@artzoo/domain';

export class AccountApiError extends Error {
  readonly detail: ApiError;
  constructor(detail: ApiError) {
    super(detail.message);
    this.detail = detail;
  }
}

type AccountRequestOptions = {
  method?: 'POST' | 'PATCH';
  body?: unknown;
  signal?: AbortSignal;
  userInitiated?: boolean;
};

export async function accountRequest<T>(path: string, options: AccountRequestOptions = {}): Promise<T> {
  const request = () => performAccountRequest<T>(path, options);
  return (options.userInitiated ?? Boolean(options.method))
    ? withUserOperation(request, { signal: options.signal })
    : request();
}

async function performAccountRequest<T>(path: string, options: AccountRequestOptions): Promise<T> {
  let response: Response;
  try {
    const init: RequestInit = {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: options.method ? { 'Content-Type': 'application/json', 'X-ArtZoo-Request': '1' } : undefined,
      body: options.method ? JSON.stringify(options.body ?? {}) : undefined,
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000)
    };
    response = await fetch(path, options.userInitiated === false ? markBackgroundRequest(init) : init);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new AccountApiError({
      code: 'NETWORK_ERROR',
      message: options.method
        ? '网络响应中断，暂时无法确认提交结果，请稍后检查。'
        : '网络连接失败，请检查网络后再操作。'
    });
  }
  let result: ApiResult<T>;
  try {
    result = await response.json();
  } catch {
    throw new AccountApiError({ code: 'SERVICE_UNAVAILABLE', message: '服务暂时无法响应，请稍后再操作。' });
  }
  if (
    !result ||
    typeof result.ok !== 'boolean' ||
    (!result.ok && (!result.error || typeof result.error.message !== 'string'))
  )
    throw new AccountApiError({ code: 'SERVICE_UNAVAILABLE', message: '服务返回内容异常，请稍后再操作。' });
  if (!result.ok) {
    const retry = Number(response.headers.get('Retry-After'));
    throw new AccountApiError({
      ...result.error,
      retryAfterSeconds: result.error.retryAfterSeconds ?? (retry > 0 ? retry : undefined)
    });
  }
  if (!response.ok)
    throw new AccountApiError({ code: 'SERVICE_UNAVAILABLE', message: '操作未完成，请稍后再操作。' });
  return result.data;
}

export function errorDetail(error: unknown): ApiError {
  return error instanceof AccountApiError
    ? error.detail
    : { code: 'UNKNOWN_ERROR', message: '操作未完成，请稍后再操作。' };
}

export function safeReturnTo(value: string): string {
  return safeAccountReturnTo(value);
}
