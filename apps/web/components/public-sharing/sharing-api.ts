'use client';
import { useEffect, useRef, useState } from 'react';
import { useApiResource } from '../shared/use-api-resource';
import type { ApiResult } from '@artzoo/domain';
import { AccountApiError, accountRequest, errorDetail } from '../account/api';

export function useSharingResource<T>(
  path: string | null,
  owner = 'public',
  keepPrevious = false,
  revalidate = true
) {
  return useApiResource<T>(path, { adapter: 'sharing', owner, keepPreviousData: keepPrevious, revalidate });
}
export type SharingCommand =
  | { kind: 'json'; method?: 'POST' | 'PATCH'; path: string; body: Record<string, unknown> }
  | { kind: 'upload'; path: string; form: FormData };
async function requestUpload<T>(
  command: Extract<SharingCommand, { kind: 'upload' }>,
  signal: AbortSignal
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(command.path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-ArtZoo-Request': '1' },
      body: command.form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    });
  } catch (failure) {
    if (signal.aborted) throw failure;
    throw new AccountApiError({ code: 'NETWORK_ERROR', message: '上传响应中断，暂时无法确认结果。' });
  }
  let result: ApiResult<T>;
  try {
    result = await response.json();
  } catch {
    throw new AccountApiError({ code: 'SERVICE_UNAVAILABLE', message: '上传响应无效。' });
  }
  if (!result || typeof result.ok !== 'boolean')
    throw new AccountApiError({ code: 'SERVICE_UNAVAILABLE', message: '上传响应无效。' });
  if (!result.ok) throw new AccountApiError(result.error);
  if (!response.ok)
    throw new AccountApiError({ code: 'SERVICE_UNAVAILABLE', message: '上传结果暂时无法确认。' });
  return result.data;
}
export function useSharingCommand<T>({
  success,
  failure,
  notify
}: {
  success(result: T, command: SharingCommand): void;
  failure?(code: string): void;
  notify?(type: 'success' | 'error', text: string): void;
}) {
  const pending = useRef(false),
    retained = useRef<SharingCommand | null>(null),
    controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [error, updateError] = useState<string | null>(null);
  function setError(message: string | null) {
    updateError(message);
    if (message) notify?.('error', message);
  }
  useEffect(() => () => controller.current?.abort(), []);
  async function submit(command?: SharingCommand) {
    if (pending.current) return;
    const frozen = retained.current ?? command;
    if (!frozen) return;
    retained.current = frozen;
    pending.current = true;
    setBusy(true);
    setError(null);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const result =
        frozen.kind === 'upload'
          ? await requestUpload<T>(frozen, abort.signal)
          : await accountRequest<T>(frozen.path, {
              method: frozen.method ?? 'POST',
              body: frozen.body,
              signal: abort.signal
            });
      if (abort.signal.aborted) return;
      success(result, frozen);
      retained.current = null;
      setUnknown(false);
      if (
        frozen.kind === 'json' &&
        ((frozen.path.startsWith('/api/activity-shares/') &&
          ['SAVE', 'FEATURE', 'UNFEATURE'].includes(String(frozen.body.action))) ||
          (frozen.path.startsWith('/api/album-photos/') && frozen.body.action === 'unfeature'))
      ) {
        window.dispatchEvent(new Event('artzoo:featured-updated'));
      }
    } catch (caught) {
      if (abort.signal.aborted) return;
      const detail = errorDetail(caught),
        uncertain = ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE', 'UNKNOWN_ERROR'].includes(detail.code);
      setUnknown(uncertain);
      setError(uncertain ? '暂时无法确认操作结果，请重试确认。' : detail.message);
      if (!uncertain) {
        retained.current = null;
        failure?.(detail.code);
      }
    } finally {
      pending.current = false;
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  return { submit, retry: () => submit(), busy, unknown, locked: busy || unknown, error, setError };
}
