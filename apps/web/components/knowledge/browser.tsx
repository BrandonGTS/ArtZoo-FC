'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from 'antd';
import { PageHeading } from '../home-content';
import { CollectionFilters, ListPagination } from '../collection-controls';
import { accountRequest, errorDetail } from '../account/api';
import { useAuthSession } from '../auth-session';
import type { ArticleSummary } from '../../server/knowledge/contract';
import { Failure } from './shared';
import { KnowledgeSummaryCard } from './summary-card';
import { KNOWLEDGE_SECTIONS } from './category-options';
import './knowledge.css';
type Result = { items: ArticleSummary[]; total: number; page: number; pageSize: number };
export default function KnowledgeBrowser() {
  const { session } = useAuthSession(),
    actor = session?.user;
  return actor ? (
    <OwnedKnowledgeBrowser key={[actor.id, actor.membership, actor.adminRole].join(':')} />
  ) : null;
}
function OwnedKnowledgeBrowser() {
  const [data, setData] = useState<Result | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(true);
  const previousPath = useRef<string | null>(null);
  const [category, setCategory] = useState('all'),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(1);
  useEffect(() => {
    const abort = new AbortController(),
      params = new URLSearchParams({ page: String(page), query: search });
    if (category !== 'all') params.set('categoryLabel', category);
    const path = '/api/knowledge?' + params,
      userInitiated = previousPath.current !== null && previousPath.current !== path;
    previousPath.current = path;
    accountRequest<Result>(path, { signal: abort.signal, userInitiated })
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setData(null);
          setError(errorDetail(e).message);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [category, search, page]);
  const applySearch = (value: string) => {
    if (page === 1 && search === value) return;
    setBusy(true);
    setPage(1);
    setSearch(value);
  };
  return (
    <main className="home-content knowledge-content" id="main-content">
      <div className="knowledge-heading">
        <PageHeading level={1} decoration="burger">
          内容分享
        </PageHeading>
        <Button type="primary" href="/knowledge/new">
          发表分享
        </Button>
      </div>
      <CollectionFilters
        className="knowledge-browser-filters"
        tabs={[
          { key: 'all', label: '全部分区' },
          ...KNOWLEDGE_SECTIONS.map((label) => ({ key: label, label }))
        ]}
        activeKey={category}
        onTabChange={(value) => {
          setBusy(true);
          setPage(1);
          setCategory(value);
        }}
        searchLabel="标题搜索"
        placeholder="搜索分享标题"
        maxLength={200}
        query={query}
        onQueryChange={setQuery}
        onSearch={applySearch}
        onClear={() => {
          setQuery('');
          applySearch('');
        }}
      />
      <Failure message={error} />
      {busy ? <p role="status">正在读取分享…</p> : null}
      <section className="knowledge-list" aria-label="内容分享列表" aria-busy={busy}>
        {!busy
          ? data?.items.map((article) => <KnowledgeSummaryCard article={article} key={article.id} />)
          : null}
        {!busy && !error && data?.items.length === 0 ? <p>暂无分享</p> : null}
      </section>
      {data && data.total > data.pageSize ? (
        <ListPagination
          page={data.page}
          totalPages={Math.ceil(data.total / data.pageSize)}
          loading={busy}
          onPageChange={(value) => {
            setBusy(true);
            setPage(value);
          }}
        />
      ) : null}
    </main>
  );
}
