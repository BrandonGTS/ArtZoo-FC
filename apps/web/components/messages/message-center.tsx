'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Tabs } from 'antd';
import { MESSAGE_CATEGORIES, type MessageCategory, type MessageItem, type MessagePage } from '@artzoo/domain';
import { PageHeading } from '../home-content';
import { useAuthSession } from '../auth-session';
import { useFeedbackMessage } from '../use-feedback-message';
import { errorDetail } from '../account/api';
import { useActivityResource } from '../activities/use-activity-resource';
import { ActivityLoadState } from '../activities/activity-ui';
import { ListPagination } from '../collection-controls';
import { useMessageState } from './message-state';
import MessageCard from './message-card';
import './messages.css';
const categories: Record<MessageCategory, string> = {
  comments: '评论',
  likes: '点赞收藏',
  recruitment: '我的招募',
  participation: '我的报名',
  system: '系统消息'
};
export default function MessageCenter() {
  const { session } = useAuthSession(),
    owner = session?.user?.id;
  return owner ? <OwnedMessageCenter key={owner} owner={owner} /> : null;
}
function OwnedMessageCenter({ owner }: { owner: string }) {
  const router = useRouter(),
    params = useSearchParams(),
    candidate = params.get('category'),
    category: MessageCategory = MESSAGE_CATEGORIES.includes(candidate as MessageCategory)
      ? (candidate as MessageCategory)
      : 'comments';
  const requested = params.get('page') ?? '1',
    page = /^[1-9]\d*$/.test(requested) && Number.isSafeInteger(Number(requested)) ? Number(requested) : 1;
  const { categoryUnread, readAtById, externalVersion, markRead, remove } = useMessageState(),
    { contextHolder, notify } = useFeedbackMessage();
  const [reload, setReload] = useState(0),
    [busy, setBusy] = useState<string | null>(null),
    alive = useRef(false),
    deleting = useRef(false);
  const resource = useActivityResource<MessagePage>(
      `/api/me/messages?category=${category}&page=${page}&refresh=${reload}&external=${externalVersion}`
    ),
    data = resource.data;
  const navigate = useCallback(
    (next: MessageCategory, nextPage: number) =>
      router.replace(`/me/messages?category=${next}&page=${nextPage}`, { scroll: false }),
    [router]
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, [owner]);
  useEffect(() => {
    if (data && !resource.loading && data.category === category && data.page !== page)
      navigate(category, data.page);
  }, [data, resource.loading, category, page, navigate]);
  const onRead = useCallback(
    async (item: MessageItem) => {
      try {
        await markRead(item.id);
      } catch (failure) {
        if (alive.current) notify('error', errorDetail(failure).message);
        throw failure;
      }
    },
    [markRead, notify]
  );
  async function erase(item: MessageItem) {
    if (deleting.current || resource.loading) return;
    deleting.current = true;
    setBusy(item.id);
    try {
      await remove(item.id);
      if (alive.current) {
        setReload((value) => value + 1);
        notify('success', '消息已删除');
      }
    } catch (failure) {
      if (alive.current) notify('error', errorDetail(failure).message);
      throw failure;
    } finally {
      deleting.current = false;
      if (alive.current) setBusy(null);
    }
  }
  return (
    <main className="home-content messages-content" id="main-content">
      {contextHolder}
      <div className="messages-heading">
        <PageHeading level={1} decoration="burger">
          消息中心
        </PageHeading>
      </div>
      <div className="collection-filterbar messages-filterbar">
        <Tabs
          className="collection-tabs"
          activeKey={category}
          type="line"
          animated={{ inkBar: true, tabPane: false }}
          indicator={{ align: 'center' }}
          classNames={{
            header: 'collection-tabs-header',
            indicator: 'collection-tabs-indicator',
            body: 'collection-tabs-body'
          }}
          items={MESSAGE_CATEGORIES.map((key) => ({
            key,
            label: (
              <span className="message-category-label">
                {categories[key]}
                {(categoryUnread?.[key] ?? data?.categoryUnread?.[key] ?? 0) > 0 ? (
                  <span className="message-unread-dot" aria-label="有未读消息" />
                ) : null}
              </span>
            ),
            disabled: !!busy
          }))}
          onChange={(key) => navigate(key as MessageCategory, 1)}
        />
      </div>
      <ActivityLoadState
        loading={resource.loading}
        error={resource.error}
        retry={() => setReload((value) => value + 1)}
      />
      {data && data.category === category && data.page === page ? (
        <section className="message-results" aria-label={`${categories[category]}消息列表`}>
          {data.items.length ? (
            data.items.map((item) => (
              <MessageCard
                key={`${category}:${page}:${item.id}`}
                item={readAtById[item.id] ? { ...item, readAt: readAtById[item.id]! } : item}
                onRead={onRead}
                onDelete={erase}
                disabled={!!busy}
              />
            ))
          ) : (
            <p className="activity-note">暂无消息</p>
          )}
          <ListPagination
            page={data.page}
            totalPages={data.totalPages}
            loading={resource.loading || !!busy}
            onPageChange={(value) => navigate(category, value)}
            label="消息分页"
          />
        </section>
      ) : null}
    </main>
  );
}
