'use client';
import { useState } from 'react';
import { Button, Card } from 'antd';
import type { ActivityShareList, PublicActivityShare } from '@artzoo/domain';
import { ErrorNotice } from '../account/account-ui';
import { useSharingResource } from './sharing-api';
import HomeCardSurface from '../home-card-surface';
import { ListPagination } from '../collection-controls';
import './public-sharing.css';
export default function PublicShareList({ limit }: { limit?: number }) {
  const [page, setPage] = useState(1),
    [reload, setReload] = useState(0);
  const resource = useSharingResource<ActivityShareList>(
    '/api/activity-shares?page=' + page + '&refresh=' + reload
  );
  if (!limit && !resource.loading && resource.data && page > Math.max(1, Math.ceil(resource.data.total / 12)))
    setPage(Math.max(1, Math.ceil(resource.data.total / 12)));
  const items: PublicActivityShare[] = limit
    ? (resource.data?.items ?? []).slice(0, limit)
    : (resource.data?.items ?? []);
  return (
    <>
      <ErrorNotice message={resource.error} />
      {resource.error ? <Button onClick={() => setReload((value) => value + 1)}>重新读取</Button> : null}
      {resource.loading ? (
        <p role="status">正在读取活动分享…</p>
      ) : (
        <div className="public-share-grid">
          {items.map((share) => (
            <HomeCardSurface key={share.id} motionProfile="feed" navigation="links">
              <Card
                variant="borderless"
                classNames={{
                  root: 'paper-panel paper-activity public-share-card',
                  body: 'public-share-card-body'
                }}
              >
                <h3>
                  <Button type="link" href={'/activity-shares/' + share.id}>
                    {share.title}
                  </Button>
                </h3>
                <p className="public-share-excerpt">{share.body}</p>
              </Card>
            </HomeCardSurface>
          ))}
        </div>
      )}
      {!resource.loading && !resource.error && !items.length ? (
        <p className="public-empty">暂无活动分享</p>
      ) : null}
      {!limit && resource.data && (page > 1 || resource.data.total > 12) ? (
        <ListPagination
          page={resource.data.page}
          totalPages={Math.ceil(resource.data.total / 12)}
          loading={resource.loading}
          onPageChange={setPage}
          label="公开活动分享分页"
        />
      ) : null}
    </>
  );
}
