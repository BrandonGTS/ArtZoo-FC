'use client';
import { Button } from 'antd';
import { useState } from 'react';
import { CursorPagination } from '../collection-controls';
import { TEAM_POSITIONS, type TeamHistoryPage } from '@artzoo/domain';
import { useAuthSession } from '../auth-session';
import { useActivityResource } from '../activities/use-activity-resource';
import { ActivityHeading, ActivityLoadState, beijingFull, beijingTime } from '../activities/activity-ui';
import { PageHeading } from '../home-content';
import { TeamPaper } from './team-ui';
import { ParticipationLog, participationStatus } from './team-participation-records';
export default function TeamHistoryPage() {
  const { session } = useAuthSession();
  return session?.user ? <OwnedHistory key={session.user.id} /> : null;
}
function OwnedHistory() {
  const [page, setPage] = useState(1),
    [retry, setRetry] = useState(0),
    resource = useActivityResource<TeamHistoryPage>(
      `/api/me/teams/history?pagination=1&page=${page}&retry=${retry}`
    );
  const states: Record<string, string> = {
      PROPOSED: '待确认',
      CONFIRMED: '已确认',
      CANCELLED: '已取消',
      TIME_CHANGED: '时间已调整'
    },
    participation: Record<string, string> = {
      MEMBER: '队员',
      NEEDS_SUBSTITUTE: '待补位',
      LEAVE: '请假',
      SUBSTITUTE: '临时补位'
    };
  return (
    <main className="home-content teams-content" id="main-content">
      <ActivityHeading title="参与历史">
        <Button href="/me/teams">我的队伍</Button>
      </ActivityHeading>
      <ActivityLoadState
        loading={resource.loading}
        error={resource.error}
        retry={() => setRetry((value) => value + 1)}
      />
      {resource.error ? (
        <div className="team-actions">
          <Button type="text" onClick={() => setRetry((value) => value + 1)}>
            重试
          </Button>
        </div>
      ) : null}
      {!resource.loading && !resource.error && !resource.data?.items.length ? <p>暂无参与记录。</p> : null}
      {resource.data?.items.map((team) => (
        <TeamPaper key={team.teamId}>
          <section className="team-stack">
            <PageHeading decoration="tomato">
              {team.teamName}
              {team.teamState === 'DISSOLVED' ? ' · 已解散' : ''}
            </PageHeading>
            {!team.sessions.length ? (
              <p>暂无本人的场次记录。</p>
            ) : (
              team.sessions.map((s) => (
                <section className="team-history-row" key={s.id}>
                  <p>
                    {beijingFull(s.startsAt)}–{beijingTime(s.endsAt)} · {states[s.state] ?? s.state}
                  </p>
                  <p>
                    {TEAM_POSITIONS[s.position]} · {s.job} ·{' '}
                    {s.records[0] ? participationStatus[s.records[0].status] : participation[s.participation]}
                  </p>
                  {s.reason ? <p className="team-description">原请假：{s.reason}</p> : null}
                  <ParticipationLog records={s.records} />
                </section>
              ))
            )}
          </section>
        </TeamPaper>
      ))}
      <CursorPagination
        page={page}
        hasMore={resource.data?.hasMore ?? false}
        loading={resource.loading}
        onPageChange={setPage}
        label="参与历史分页"
      />
    </main>
  );
}
