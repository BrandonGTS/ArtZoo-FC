import { errorDetail as accountErrorDetail, accountRequest } from '../account/api';
export function errorDetail(error: unknown): string {
  return accountErrorDetail(error).message;
}
export function albumRequest<T>(
  path: string,
  body?: unknown,
  options: { signal?: AbortSignal; userInitiated?: boolean } = {}
): Promise<T> {
  return accountRequest<T>(path, body === undefined ? options : { ...options, method: 'POST', body });
}
export function albumPatch<T>(
  path: string,
  body: unknown,
  options: { signal?: AbortSignal } = {}
): Promise<T> {
  return accountRequest<T>(path, { ...options, method: 'PATCH', body });
}
