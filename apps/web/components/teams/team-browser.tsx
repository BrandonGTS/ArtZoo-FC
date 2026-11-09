'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Button, Card } from 'antd';
import type { TeamList, TeamSummary } from '@artzoo/domain';
import { useAuthSession } from '../auth-session';
import { useActivityResource } from '../activities/use-activity-resource';
import { ActivityHeading, ActivityLoadState, RequirementIcon } from '../activities/activity-ui';
import { ListPagination } from '../collection-controls';
import HomeCardSurface from '../home-card-surface';
import { TeamAuthor, TeamFact, TeamCompactRoster } from './team-ui';
import TeamWorkspace from './team-workspace';
import '../home-activities.css';

function TeamRecruitmentCard({ team }: { team: TeamSummary }) {
  const needs = team.seats.filter((s) => !s.member).slice(0, 8);
  return (
    <HomeCardSurface motionProfile="feed">
      <Card
        variant="borderless"
        classNames={{
          root: 'paper-panel paper-activity home-activity-card team-recruitment-card',
          body: 'home-activity-card-body team-recruitment-body'
        }}
      >
        <TeamAuthor person={team.creator} />
        <div className="home-activity-title team-recruitment-title">
          <h3>
            <Link data-home-card-link href={'/teams/' + team.id} title={team.name}>
              {team.name}
            </Link>
          </h3>
        </div>
        <TeamFact kind="duty" value={team.dutyName} />
        <TeamFact kind="progress" label="进度" value={team.progress} />
        <TeamFact kind="strategy" label="攻略" value={team.strategy} />
        <TeamFact kind="time" label="时间" value={team.commonTimes} />
        <div className="team-current-composition">
          <p>当前构成</p>
          <TeamCompactRoster seats={team.seats} />
        </div>
        <div className="team-required-jobs">
          <span>需求职业</span>
          <div aria-label="需求职业">
            {needs.map((s) => (
              <span
                key={s.id}
                title={
                  s.requirement.kind === 'JOB'
                    ? s.requirement.job
                    : s.requirement.kind === 'ROLE'
                      ? { TANK: '防护', HEALER: '治疗', DAMAGE: '输出' }[s.requirement.role]
                      : '不限'
                }
              >
                <RequirementIcon value={s.requirement} />
              </span>
            ))}
          </div>
        </div>
      </Card>
    </HomeCardSurface>
  );
}
export default function TeamBrowser({ mine = false }: { mine?: boolean }) {
  const { session } = useAuthSession(),
    [selected, setSelected] = useState<string>(),
    [page, setPage] = useState(1),
    [reload, setReload] = useState(0),
    [requested, setRequested] = useState(false),
    resource = useActivityResource<TeamList>(
      mine ? '/api/me/teams?refresh=' + reload : '/api/teams?page=' + page + '&refresh=' + reload,
      { userInitiated: requested || reload > 0 }
    ),
    items = resource.data?.items ?? [];
  if (mine && items.length)
    return (
      <TeamWorkspace
        id={items.some((t) => t.id === selected) ? selected! : items[0]!.id}
        choices={items}
        userInitiated={requested}
        onSelect={(id) => {
          setRequested(true);
          setSelected(id);
        }}
        onExit={() => setReload((v) => v + 1)}
      />
    );
  return (
    <main className="home-content teams-content" id="main-content">
      <ActivityHeading title={mine ? '我的队伍' : '队伍招募'}>
        <div className="team-actions">
          {session?.user?.membership === 'MEMBER' ? (
            <Button type="primary" href="/teams/new">
              创建固定队
            </Button>
          ) : null}
        </div>
      </ActivityHeading>
      <ActivityLoadState
        loading={resource.loading}
        error={resource.error}
        retry={() => {
          setRequested(true);
          setReload((v) => v + 1);
        }}
      />
      {!resource.loading && !resource.error && !items.length ? (
        <p>{mine ? '暂无已完成招募且由你创建或加入的固定队。' : '暂无正在招募的固定队。'}</p>
      ) : null}
      <div className="team-list">
        {items.map((team) => (
          <TeamRecruitmentCard key={team.id} team={team} />
        ))}
      </div>
      {!mine && resource.data ? (
        <ListPagination
          page={resource.data.page}
          totalPages={resource.data.totalPages}
          loading={resource.loading}
          label="队伍招募分页"
          onPageChange={(value) => {
            setRequested(true);
            setPage(value);
          }}
        />
      ) : null}
    </main>
  );
}
