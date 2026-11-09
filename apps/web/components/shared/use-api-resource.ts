'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { accountRequest, errorDetail } from '../account/api';
import type { NumberedPageResult } from '@artzoo/domain';

type ResourceOptions = {
  // Explicit adapters preserve their existing contracts; unowned reads are not session-gated.
  adapter: 'account' | 'activity' | 'official';
  owner?: string | null;
  keepPreviousData?: boolean;
  userInitiated?: boolean;
};
type CatalogOptions<Raw, T> = {
  adapter: 'catalog';
  load: (key: string, options: { signal: AbortSignal }) => Promise<Raw>;
  select: (value: Raw) => T;
  failureData: (previous: T | null) => T;
  owner?: never;
  keepPreviousData?: never;
  userInitiated?: never;
};
type AlbumOptions<T> = {
  adapter: 'album';
  load: (path: string, options: { signal: AbortSignal; userInitiated: boolean }) => Promise<T>;
  errorDetail: (error: unknown) => string;
  keepPreviousData?: boolean;
  owner?: never;
  userInitiated?: never;
};
type SharingOptions = {
  adapter: 'sharing';
  owner: string;
  keepPreviousData?: boolean;
  revalidate?: boolean;
  userInitiated?: never;
};
type CatalogResource<T> = { key: string; data: T; error: string | undefined; loading: boolean };
type Snapshot<T> = {
  owner: string | null;
  path: string | null;
  dataPath: string | null;
  data: T | null;
  loading: boolean;
  error: string | null;
  errorCode?: string | null;
};

type AccountResource<T> = { path: string; data: T | null; loading: boolean; error: string | null };
type ActivityResource<T> = AccountResource<T> & { dataPath: string | null };
export function useApiResource<T>(
  path: string,
  options: ResourceOptions & { adapter: 'account' }
): AccountResource<T>;
export function useApiResource<T>(
  path: string,
  options: ResourceOptions & { adapter: 'activity' }
): ActivityResource<T>;
export function useApiResource<T>(
  path: string | null,
  options: ResourceOptions & { adapter: 'official' }
): { data: T | null; error: string | null; loading: boolean };
export function useApiResource<Raw, T>(
  path: string,
  options: CatalogOptions<Raw, T>
): CatalogResource<T> | undefined;
export function useApiResource<T>(
  path: string | null,
  options: AlbumOptions<T>
): { data: T | undefined; error: string | undefined; loading: boolean };
export function useApiResource<T>(
  path: string | null,
  options: SharingOptions
): { data: T | null; error: string | null; errorCode: string | null; loading: boolean };
export function useApiResource<T, Raw = T>(
  path: string | null,
  options: ResourceOptions | CatalogOptions<Raw, T> | AlbumOptions<T> | SharingOptions
) {
  if (!['account', 'activity', 'official', 'catalog', 'album', 'sharing'].includes(options.adapter))
    throw new Error('Unknown API resource adapter');
  const { adapter, owner: requestedOwner = null, keepPreviousData = false, userInitiated } = options;
  const load = options.adapter === 'catalog' ? options.load : undefined;
  const select = options.adapter === 'catalog' ? options.select : undefined;
  const failureData = options.adapter === 'catalog' ? options.failureData : undefined;
  const albumLoad = options.adapter === 'album' ? options.load : undefined;
  const albumErrorDetail = options.adapter === 'album' ? options.errorDetail : undefined;
  const owner = adapter === 'activity' || adapter === 'sharing' ? requestedOwner : null;
  const revalidate = options.adapter === 'sharing' ? (options.revalidate ?? true) : true;
  const activation = useRef(revalidate),
    activeRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    if (adapter !== 'sharing') return;
    activation.current = revalidate;
    if (!revalidate) activeRequest.current?.abort();
  }, [adapter, revalidate]);
  const previousRequest = useRef<{ owner: string | null; path: string } | null>(null);
  const [state, setState] = useState<Snapshot<T>>({
    owner,
    path: adapter === 'account' ? path : null,
    dataPath: null,
    data: null,
    loading: true,
    error: null
  });
  // Account callers historically receive the stored snapshot object unchanged
  // on unrelated renders (including A -> pending B -> A before B completes).
  const accountSnapshot = useMemo(
    () => ({ path: state.path ?? '', data: state.data, loading: state.loading, error: state.error }),
    [state]
  );
  // Preserve immediate owner isolation, including the render before effect cleanup.
  if (adapter !== 'sharing' && state.owner !== owner)
    setState({ owner, path: null, dataPath: null, data: null, loading: true, error: null });
  useEffect(() => {
    if (
      (adapter === 'activity' && !owner) ||
      ((adapter === 'official' || adapter === 'album' || adapter === 'sharing') && !path)
    )
      return;
    const controller = adapter === 'sharing' ? null : new AbortController();
    if (adapter === 'catalog' || adapter === 'album') {
      // Keep the original Promise.all -> then -> catch chain: abort before projection,
      // and route a throwing success projection through the same failure updater.
      const albumUserInitiated = previousRequest.current !== null && previousRequest.current.path !== path;
      if (adapter === 'album') previousRequest.current = { owner, path: path! };
      const request =
        adapter === 'album'
          ? albumLoad!(path!, { signal: controller!.signal, userInitiated: albumUserInitiated })
          : load!(path!, { signal: controller!.signal });
      request
        .then((value) => {
          if (!controller!.signal.aborted) {
            const data = adapter === 'album' ? (value as T) : select!(value as Raw);
            setState({ owner, path, dataPath: path, data, loading: false, error: null });
          }
        })
        .catch((failure) => {
          if (!controller!.signal.aborted) {
            if (adapter === 'album')
              setState({
                owner,
                path,
                dataPath: path,
                data: null,
                loading: false,
                error: albumErrorDetail!(failure)
              });
            else
              setState((previous) => ({
                owner,
                path,
                dataPath: path,
                data: failureData!(previous.data),
                loading: false,
                error: errorDetail(failure).message
              }));
          }
        });
      return () => controller!.abort();
    }
    const changedByUser = previousRequest.current?.owner === owner && previousRequest.current?.path !== path;
    if (owner || adapter === 'sharing') previousRequest.current = { owner, path: path! };
    let sharingController: AbortController | null = null,
      timer: ReturnType<typeof setTimeout> | null = null;
    let version = 0,
      disposed = false;
    function refresh(sharingUserInitiated = false) {
      if (adapter === 'sharing') sharingController?.abort();
      const request = adapter === 'sharing' ? new AbortController() : controller!;
      if (adapter === 'sharing') {
        sharingController = request;
        activeRequest.current = request;
      }
      const requestVersion = ++version;
      const options =
        adapter === 'account' || adapter === 'official'
          ? { signal: request.signal }
          : {
              signal: request.signal,
              userInitiated: adapter === 'sharing' ? sharingUserInitiated : (userInitiated ?? changedByUser)
            };
      const current = () =>
        !request.signal.aborted && (adapter !== 'sharing' || (!disposed && requestVersion === version));
      accountRequest<T>(path!, options).then(
        (data) => {
          if (current())
            setState({
              owner,
              path,
              dataPath: path,
              data,
              loading: false,
              error: null,
              ...(adapter === 'sharing' ? { errorCode: null } : {})
            });
        },
        (failure) => {
          if (!current()) return;
          if (adapter === 'sharing') {
            const detail = errorDetail(failure);
            const transient = ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE', 'UNKNOWN_ERROR'].includes(detail.code);
            setState((previous) => ({
              owner,
              path,
              dataPath: path,
              data: transient && previous.owner === owner && previous.path === path ? previous.data : null,
              loading: false,
              error: detail.message,
              errorCode: detail.code
            }));
          } else
            setState((previous) => ({
              owner,
              path,
              dataPath: adapter === 'activity' && previous.owner === owner ? previous.dataPath : null,
              data: adapter === 'activity' && previous.owner === owner ? previous.data : null,
              loading: false,
              error: errorDetail(failure).message
            }));
        }
      );
    }
    refresh(adapter === 'sharing' ? changedByUser : false);
    function reactivate() {
      if (!activation.current || document.visibilityState !== 'visible') return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (activation.current) refresh();
      }, 50);
    }
    if (adapter === 'sharing') {
      window.addEventListener('focus', reactivate);
      window.addEventListener('artzoo:featured-updated', reactivate);
      document.addEventListener('visibilitychange', reactivate);
    }
    return () => {
      disposed = true;
      (sharingController ?? controller)?.abort();
      if (timer !== null) clearTimeout(timer);
      if (adapter === 'sharing') {
        window.removeEventListener('focus', reactivate);
        window.removeEventListener('artzoo:featured-updated', reactivate);
        document.removeEventListener('visibilitychange', reactivate);
      }
    };
  }, [adapter, owner, path, userInitiated, load, select, failureData, albumLoad, albumErrorDetail]);

  if (adapter === 'sharing') {
    const owned = state.owner === owner ? state : null;
    const current = owned?.path === path ? owned : null;
    const snapshot =
      current ?? (keepPreviousData && owned?.path?.split('?')[0] === path?.split('?')[0] ? owned : null);
    return {
      data: snapshot?.data ?? null,
      loading: Boolean(path && !current),
      error: current?.error ?? null,
      errorCode: current?.errorCode ?? null
    };
  }

  if (adapter === 'album') {
    const current = state.path === path;
    // Album success values (including null/undefined) are never normalized.
    // Its keepPrevious projection also remains active while the URL is disabled.
    const data = state.path !== null && state.error === null ? state.data! : undefined;
    return {
      data: current || keepPreviousData ? data : undefined,
      error: current ? (state.error ?? undefined) : undefined,
      loading: Boolean(path && !current)
    };
  }

  if (adapter === 'catalog') {
    if (state.path === null) return undefined;
    const current = state.path === path;
    return {
      key: state.path,
      data: state.data!,
      error: current ? (state.error ?? undefined) : undefined,
      loading: !current
    };
  }

  if (adapter === 'account') {
    return state.path === path ? accountSnapshot : { path, data: null, loading: true, error: null };
  }
  if (adapter === 'official') {
    const current = state.path === path ? state : null;
    const snapshot = current ?? (keepPreviousData && path ? state : null);
    return {
      data: snapshot?.data ?? null,
      error: current?.error ?? null,
      loading: Boolean(path && !current)
    };
  }
  const owned = state.owner === owner ? state : null;
  const current = owned?.path === path ? owned : null;
  const snapshot = keepPreviousData ? owned : current?.dataPath === path ? current : null;
  return {
    path,
    data: snapshot?.data ?? null,
    dataPath: snapshot?.dataPath ?? null,
    loading: !current,
    error: current?.error ?? null
  };
}

// Management numbered reads retain their original independent lifecycle and paired handlers.
export function useManagementPageResource<T>(
  path: string,
  requestedPage: number,
  pageSize: number,
  key: string
) {
  const [state, setState] = useState<
    NumberedPageResult<T> & { key: string; path: string; loading: boolean; error: string | null }
  >({
    key,
    path,
    items: [],
    page: requestedPage,
    pageSize,
    total: 0,
    loading: true,
    error: null
  });
  useEffect(() => {
    const controller = new AbortController();
    const separator = path.includes('?') ? '&' : '?';
    accountRequest<NumberedPageResult<T>>(`${path}${separator}page=${requestedPage}&pageSize=${pageSize}`, {
      signal: controller.signal
    }).then(
      (data) => {
        if (!controller.signal.aborted) setState({ ...data, key, path, loading: false, error: null });
      },
      (error) => {
        if (!controller.signal.aborted)
          setState({
            key,
            path,
            items: [],
            page: requestedPage,
            pageSize,
            total: 0,
            loading: false,
            error: errorDetail(error).message
          });
      }
    );
    return () => controller.abort();
  }, [key, path, requestedPage, pageSize]);
  return state;
}

// The caller owns scheduling. Opening and disposing a read epoch never starts a request.
export function useControlledApiRead<T>(path: string, owner: string | null) {
  const [snapshot, setSnapshot] = useState<{
      owner: string;
      path: string;
      data: T;
      received: number;
    } | null>(null),
    [error, setError] = useState<{ owner: string; path: string; message: string } | null>(null);
  const open = useMemo(
    () => () => {
      if (!owner) throw new Error('Controlled API read requires an owner');
      const controller = new AbortController();
      let active = true;
      return {
        async read(settled: () => void) {
          try {
            const data = await accountRequest<T>(path, { signal: controller.signal });
            if (active) {
              setSnapshot({ owner, path, data, received: performance.now() });
              setError(null);
            }
          } catch (failure) {
            if (active && !controller.signal.aborted)
              setError({ owner, path, message: errorDetail(failure).message });
          } finally {
            settled();
          }
        },
        dispose() {
          active = false;
          controller.abort();
        }
      };
    },
    [owner, path]
  );
  return {
    snapshot: snapshot?.owner === owner && snapshot.path === path ? snapshot : null,
    error: error?.owner === owner && error.path === path ? error.message : null,
    open
  };
}
