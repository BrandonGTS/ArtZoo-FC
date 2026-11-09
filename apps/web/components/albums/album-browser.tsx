'use client';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useUserRouter as useRouter } from '../user-operation-provider';
import { Button, Empty, Input, Spin, Tabs } from 'antd';
import type { AlbumView, Primary } from '../../server/albums/contract';
import { primaryLabels } from '../../server/albums/contract';
import { ErrorNotice } from '../account/account-ui';
import { useAuthSession } from '../auth-session';
import { PageHeading } from '../home-content';
import AlbumEditor from './album-editor';
import { albumRequest, errorDetail } from './api';
import '../home-activities.css';
import './albums.css';
export default function AlbumBrowser() {
  const { session } = useAuthSession();
  return session?.user ? (
    <BrowserContent key={session.user.id} />
  ) : (
    <main className="home-content">
      <PageHeading level={1} decoration="burger">
        相册
      </PageHeading>
    </main>
  );
}
function BrowserContent() {
  const router = useRouter();
  const [primary, setPrimary] = useState<Primary | undefined>(),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [editor, setEditor] = useState(false),
    [page, setPage] = useState(1),
    [reload] = useState(0);
  const [feed, setFeed] = useState<{
      key: string;
      items: AlbumView[];
      hasMore: boolean;
      error?: string;
    } | null>(null),
    sentinel = useRef<HTMLDivElement>(null),
    pending = useRef(false);
  const key = new URLSearchParams({
    ...(primary ? { primary } : {}),
    query: search,
    refresh: String(reload)
  }).toString();
  const current = feed?.key === key ? feed : null;
  const requested = useRef(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const userInitiated = requested.current;
    requested.current = true;
    pending.current = true;
    albumRequest<{ items: AlbumView[]; hasMore: boolean }>(`/api/albums?${key}&page=${page}`, undefined, {
      signal: controller.signal,
      userInitiated
    })
      .then((data) => {
        if (active)
          setFeed((previous) => ({
            key,
            items:
              page === 1 || previous?.key !== key
                ? data.items
                : [
                    ...previous.items,
                    ...data.items.filter((row) => !previous.items.some((p) => p.id === row.id))
                  ],
            hasMore: data.hasMore
          }));
      })
      .catch((e) => {
        if (active)
          setFeed((previous) => ({
            key,
            items: previous?.key === key ? previous.items : [],
            hasMore: false,
            error: errorDetail(e)
          }));
      })
      .finally(() => {
        if (active) pending.current = false;
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, page]);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !current?.hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !pending.current) setPage((p) => p + 1);
      },
      { rootMargin: '300px' }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [current]);
  return (
    <main className="home-content albums-content album-browser-page" id="main-content">
      <div className="album-page-heading">
        <PageHeading level={1} decoration="burger">
          相册
        </PageHeading>
        <Button type="primary" onClick={() => setEditor(true)}>
          创建相册
        </Button>
      </div>
      <div className="album-browser-filterbar">
        <Tabs
          className="album-browser-tabs"
          activeKey={primary ?? 'ALL'}
          type="line"
          indicator={{ align: 'center' }}
          classNames={{
            header: 'album-browser-tabs-header',
            indicator: 'album-browser-tabs-indicator',
            body: 'album-browser-tabs-body'
          }}
          items={[
            { key: 'ALL', label: '全部相册' },
            ...Object.entries(primaryLabels).map(([value, label]) => ({ key: value, label }))
          ]}
          onChange={(value) => {
            setPrimary(value === 'ALL' ? undefined : (value as Primary));
            setPage(1);
          }}
        />
        <div className="album-browser-search">
          <Input.Search
            autoComplete="off"
            aria-label="搜索相册名称"
            allowClear={{
              clearIcon: (
                <span className="album-search-clear" aria-label="清空搜索">
                  ×
                </span>
              )
            }}
            onClear={() => {
              setQuery('');
              setSearch('');
              setPage(1);
            }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onSearch={(value) => {
              setSearch(value);
              setPage(1);
            }}
            placeholder="搜索相册名称"
            maxLength={100}
          />
        </div>
      </div>
      {current?.error ? <ErrorNotice message={current.error} /> : null}
      <div className="album-grid">
        {current?.items.map((album) => (
          <article className="album-card" key={album.id}>
            <Link className="album-card-link" href={'/albums/' + album.id}>
              <span className="album-cover">
                {album.cover ? (
                  <Image unoptimized src={album.cover} alt="" width={480} height={320} />
                ) : (
                  <Image src="/artzoo/albums/image.svg" alt="" width={24} height={24} />
                )}
              </span>
              <div className="home-activity-title">
                <h3>{album.name}</h3>
              </div>
              <div className="album-card-meta">
                <svg
                  aria-hidden="true"
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.67"
                  strokeLinecap="round"
                >
                  <circle cx="10" cy="10" r="7.5" />
                  <path d="M10 9v5M10 6h.01" />
                </svg>
                <span>{primaryLabels[album.primary]}</span>
              </div>
              <div className="album-card-meta">
                <Image src="/artzoo/icons/user-round.svg" alt="" width={20} height={20} />
                <span>{album.creator.displayName ?? '成员'}</span>
              </div>
              <div className="album-card-footer">
                <span>{album.photoCount} 张照片</span>
              </div>
            </Link>
          </article>
        ))}
      </div>
      {!current ? (
        <Spin />
      ) : !current.items.length && !current.error ? (
        <Empty description="暂无相册" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : null}
      <div ref={sentinel} className="album-load-sentinel" />
      {editor ? (
        <AlbumEditor
          close={() => setEditor(false)}
          saved={(id) => {
            router.push(`/albums/${id}`);
          }}
        />
      ) : null}
    </main>
  );
}
