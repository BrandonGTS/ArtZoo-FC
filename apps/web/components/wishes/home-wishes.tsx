'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from 'antd';
import type { WishHomeList } from '../../server/wishes/contract';
import { useAuthSession } from '../auth-session';
import { useFeedbackMessage } from '../use-feedback-message';
import { useActivityResource } from '../activities/use-activity-resource';
import { PageHeading } from '../home-content';
import { WishCard, WishPaper } from './wish-ui';

export default function HomeWishes() {
  const { session } = useAuthSession(),
    [batch, setBatch] = useState({ version: 0, exclude: '' });
  const resource = useActivityResource<WishHomeList>(
    '/api/wishes/home?exclude=' + encodeURIComponent(batch.exclude) + '&v=' + batch.version,
    { keepPreviousData: true }
  );
  const { notify, contextHolder } = useFeedbackMessage(),
    lastError = useRef<string | null>(null);
  useEffect(() => {
    if (resource.error && resource.error !== lastError.current) notify('error', resource.error);
    lastError.current = resource.error;
  }, [resource.error, notify]);
  function refresh() {
    if (resource.loading) return;
    setBatch((previous) => ({
      version: previous.version + 1,
      exclude: resource.data?.items.map((wish) => wish.id).join(',') ?? ''
    }));
  }
  return (
    <>
      {contextHolder}
      <div className="wish-home-heading" id="wishes-heading">
        <PageHeading decoration="patty">心愿板</PageHeading>
        {session?.user ? (
          <Button
            type="text"
            className="wish-home-refresh"
            disabled={resource.loading}
            aria-label="翻翻心愿，刷新心愿板"
            onClick={refresh}
            icon={
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M20 7v5h-5M4 17v-5h5" />
                <path d="M6.1 7a7 7 0 0 1 11.55-1.4L20 8M4 16l2.35 2.4A7 7 0 0 0 17.9 17" />
              </svg>
            }
          >
            翻翻心愿
          </Button>
        ) : null}
      </div>
      {!session?.user ? (
        <p>登录后浏览心愿板。</p>
      ) : (
        <>
          {resource.loading && !resource.data ? (
            <p role="status">正在读取心愿…</p>
          ) : resource.data?.items.length ? (
            resource.data.items.map((wish) => <WishCard key={wish.id} wish={wish} variant="home" />)
          ) : !resource.error ? (
            <WishPaper>
              <p>暂无心愿。</p>
            </WishPaper>
          ) : null}
        </>
      )}
    </>
  );
}
