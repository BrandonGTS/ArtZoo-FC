'use client';
import { CursorPagination } from '../collection-controls';
import { useEffect, useState } from 'react';
import { Button } from 'antd';
import { useAuthSession } from '../auth-session';
import { ErrorNotice } from '../account/account-ui';
import { accountRequest, errorDetail } from '../account/api';
export default function ActivityShareEntry({ activityId }: { activityId: string }) {
  const { session } = useAuthSession(),
    owner = [session?.user?.id, session?.user?.membership, session?.user?.adminRole].join(':'),
    administrator = session?.user?.adminRole === 'ADMIN' || session?.user?.adminRole === 'SUPER_ADMIN';
  const [page, setPage] = useState(1),
    [resource, setResource] = useState<{
      owner: string;
      page: number;
      items: { id: string; title: string; featuredAt: string | null }[];
      hasMore: boolean;
      error: string | null;
    } | null>(null);
  useEffect(() => {
    if (!administrator) return;
    const controller = new AbortController();
    accountRequest<{
      items: { id: string; title: string; featuredAt: string | null }[];
      hasMore: boolean;
    }>(`/api/activity-shares/for-activity/${activityId}?page=${page}`, {
      signal: controller.signal
    })
      .then((data) => {
        if (!controller.signal.aborted) setResource({ ...data, owner, page, error: null });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setResource({
            owner,
            page,
            items: [],
            hasMore: false,
            error: errorDetail(e).message
          });
      });
    return () => controller.abort();
  }, [activityId, owner, administrator, page]);
  if (!administrator) return null;
  const data = resource?.owner === owner ? resource : null;
  return (
    <section aria-label="活动分享管理">
      <div className="album-actions">
        <Button href={`/admin/activity-shares/new?activityId=${activityId}`}>编写活动分享</Button>
      </div>
      <ErrorNotice message={data?.error ?? null} />
      {data?.items.map((item) => (
        <div key={item.id} className="album-actions">
          <span>
            {item.title || '未命名分享'}
            {item.featuredAt ? ' · 已精选' : ' · 草稿'}
          </span>
          <Button href={`/admin/activity-shares/${item.id}`}>查看详情</Button>
        </div>
      ))}
      {data ? (
        <CursorPagination
          page={page}
          hasMore={data.hasMore}
          loading={data.page !== page}
          onPageChange={setPage}
          label="活动分享管理分页"
        />
      ) : null}
    </section>
  );
}
