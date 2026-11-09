'use client';
import { ListPagination } from '../collection-controls';

import { useState } from 'react';
import type { ActivityHistory as HistoryData } from '@artzoo/domain';
import { PageHeading } from '../home-content';
import { useActivityResource } from './use-activity-resource';
import { ActivityLoadState, ActivityPaper, beijingFull } from './activity-ui';

export default function ActivityHistory({ id }: { id: string }) {
  const [page, setPage] = useState(1),
    [reload, setReload] = useState(0);
  const resource = useActivityResource<HistoryData>(
    `/api/activities/${encodeURIComponent(id)}/history?page=${page}&refresh=${reload}`
  );
  const history = resource.data;
  return (
    <ActivityPaper>
      <section className="activity-copy-section" aria-label="活动操作历史">
        <PageHeading decoration="cheese">活动操作历史</PageHeading>
        <ActivityLoadState
          loading={resource.loading}
          error={resource.error}
          retry={() => setReload((value) => value + 1)}
        />
        {history ? (
          <>
            {history.items.length ? (
              history.items.map((item) => (
                <div key={item.id}>
                  <p className="activity-note">
                    <time dateTime={item.createdAt}>{beijingFull(item.createdAt)}</time> · {item.actorName}
                  </p>
                  <p>{item.action}</p>
                </div>
              ))
            ) : (
              <p className="activity-note">暂无可查看的操作记录。</p>
            )}
            <ListPagination
              page={history.page}
              totalPages={history.totalPages}
              loading={resource.loading}
              onPageChange={setPage}
              label="操作历史分页"
            />
          </>
        ) : null}
      </section>
    </ActivityPaper>
  );
}
