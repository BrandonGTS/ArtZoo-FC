'use client';
import { useApiResource } from '../shared/use-api-resource';
import { albumRequest, errorDetail } from './api';

function loadAlbum<T>(path: string, options: { signal: AbortSignal; userInitiated: boolean }) {
  return albumRequest<T>(path, undefined, options);
}

export function useAlbumResource<T>(url: string | null, keepPrevious = false) {
  return useApiResource<T>(url, {
    adapter: 'album',
    load: loadAlbum,
    errorDetail,
    keepPreviousData: keepPrevious
  });
}
