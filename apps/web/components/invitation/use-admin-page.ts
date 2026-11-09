'use client';
import { useCallback, useState } from 'react';
import { useManagementPageResource } from '../shared/use-api-resource';

export function useAdminPage<T>(path: string, pageSize = 10) {
  const [requestedPage, setRequestedPage] = useState(1);
  const [version, setVersion] = useState(0);
  const key = `${path}#${requestedPage}#${pageSize}#${version}`;
  const state = useManagementPageResource<T>(path, requestedPage, pageSize, key);
  const changePage = useCallback((page: number) => {
    setRequestedPage(page);
    setVersion((value) => value + 1);
  }, []);
  const reload = useCallback(() => {
    setRequestedPage(1);
    setVersion((value) => value + 1);
  }, []);
  const current =
    state.key === key
      ? state
      : {
          key,
          path,
          items: [],
          page: requestedPage,
          pageSize,
          total: state.path === path ? state.total : 0,
          loading: true,
          error: null
        };
  return { ...current, changePage, reload };
}
