'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from 'antd';
import { accountRequest, errorDetail } from '../account/api';
import { ListPagination } from '../collection-controls';
import { KnowledgeSummaryCard } from '../knowledge/summary-card';
import { useFeedbackMessage } from '../use-feedback-message';
import type { ArticleSummary } from '../../server/knowledge/contract';
import { MemberPaper } from './member-ui';
import '../knowledge/knowledge.css';
import './member-shares.css';

type SharePage = { items: ArticleSummary[]; total: number; page: number; pageSize: number };

export default function MemberShares({ authorId }: { authorId: string }) {
  return <MemberSharesContent key={authorId} authorId={authorId} />;
}

function MemberSharesContent({ authorId }: { authorId: string }) {
  const [data, setData] = useState<SharePage | null>(null);
  const [loading, setLoading] = useState(true),
    [failed, setFailed] = useState(false);
  const request = useRef<{ sequence: number; page: number; controller?: AbortController }>({
    sequence: 0,
    page: 1
  });
  const { notify, contextHolder } = useFeedbackMessage();

  async function loadPage(page: number, userInitiated = true) {
    request.current.controller?.abort();
    const controller = new AbortController(),
      sequence = ++request.current.sequence;
    request.current.controller = controller;
    request.current.page = page;
    setLoading(true);
    setFailed(false);
    try {
      const result = await accountRequest<SharePage>(
        `/api/knowledge?author=${encodeURIComponent(authorId)}&page=${page}`,
        { signal: controller.signal, userInitiated }
      );
      if (!controller.signal.aborted && sequence === request.current.sequence) {
        setData(result);
        request.current.page = result.page;
      }
    } catch (failure) {
      if (!controller.signal.aborted && sequence === request.current.sequence) {
        setFailed(true);
        notify('error', errorDetail(failure).message);
      }
    } finally {
      if (!controller.signal.aborted && sequence === request.current.sequence) setLoading(false);
    }
  }

  useEffect(() => {
    const current = request.current;
    let active = true;
    void Promise.resolve().then(() => {
      if (active) return loadPage(1, false);
    });
    return () => {
      active = false;
      current.controller?.abort();
      current.sequence++;
    };
    // The keyed parent fixes the author and viewer for this component lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="member-shares" aria-label="成员分享">
      {contextHolder}
      {failed ? (
        <div className="member-shares-retry">
          <p>暂时无法读取分享</p>
          <Button type="text" onClick={() => void loadPage(request.current.page)}>
            重试
          </Button>
        </div>
      ) : null}
      {loading ? <p role="status">正在读取分享…</p> : null}
      <div className="knowledge-list" aria-label="成员分享列表" aria-busy={loading}>
        {!failed
          ? data?.items.map((article) => <KnowledgeSummaryCard article={article} key={article.id} />)
          : null}
      </div>
      {!loading && !failed && data?.items.length === 0 ? (
        <MemberPaper>
          <p>暂无分享</p>
        </MemberPaper>
      ) : null}
      {data ? (
        <ListPagination
          page={data.page}
          totalPages={Math.ceil(data.total / data.pageSize)}
          loading={loading || failed}
          onPageChange={(page) => void loadPage(page)}
          label="成员分享分页"
        />
      ) : null}
    </section>
  );
}
