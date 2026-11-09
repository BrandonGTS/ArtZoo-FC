'use client';

import { useState } from 'react';
import type { MemberRecruitmentPage } from '../../server/members/recruitments';
import { useActivityResource } from '../activities/use-activity-resource';
import { CollectionSearch, ListPagination } from '../collection-controls';
import { HomeActivityCard } from '../home-activities';
import { MemberLoadState, MemberPaper } from './member-ui';

export default function MemberRecruitments({ authorId }: { authorId: string }) {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState(''),
    [search, setSearch] = useState('');
  const resource = useActivityResource<MemberRecruitmentPage>(
    `/api/members/${encodeURIComponent(authorId)}/recruitments?page=${page}&search=${encodeURIComponent(search)}`
  );
  return (
    <section aria-label="成员招募" className="member-recruitments">
      <CollectionSearch
        query={query}
        onQueryChange={setQuery}
        onSearch={(value) => {
          setSearch(value.trim());
          setPage(1);
        }}
        onClear={() => {
          setQuery('');
          setSearch('');
          setPage(1);
        }}
        searchLabel="搜索成员招募"
        placeholder="搜索标题、副本或地点"
      />
      <MemberLoadState loading={resource.loading} error={resource.error} />
      {resource.data ? (
        <>
          <div className="activity-grid member-recruitment-grid">
            {resource.data.items.map((activity) => (
              <HomeActivityCard key={activity.id} activity={activity} />
            ))}
          </div>
          {!resource.data.items.length ? (
            <MemberPaper>
              <p>暂无招募</p>
            </MemberPaper>
          ) : null}
        </>
      ) : null}
      <ListPagination
        page={resource.data?.page ?? page}
        totalPages={resource.data?.totalPages ?? page}
        loading={resource.loading || !!resource.error}
        onPageChange={setPage}
        label="成员招募分页"
      />
    </section>
  );
}
