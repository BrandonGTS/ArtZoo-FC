'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { Tabs, Tag, Tooltip } from 'antd';
import type { MemberProfile } from '@artzoo/domain';
import { useResource } from '../account/use-resource';
import { PageHeading } from '../home-content';
import { useAuthSession } from '../auth-session';
import DailyToolbarIcon from '../daily/daily-toolbar-icon';
import { MemberAvatar, MemberLoadState, MemberPaper, memberLocation } from './member-ui';
import { JOB_GROUPS } from './job-catalog';
import { MemberProfileSettings } from './profile-editor';
import MemberDaily from './member-daily';
import MemberRecruitments from './member-recruitments';
import MemberShares from './member-shares';
import '../collection-controls.css';

export default function MemberHome({ id }: { id: string }) {
  const { session } = useAuthSession(),
    actor = session?.user;
  return actor ? (
    <MemberHomeContent
      key={[actor.id, actor.membership, actor.adminRole, id].join(':')}
      id={id}
      own={actor.id === id}
    />
  ) : null;
}

function MemberHomeContent({ id, own }: { id: string; own: boolean }) {
  const router = useRouter(),
    search = useSearchParams();
  const requestedTab = search.get('tab') ?? 'role';
  const tab = ['role', 'daily', 'guides', 'recruitments', ...(own ? ['settings'] : [])].includes(requestedTab)
    ? requestedTab
    : 'role';
  const resource = useResource<MemberProfile>(`/api/members/${encodeURIComponent(id)}`);
  const [saved, setSaved] = useState<MemberProfile | null>(null);
  const member = saved ?? resource.data;
  const prefix = own ? '我的' : 'TA的';
  const tabs = [
    { key: 'role', label: '角色信息' },
    { key: 'daily', label: prefix + '动态' },
    { key: 'guides', label: prefix + '分享' },
    { key: 'recruitments', label: prefix + '招募' },
    ...(own ? [{ key: 'settings', label: '个人设置' }] : [])
  ];
  function changeTab(key: string) {
    const params = new URLSearchParams(search);
    if (key === 'role') params.delete('tab');
    else params.set('tab', key);
    router.replace(`/members/${encodeURIComponent(id)}${params.size ? '?' + params : ''}`, { scroll: false });
  }
  return (
    <main className="home-content members-content member-home-page" id="main-content">
      <PageHeading level={1} decoration="burger">
        个人主页
      </PageHeading>
      <MemberLoadState loading={resource.loading} error={resource.error} />
      {member ? (
        <>
          <MemberPaper variant="profile" className="member-home-identity">
            <div className="member-home-avatar">
              <MemberAvatar member={member} size={112} />
            </div>
            <div className="member-home-person">
              <div className="member-home-name">
                <h2>{member.displayName || '尚未填写游戏昵称'}</h2>
                <Tag
                  variant="solid"
                  color={member.membership === 'MEMBER' ? '#254B38' : '#D3972A'}
                  className="member-home-membership"
                >
                  {member.membership === 'MEMBER' ? '正式成员' : '其他亲友'}
                </Tag>
              </div>
              <p className="member-note member-home-location">
                <DailyToolbarIcon kind="server" />
                {memberLocation(member)}
              </p>
              <p className="member-home-bio">{member.bio || '暂未填写自我介绍'}</p>
            </div>
          </MemberPaper>
          <div className="collection-filterbar member-home-tabbar">
            <Tabs
              className="collection-tabs"
              activeKey={tab}
              type="line"
              animated={{ inkBar: true, tabPane: false }}
              indicator={{ align: 'center' }}
              classNames={{
                header: 'collection-tabs-header',
                indicator: 'collection-tabs-indicator',
                body: 'collection-tabs-body'
              }}
              items={tabs}
              onChange={changeTab}
            />
          </div>
          <div
            className="member-home-tab-content"
            role="tabpanel"
            aria-label={tabs.find((item) => item.key === tab)?.label}
          >
            {tab === 'role' ? (
              <MemberPaper variant="profile" className="member-role-card">
                <section className="member-role-section" aria-labelledby="member-jobs-heading">
                  <h3 id="member-jobs-heading">擅长的职业</h3>
                  <div className="member-role-jobs">
                    {JOB_GROUPS.map((group) => (
                      <div
                        key={group.label}
                        className="member-role-job-row"
                        role="group"
                        aria-label={group.label}
                      >
                        <div className="member-role-job-icons">
                          {group.jobs
                            .filter((job) => member.commonJobs.includes(job.name))
                            .map((job) => (
                              <Tooltip key={job.name} title={job.name} trigger={['hover', 'focus']}>
                                <span
                                  className="member-role-job"
                                  tabIndex={0}
                                  role="img"
                                  aria-label={job.name}
                                >
                                  <Image src={job.icon} alt="" width={56} height={56} unoptimized />
                                </span>
                              </Tooltip>
                            ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="member-role-section" aria-labelledby="member-playstyles-heading">
                  <h3 id="member-playstyles-heading">喜欢的玩法</h3>
                  <p>{member.preferredPlaystyles.join('、') || '暂未填写'}</p>
                </section>
              </MemberPaper>
            ) : null}
            {tab === 'daily' ? <MemberDaily key={id} authorId={id} /> : null}
            {tab === 'guides' ? <MemberShares key={id} authorId={id} /> : null}
            {tab === 'recruitments' ? <MemberRecruitments key={id} authorId={id} /> : null}
            {tab === 'settings' && own ? <MemberProfileSettings initial={member} onSaved={setSaved} /> : null}
          </div>
        </>
      ) : null}
    </main>
  );
}
