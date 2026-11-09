'use client';
import { useEffect, useState } from 'react';
import { Button } from 'antd';
import { CollectionFilters, ListPagination } from '../collection-controls';
import { useAuthSession } from '../auth-session';
import { accountRequest, errorDetail } from '../account/api';
import { subscribeCheckinChanges } from '../checkin/checkin-events';
import { ActivityHeading } from '../activities/activity-ui';
import type { LotteryView } from '../../server/lottery/contract';
import { LoadState } from './lottery-ui';
import LotteryCard, { participationLabel } from './lottery-card';

type LotteryList = { items: LotteryView[]; total: number; page: number; pageSize: number };
export default function LotteryBrowser() {
  const { session } = useAuthSession(),
    actor = session?.user;
  const canCreate = actor?.membership === 'MEMBER' || Boolean(actor && actor.adminRole !== 'NONE');
  return (
    <OwnedLotteryBrowser
      key={[actor?.id, actor?.membership, actor?.adminRole].join(':')}
      canCreate={canCreate}
    />
  );
}
function useLotteryList(path: string, userInitiated: boolean) {
  const { session, loading: sessionLoading, error: sessionError } = useAuthSession(),
    owner = session?.user?.id ?? null;
  const [snapshot, setSnapshot] = useState<{
    owner: string;
    path: string;
    data: LotteryList | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!owner) return;
    let active = true,
      request: AbortController | null = null,
      timer: ReturnType<typeof setTimeout> | null = null;
    function load(initiated = false) {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      accountRequest<LotteryList>(path, { signal: controller.signal, userInitiated: initiated }).then(
        (data) => {
          if (active && !controller.signal.aborted) setSnapshot({ owner: owner!, path, data, error: null });
        },
        (error) => {
          if (active && !controller.signal.aborted)
            setSnapshot((previous) => ({
              owner: owner!,
              path,
              data: previous?.owner === owner && previous.path === path ? previous.data : null,
              error: errorDetail(error).message
            }));
        }
      );
    }
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        load();
      }, 50);
    };
    const unsubscribe = subscribeCheckinChanges(owner, refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    load(userInitiated);
    return () => {
      active = false;
      request?.abort();
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [owner, path, userInitiated]);
  const owned = snapshot?.owner === owner && snapshot.path === path ? snapshot : null;
  return {
    data: owned?.data ?? null,
    error: owner ? (owned?.error ?? null) : sessionError || (sessionLoading ? null : '请登录后查看抽奖。'),
    loading: sessionLoading || (!!owner && !owned)
  };
}
function OwnedLotteryBrowser({ canCreate }: { canCreate: boolean }) {
  const [page, setPage] = useState(1),
    [category, setCategory] = useState('ongoing'),
    [userInitiated, setUserInitiated] = useState(false),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState('');
  const submitSearch = (value: string) => {
    setUserInitiated(true);
    setSearch(value.trim());
    setPage(1);
  };
  const resource = useLotteryList(
    `/api/lotteries?page=${page}&category=${category}&search=${encodeURIComponent(search)}`,
    userInitiated
  );
  return (
    <main className="home-content lottery-content lottery-browser-content" id="main-content">
      <ActivityHeading title="抽奖">
        {canCreate ? (
          <Button type="primary" href="/lotteries/new">
            发起抽奖
          </Button>
        ) : null}
      </ActivityHeading>
      <CollectionFilters
        query={query}
        onQueryChange={setQuery}
        onSearch={submitSearch}
        onClear={() => {
          setQuery('');
          submitSearch('');
        }}
        searchLabel="搜索抽奖标题"
        placeholder="搜索抽奖标题"
        maxLength={80}
        tabs={[
          { key: 'ongoing', label: '进行中' },
          { key: 'completed', label: '已完成' }
        ]}
        activeKey={category}
        onTabChange={(key) => {
          setUserInitiated(true);
          setCategory(key);
          setPage(1);
        }}
      />
      <LoadState loading={resource.loading} error={resource.error} />
      {!resource.loading && !resource.error && !resource.data?.items.length ? (
        <p>暂无{category === 'ongoing' ? '进行中' : '已完成'}的抽奖。</p>
      ) : null}
      <div className="lottery-grid">
        {resource.data?.items.map((row) => (
          <LotteryCard key={row.id} row={{ ...row, participation: participationLabel(row) }} />
        ))}
      </div>
      {resource.data ? (
        <ListPagination
          page={resource.data.page}
          totalPages={Math.ceil(resource.data.total / resource.data.pageSize)}
          loading={resource.loading}
          onPageChange={(value) => {
            setUserInitiated(true);
            setPage(value);
          }}
          label="抽奖分页"
        />
      ) : null}
    </main>
  );
}
