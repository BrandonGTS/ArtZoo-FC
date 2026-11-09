'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Empty, Tag } from 'antd';
import type { MemberList, Membership } from '@artzoo/domain';
import { useResource } from '../account/use-resource';
import { CollectionFilters, ListPagination } from '../collection-controls';
import { PageHeading } from '../home-content';
import HomeCardSurface from '../home-card-surface';
import DailyToolbarIcon from '../daily/daily-toolbar-icon';
import { MemberAvatar, MemberLoadState, MemberPaper, memberLocation } from './member-ui';
import './member-directory.css';

const PAGE_SIZE = 15;
const membershipTabs = [
  { key: 'ALL', label: '全部成员' },
  { key: 'MEMBER', label: '正式成员' },
  { key: 'FRIEND', label: '其他亲友' }
];
const registrationFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: 'long',
  day: 'numeric'
});

export default function MemberDirectory({
  initialQuery,
  membership
}: {
  initialQuery: string;
  membership: Membership | '';
}) {
  const [query, setQuery] = useState(initialQuery),
    [page, setPage] = useState(1),
    [reload, setReload] = useState(0);
  const router = useRouter();
  function navigate(nextQuery: string, nextMembership: Membership | '') {
    setPage(1);
    const params = new URLSearchParams();
    if (nextQuery) params.set('query', nextQuery);
    if (nextMembership) params.set('membership', nextMembership);
    router.replace(params.size ? `/members?${params}` : '/members', { scroll: false });
    setReload((value) => value + 1);
  }
  const params = new URLSearchParams({ query: initialQuery, refresh: String(reload) });
  if (membership) params.set('membership', membership);
  const resource = useResource<MemberList>(`/api/members?${params}`);
  // The service returns the complete matching list in createdAt/id order.
  const totalPages = Math.max(1, Math.ceil((resource.data?.items.length ?? 0) / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const members = resource.data?.items.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  return (
    <main className="home-content members-content member-directory-page" id="main-content">
      <PageHeading level={1} decoration="burger">
        成员名册
      </PageHeading>
      <CollectionFilters
        tabs={membershipTabs}
        activeKey={membership || 'ALL'}
        onTabChange={(key) => navigate(initialQuery, key === 'ALL' ? '' : (key as Membership))}
        query={query}
        onQueryChange={setQuery}
        onSearch={(value) => navigate(value.trim(), membership)}
        onClear={() => {
          setQuery('');
          navigate('', membership);
        }}
        searchLabel="按游戏名搜索"
        placeholder="输入游戏名"
      />
      <section
        className="home-section member-directory-results"
        aria-label="成员列表"
        aria-busy={resource.loading}
      >
        <MemberLoadState loading={resource.loading} error={resource.error} />
        {resource.data?.items.length === 0 ? (
          <MemberPaper>
            <div className="member-empty">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到匹配的成员" />
            </div>
          </MemberPaper>
        ) : null}
        {members ? (
          <div className="member-grid">
            {members.map((member) => {
              const href = `/members/${encodeURIComponent(member.id)}`;
              return (
                <HomeCardSurface key={member.id} motionProfile="feed">
                  <MemberPaper className="member-directory-card">
                    <div className="member-card-identity">
                      <Link
                        className="member-directory-avatar-link"
                        href={href}
                        aria-label={`${member.displayName || '成员'}的主页`}
                      >
                        <MemberAvatar member={member} size={60} />
                      </Link>
                      <div className="member-card-text">
                        <h3>
                          <Link data-home-card-link className="member-name-link" href={href}>
                            {member.displayName || '尚未填写游戏昵称'}
                          </Link>
                        </h3>
                        <p className="member-note member-directory-location">
                          <DailyToolbarIcon kind="server" />
                          {memberLocation(member)}
                        </p>
                        <p className="member-note member-directory-registered">
                          {member.registeredAt ? (
                            <time dateTime={member.registeredAt}>
                              注册于 {registrationFormat.format(new Date(member.registeredAt))}
                            </time>
                          ) : (
                            '尚无注册时间'
                          )}
                        </p>
                      </div>
                      <Tag
                        variant="solid"
                        color={member.membership === 'MEMBER' ? '#254B38' : '#D3972A'}
                        className="member-directory-membership"
                      >
                        {member.membership === 'MEMBER' ? '正式成员' : '其他亲友'}
                      </Tag>
                    </div>
                    <p className="member-card-bio">{member.bio || '暂未填写自我介绍'}</p>
                  </MemberPaper>
                </HomeCardSurface>
              );
            })}
          </div>
        ) : null}
        <ListPagination
          page={currentPage}
          totalPages={totalPages}
          loading={resource.loading || !!resource.error}
          onPageChange={(next) => setPage(Math.max(1, Math.min(next, totalPages)))}
          label="成员分页"
        />
      </section>
    </main>
  );
}
