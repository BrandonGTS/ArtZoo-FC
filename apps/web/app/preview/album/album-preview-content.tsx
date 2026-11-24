'use client';

import { ConfigProvider } from 'antd';
import { useLayoutEffect, useRef, useState } from 'react';
import { CollectionSearch, CollectionTabs } from '../../../components/collection-controls';
import { artzooTheme } from '../../../components/providers';
import daily from '../daily/daily-preview.module.css';
import home from '../home/home-preview.module.css';
import PreviewHeader from '../preview-header';
import AlbumPhotos from './album-photos';
import styles from './album-preview.module.css';

const categories = ['全部', '活动', '摄影', '日常', '线下'].map((label) => ({ key: label, label }));
const albums = [
  { name: '部队周年合影', category: '活动', date: '11月14日', count: 18, color: 'var(--cover)' },
  { name: '海边散步', category: '摄影', date: '10月28日', count: 12, color: 'var(--photo)' },
  { name: '零式首通', category: '活动', date: '10月20日', count: 24, color: 'var(--line)' },
  {
    name: '部队小屋',
    category: '日常',
    date: '10月05日',
    count: 16,
    color: 'color-mix(in srgb, var(--photo) 64%, var(--wish))'
  },
  { name: '秋日桌游聚会', category: '线下', date: '09月27日', count: 15, color: 'var(--wish)' },
  { name: '伊修加德的雪夜', category: '摄影', date: '09月19日', count: 22, color: 'var(--line)' },
  { name: '第一次出海钓鱼', category: '日常', date: '09月13日', count: 10, color: 'var(--photo)' },
  { name: '藏宝图之夜', category: '活动', date: '09月06日', count: 20, color: 'var(--cover)' },
  { name: '周末咖啡小聚', category: '线下', date: '08月30日', count: 8, color: 'var(--line)' },
  { name: '拉诺西亚的日出', category: '摄影', date: '08月24日', count: 14, color: 'var(--wish)' },
  { name: '金碟游乐场的一天', category: '日常', date: '08月16日', count: 17, color: 'var(--photo)' },
  { name: '夏夜坐骑巡游', category: '活动', date: '08月09日', count: 26, color: 'var(--line)' },
  { name: '夏日同城聚餐', category: '线下', date: '08月02日', count: 12, color: 'var(--cover)' }
];

export type PreviewAlbum = (typeof albums)[number];

export default function AlbumPreviewContent() {
  const [category, setCategory] = useState('全部');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [album, setAlbum] = useState<PreviewAlbum | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const catalogScroll = useRef(0);
  const matches = albums.filter(
    (item) => (category === '全部' || item.category === category) && item.name.includes(appliedQuery)
  );

  useLayoutEffect(() => {
    if (!opener.current) return;
    const screen = root.current?.closest('[data-preview-page]');
    screen?.scrollTo({ top: album ? 0 : catalogScroll.current });
    (album ? back.current : opener.current)?.focus({ preventScroll: true });
  }, [album]);

  return (
    <div ref={root} className={daily.daily}>
      <div hidden={album !== null}>
        <ConfigProvider theme={artzooTheme}>
          <PreviewHeader announcement="本周六 20:00 公会团本开荒，记得提前上线集合。">
            <div className={home.hero + ' ' + daily.hero + ' ' + styles.albumHero}>
              <h1 className={home.title + ' ' + daily.title} lang="en">
                Guild <em>Album</em>
              </h1>
              <div className={styles.categoryLine}>
                <CollectionTabs
                  variant="secondary"
                  className={styles.categories}
                  tabs={categories}
                  activeKey={category}
                  onTabChange={setCategory}
                />
              </div>
              <search
                className={daily.shareSearch}
                aria-label="相册"
                onKeyDownCapture={(event) => {
                  if (event.key === 'Enter' && event.nativeEvent.keyCode === 229) event.stopPropagation();
                }}
              >
                <CollectionSearch
                  className={daily.searchField}
                  query={query}
                  onQueryChange={setQuery}
                  onSearch={(value) => setAppliedQuery(value.trim())}
                  onClear={() => {
                    setQuery('');
                    setAppliedQuery('');
                  }}
                  searchLabel="搜索相册"
                  placeholder="搜索相册"
                />
              </search>
            </div>
          </PreviewHeader>
        </ConfigProvider>
        {matches.length ? (
          <ul className={styles.catalog} aria-label="相册目录">
            {matches.map((item, index) => (
              <li key={item.name} className={index === 0 ? styles.feature : undefined}>
                <button
                  type="button"
                  className={styles.albumCard}
                  aria-label={'打开相册：' + item.name}
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    catalogScroll.current = root.current?.closest('[data-preview-page]')?.scrollTop ?? 0;
                    setAlbum(item);
                  }}
                >
                  <span aria-hidden="true" className={styles.cover} style={{ backgroundColor: item.color }} />
                  <span className={styles.caption}>
                    <strong>{item.name}</strong>
                    <span className={styles.meta}>
                      {item.date} · {item.count}张
                    </span>
                    {index === 0 && (
                      <span className={styles.cta}>
                        打开相册 <span aria-hidden="true">→</span>
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p role="status" className={styles.empty}>
            没有找到相册，试试其他分类或关键词。
          </p>
        )}
      </div>
      {album && (
        <section aria-label={album.name}>
          <button ref={back} className={styles.back} type="button" onClick={() => setAlbum(null)}>
            ← 返回相册
          </button>
          <h1 className={styles.galleryTitle}>{album.name}</h1>
          <p className={styles.meta}>
            {album.date} · {album.count}张
          </p>
          <AlbumPhotos album={album} />
        </section>
      )}
    </div>
  );
}
