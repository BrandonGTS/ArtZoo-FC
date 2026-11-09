'use client';

import { useApiResource } from '../shared/use-api-resource';

export function useResource<T>(path: string) {
  return useApiResource<T>(path, { adapter: 'account' });
}
