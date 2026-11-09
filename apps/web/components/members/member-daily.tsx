'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from 'antd';
import { accountRequest } from '../account/api';
import { ListPagination } from '../collection-controls';
import { useFeedbackMessage } from '../use-feedback-message';
import type { DailyPage, DailyPostView } from '../../server/daily/contract';
import DailyHomeCard from '../daily/daily-home-card';
import { dailyError } from '../daily/use-command';
import { MemberPaper } from './member-ui';
import '../daily/daily.css';

export default function MemberDaily({ authorId }: { authorId: string }) {
  const [data, setData] = useState<DailyPage>({ items: [], next: null, page: 1, totalPages: 1, total: 0 });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null);
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
        const result = await accountRequest<DailyPage>(
          `/api/daily?author=${encodeURIComponent(authorId)}&page=${page}`,
          { signal: controller.signal }
        );
        if (!controller.signal.aborted && sequence === request.current.sequence) setData(result);
      } catch (failure) {
        if (!controller.signal.aborted && sequence === request.current.sequence)
          setError(dailyError(failure));
      } finally {
        if (!controller.signal.aborted && sequence === request.current.sequence) setLoading(false);
      }
    },
    [authorId]
  );
  useEffect(() => {
    const current = request.current;
    let active = true;
    void Promise.resolve().then(() => {
      if (active) return loadPage(1);
    });
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
  async function removed(id: string) {
    setData((current) => ({ ...current, items: current.items.filter((post) => post.id !== id) }));
    notify('success', '动态已删除');
    await loadPage(data.page);
  }
  return (
    <section aria-label="成员动态">
      {contextHolder}
      {error ? (
        <div className="daily-actions">
          <p role="alert" className="daily-error">
            {error}
          </p>
          <Button type="text" onClick={() => void loadPage(data.page)}>
            重试
          </Button>
        </div>
      ) : null}
      {loading ? <p role="status">正在读取动态…</p> : null}
      <div className="daily-flow" aria-busy={loading}>
        {data.items.map((post) => (
          <DailyHomeCard
            key={post.id}
            variant="feed"
            post={post}
            onEdited={() => notify('success', '动态已修改')}
            onChange={() => refresh(post.id)}
            onRemove={() => removed(post.id)}
          />
        ))}
      </div>
      {!loading && !error && !data.items.length ? (
        <MemberPaper>
          <p>暂无动态</p>
        </MemberPaper>
      ) : null}
      <ListPagination
        page={data.page}
        totalPages={data.totalPages}
        loading={loading || !!error}
        onPageChange={(page) => void loadPage(page)}
        label="成员动态分页"
      />
    </section>
  );
}
