'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button } from 'antd';
import { useAuthSession } from '../auth-session';
import { PageHeading } from '../home-content';
import { MemberPaper } from '../members/member-ui';
import { accountRequest } from '../account/api';
import { useFeedbackMessage } from '../use-feedback-message';
import type { DailyPostView, DailyPage } from '../../server/daily/contract';
import { DailyComposer } from './lazy-composers';
import DailyHomeCard from './daily-home-card';
import { dailyError } from './use-command';
import './daily.css';
import { paginationViewportProps } from '../pagination-viewport';

export default function DailyFeed({ focusId }: { focusId?: string }) {
  const { session } = useAuthSession();
  return (
    <main className="home-content daily-content" id="main-content">
      <div className="daily-page-heading">
        <PageHeading level={1} decoration="burger">
          日常交流
        </PageHeading>
        {focusId ? (
          <Link className="daily-text-link" href="/daily">
            返回日常交流
          </Link>
        ) : null}
      </div>
      {session?.user ? (
        <OwnedFeed
          key={[session.user.id, session.user.membership, session.user.adminRole, focusId ?? 'list'].join(
            ':'
          )}
          focusId={focusId}
        />
      ) : null}
    </main>
  );
}
function OwnedFeed({ focusId }: { focusId?: string }) {
  const params = useSearchParams(),
    target = params.get('commentId'),
    focusCommentId = focusId && target && /^[0-9a-f-]{36}$/i.test(target) ? target : undefined;
  const [data, setData] = useState<DailyPage>({ items: [], next: null, page: 1, totalPages: 1, total: 0 });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [composer, setComposer] = useState(0),
    [composerOpened, setComposerOpened] = useState(false);
  const request = useRef<{ sequence: number; controller?: AbortController }>({ sequence: 0 });
  const { notify, contextHolder } = useFeedbackMessage();
  const loadPage = useCallback(
    async (page: number) => {
      request.current.controller?.abort();
      const controller = new AbortController(),
        sequence = ++request.current.sequence;
      request.current.controller = controller;
      setLoading(true);
      setError(null);
      try {
        const result = focusId
          ? await accountRequest<DailyPostView>('/api/daily/' + focusId, { signal: controller.signal }).then(
              (item) => ({ items: [item], next: null, page: 1, totalPages: 1, total: 1 })
            )
          : await accountRequest<DailyPage>('/api/daily?page=' + page, { signal: controller.signal });
        if (!controller.signal.aborted && sequence === request.current.sequence) setData(result);
      } catch (failure) {
        if (!controller.signal.aborted && sequence === request.current.sequence) {
          setError(dailyError(failure));
          throw failure;
        }
      } finally {
        if (!controller.signal.aborted && sequence === request.current.sequence) setLoading(false);
      }
    },
    [focusId]
  );
  useEffect(() => {
    const current = request.current;
    let active = true;
    void Promise.resolve()
      .then(() => {
        if (active) return loadPage(1);
      })
      .catch(() => {});
    return () => {
      active = false;
      current.controller?.abort();
      current.sequence++;
    };
  }, [loadPage]);
  async function refresh(id: string) {
    const sequence = request.current.sequence,
      post = await accountRequest<DailyPostView>('/api/daily/' + id);
    if (sequence === request.current.sequence)
      setData((current) => ({
        ...current,
        items: current.items.map((item) => (item.id === id ? post : item))
      }));
  }
  async function created() {
    await loadPage(1);
    setComposer((value) => value + 1);
    notify('success', '动态已发布');
  }
  async function removed(id: string) {
    setData((current) => ({ ...current, items: current.items.filter((post) => post.id !== id) }));
    notify('success', '动态已删除');
    await loadPage(data.page).catch(() => {});
  }
  return (
    <>
      {contextHolder}
      {!focusId ? (
        <MemberPaper className="daily-publisher">
          {composerOpened ? (
            <DailyComposer key={composer} variant="feed" onSaved={created} autoFocus={composer === 0} />
          ) : (
            <Button block className="daily-home-reply-placeholder" onClick={() => setComposerOpened(true)}>
              说点什么吧
            </Button>
          )}
        </MemberPaper>
      ) : null}
      <section className="home-section" aria-label={focusId ? '动态' : '最新动态'}>
        {!focusId ? <PageHeading decoration="tomato">最新动态</PageHeading> : null}
        {error ? (
          <div className="daily-actions">
            <p role="alert" className="daily-error">
              {error}
            </p>
            <Button type="text" onClick={() => void loadPage(data.page).catch(() => {})}>
              重试
            </Button>
          </div>
        ) : null}
        {loading ? <p role="status">正在读取动态…</p> : null}
        <div className="daily-flow" aria-busy={loading}>
          {data.items.map((post) =>
            focusId ? (
              <DailyHomeCard
                key={post.id}
                variant="detail"
                post={post}
                focusCommentId={focusCommentId}
                onEdited={() => notify('success', '动态已修改')}
                onChange={() => refresh(post.id)}
                onRemove={async () => {
                  setData((current) => ({
                    ...current,
                    items: current.items.filter((item) => item.id !== post.id)
                  }));
                  notify('success', '动态已删除');
                }}
              />
            ) : (
              <DailyHomeCard
                key={post.id}
                variant="feed"
                post={post}
                onEdited={() => notify('success', '动态已修改')}
                onChange={() => refresh(post.id)}
                onRemove={() => removed(post.id)}
              />
            )
          )}
        </div>
        {!loading && !error && !data.items.length ? (
          <MemberPaper>
            <p>暂无动态</p>
          </MemberPaper>
        ) : null}
        {!focusId && data.totalPages > 1 ? (
          <nav
            className="daily-page-navigation"
            aria-label="动态分页"
            {...paginationViewportProps(data.page, loading, '动态分页')}
          >
            <Button
              type="text"
              aria-label="上一页"
              disabled={loading || data.page <= 1}
              onClick={() => void loadPage(data.page - 1).catch(() => {})}
              icon={
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="m14 5-7 7 7 7"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              }
            />
            <span aria-live="polite" aria-atomic="true">
              {data.page} / {data.totalPages}
            </span>
            <Button
              type="text"
              aria-label="下一页"
              disabled={loading || data.page >= data.totalPages}
              onClick={() => void loadPage(data.page + 1).catch(() => {})}
              icon={
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="m10 5 7 7-7 7"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              }
            />
          </nav>
        ) : null}
      </section>
    </>
  );
}
