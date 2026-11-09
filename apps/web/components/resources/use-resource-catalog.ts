'use client';
import { accountRequest } from '../account/api';
import { useApiResource } from '../shared/use-api-resource';
import type { ResourceCategory, ResourceView } from '../../server/resources/contract';
type CatalogPair = [{ items: ResourceView[] }, { items: ResourceCategory[] }];
type CatalogData = { items: ResourceView[]; categories: ResourceCategory[] };
function loadCatalog(key: string, { signal }: { signal: AbortSignal }): Promise<CatalogPair> {
  return Promise.all([
    accountRequest<{ items: ResourceView[] }>('/api/resources?' + key, { signal }),
    accountRequest<{ items: ResourceCategory[] }>('/api/resources/categories', { signal })
  ]);
}
const selectCatalog = ([resources, categories]: CatalogPair): CatalogData => ({
  items: resources.items,
  categories: categories.items
});
const failureCatalog = (previous: CatalogData | null): CatalogData => ({
  items: [],
  categories: previous?.categories ?? []
});
export function useResourceCatalog(categoryId = '', query = '', revision = 0) {
  const key = new URLSearchParams({ categoryId, query, revision: String(revision) }).toString();
  const snapshot = useApiResource<CatalogPair, CatalogData>(key, {
    adapter: 'catalog',
    load: loadCatalog,
    select: selectCatalog,
    failureData: failureCatalog
  });
  if (!snapshot) return undefined;
  return {
    key: snapshot.key,
    items: snapshot.loading ? [] : snapshot.data.items,
    categories: snapshot.data.categories,
    error: snapshot.error,
    loading: snapshot.loading
  };
}
