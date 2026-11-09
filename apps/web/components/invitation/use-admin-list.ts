'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageResult } from '@artzoo/domain';
import { accountRequest, errorDetail } from '../account/api';

export function useAdminList<T>(path: string, enabled = true) {
  const [version, setVersion] = useState(0);
  const key = `${path}#${version}#${enabled}`;
  const [state, setState] = useState<{
    key: string;
    items: T[];
    nextCursor: string | null;
    loading: boolean;
    error: string | null;
  }>({ key, items: [], nextCursor: null, loading: enabled, error: null });
  const currentController = useRef<AbortController | null>(null);
  const moreLock = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    currentController.current = controller;
    accountRequest<PageResult<T>>(path, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setState({ key, ...data, loading: false, error: null });
      },
      (error) => {
        if (!controller.signal.aborted)
          setState({ key, items: [], nextCursor: null, loading: false, error: errorDetail(error).message });
      }
    );
    return () => controller.abort();
  }, [enabled, key, path]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  async function more() {
    if (!enabled || moreLock.current || state.key !== key || !state.nextCursor) return;
    moreLock.current = true;
    const controller = currentController.current;
    setState((value) => ({ ...value, loading: true, error: null }));
    try {
      const data = await accountRequest<PageResult<T>>(
        `${path}&cursor=${encodeURIComponent(state.nextCursor)}`,
        { signal: controller?.signal }
      );
      if (!controller?.signal.aborted)
        setState((value) => ({
          ...value,
          items: [...value.items, ...data.items],
          nextCursor: data.nextCursor,
          loading: false
        }));
    } catch (error) {
      const detail = errorDetail(error);
      if (!controller?.signal.aborted)
        setState((value) => ({
          ...value,
          ...(detail.code === 'UNAUTHENTICATED' || detail.code === 'FORBIDDEN'
            ? { items: [], nextCursor: null }
            : {}),
          loading: false,
          error: detail.message
        }));
    } finally {
      moreLock.current = false;
    }
  }
  const current =
    enabled && state.key === key
      ? state
      : { key, items: [], nextCursor: null, loading: enabled, error: null };
  return { ...current, reload, more };
}
export function beijingTime(value: string | null) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date(value))
    : '—';
}
