'use client';

import { useState } from 'react';
import { Button } from 'antd';
import { WISH_CATEGORIES, WISH_PAGE_SIZE, type WishList } from '../../server/wishes/contract';
import { ActivityHeading } from '../activities/activity-ui';
import { useActivityResource } from '../activities/use-activity-resource';
import { CollectionFilters, ListPagination } from '../collection-controls';
import { WishCard } from './wish-ui';

export default function WishBrowser() {
  const [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [category, setCategory] = useState(''),
    [page, setPage] = useState(1),
    [version, setVersion] = useState(0);
  const params = new URLSearchParams({ page: String(page), query: search, v: String(version) });
  if (category) params.set('category', category);
  const resource = useActivityResource<WishList>('/api/wishes?' + params, { keepPreviousData: true });
  const currentPage = resource.data?.page ?? page,
    totalPages = Math.max(
      1,
      Math.ceil((resource.data?.total ?? 0) / (resource.data?.pageSize ?? WISH_PAGE_SIZE))
    );
  function submit(value: string) {
    setQuery(value);
    setSearch(value.trim());
    setPage(1);
    setVersion((current) => current + 1);
  }
  return (
    <main className="home-content wishes-content" id="main-content">
      <ActivityHeading title="心愿板">
        {resource.data?.canPublish ? (
          <Button type="primary" href="/wishes/new">
            发布心愿
          </Button>
        ) : null}
      </ActivityHeading>
      <CollectionFilters
        tabs={[
          { key: '', label: '全部心愿' },
          ...WISH_CATEGORIES.map((item) => ({ key: item.value, label: item.label }))
        ]}
        activeKey={category}
        onTabChange={(value) => {
          setCategory(value);
          setPage(1);
        }}
        query={query}
        onQueryChange={setQuery}
        onSearch={submit}
        onClear={() => submit('')}
        searchLabel="搜索心愿"
        placeholder="搜索心愿"
      />
      <section className="wish-results" aria-label="心愿列表" aria-busy={resource.loading}>
        {resource.loading ? <p role="status">正在读取心愿…</p> : null}
        {resource.error ? <p role="alert">{resource.error}</p> : null}
        {resource.data && !resource.error ? (
          <>
            <div className="wish-grid">
              {resource.data.items.map((wish) => (
                <WishCard
                  key={wish.id}
                  wish={wish}
                  onInterestChanged={() => setVersion((value) => value + 1)}
                />
              ))}
            </div>
            {!resource.data.items.length ? <p>暂无心愿。</p> : null}
          </>
        ) : null}
      </section>
      <ListPagination
        page={currentPage}
        totalPages={totalPages}
        loading={resource.loading}
        onPageChange={setPage}
        label="心愿分页"
      />
    </main>
  );
}
