'use client';

import { useApiResource } from '../shared/use-api-resource';
import { useAuthSession } from '../auth-session';

export function useActivityResource<T>(
  path: string,
  { keepPreviousData = false, userInitiated }: { keepPreviousData?: boolean; userInitiated?: boolean } = {}
) {
  const { session, loading: sessionLoading, error: sessionError } = useAuthSession();
  const owner = sessionLoading ? null : (session?.user?.id ?? null);
  const { data, dataPath, loading, error } = useApiResource<T>(path, {
    adapter: 'activity',
    owner,
    keepPreviousData,
    userInitiated
  });
  if (!owner)
    return {
      data: null,
      dataPath: null,
      loading: sessionLoading,
      error: sessionError || (sessionLoading ? null : '请登录后查看活动。')
    };
  return { data, dataPath, loading, error };
}
