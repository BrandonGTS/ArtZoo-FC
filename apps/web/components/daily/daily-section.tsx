'use client';
import { useEffect, useState } from 'react';
import { useAuthSession } from '../auth-session';
import { PageHeading } from '../home-content';
import { MemberPaper } from '../members/member-ui';
import { accountRequest } from '../account/api';
import type { DailyList, DailyPostView } from '../../server/daily/contract';
import DailyCard from './daily-card';
import DailyHomeCard from './daily-home-card';
import { dailyError } from './use-command';
import { useFeedbackMessage } from '../use-feedback-message';
import './daily.css';

export default function DailySection({
  authorId,
  title = '最近动态',
  decoration = 'tomato',
  interactivePreview = false
}: {
  authorId?: string;
  title?: string;
  decoration?: 'tomato' | 'cheese';
  interactivePreview?: boolean;
}) {
  const { session } = useAuthSession(),
    actor = session?.user;
  return actor ? (
    <OwnedDailySection
      key={[actor.id, actor.membership, actor.adminRole, authorId ?? 'all'].join(':')}
      authorId={authorId}
      title={title}
      decoration={decoration}
      interactivePreview={interactivePreview}
    />
  ) : null;
}
function OwnedDailySection({
  authorId,
  title,
  decoration,
  interactivePreview
}: {
  authorId?: string;
  title: string;
  decoration: 'tomato' | 'cheese';
  interactivePreview: boolean;
}) {
  const { notify, contextHolder } = useFeedbackMessage();
  const [resource, setResource] = useState<{ data: DailyList | null; error: string | null }>({
    data: null,
    error: null
  });
  useEffect(() => {
    const controller = new AbortController();
    void accountRequest<DailyList>(
      '/api/daily' + (authorId ? '?author=' + encodeURIComponent(authorId) : ''),
      { signal: controller.signal }
    )
      .then((data) => {
        if (!controller.signal.aborted) setResource({ data, error: null });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setResource({ data: null, error: dailyError(error) });
      });
    return () => controller.abort();
  }, [authorId]);
  async function refresh(id: string) {
    const post = await accountRequest<DailyPostView>('/api/daily/' + id);
    setResource((current) =>
      current.data
        ? {
            data: {
              ...current.data,
              items: current.data.items.map((item) => (item.id === id ? post : item))
            },
            error: null
          }
        : current
    );
  }
  return (
    <section
      className={'home-section daily-preview' + (interactivePreview ? ' daily-home-preview' : '')}
      aria-label={title}
    >
      {contextHolder}
      <PageHeading decoration={decoration}>{title}</PageHeading>
      {resource.error ? (
        <p role="alert">{resource.error}</p>
      ) : !resource.data ? (
        <p role="status">正在读取动态…</p>
      ) : resource.data.items.length ? (
        resource.data.items.slice(0, interactivePreview ? 5 : 2).map((post) =>
          interactivePreview ? (
            <DailyHomeCard
              key={post.id}
              post={post}
              onChange={() => refresh(post.id)}
              onRemove={async () => {
                setResource((current) =>
                  current.data
                    ? {
                        ...current,
                        data: {
                          ...current.data,
                          items: current.data.items.filter((item) => item.id !== post.id)
                        }
                      }
                    : current
                );
                notify('success', '动态已删除');
              }}
            />
          ) : (
            <DailyCard
              key={post.id}
              post={post}
              preview
              onChange={async () => {}}
              onRemove={async () => {}}
            />
          )
        )
      ) : (
        <MemberPaper>
          <p>暂无动态</p>
        </MemberPaper>
      )}
    </section>
  );
}
