'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button, Card, Empty } from 'antd';
import { isAwaitingSeriesRoster } from '@artzoo/domain';
import type { ActivityList, ActivitySummary } from '@artzoo/domain';
import { useAuthSession } from './auth-session';
import { accountRequest, errorDetail } from './account/api';
import { ActivityAvatars, beijingDate, beijingFull, beijingTime } from './activities/activity-ui';
import { ActivityTypeTag } from './activities/activity-type-tag';
import HomeCardSurface, { HomeCardNavigationSurface } from './home-card-surface';
import './home-activities.css';

function monthDay(value: string, includeYear = false) {
  const [year, month, day] = beijingDate(value).split('-');
  return `${includeYear ? `${year}年` : ''}${Number(month)}月${Number(day)}日`;
}

function HomeActivityFactIcon({ kind }: { kind: 'period' | 'duty' | 'location' }) {
  return (
    <svg
      className="home-activity-fact-icon"
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.67"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'period' ? (
        <>
          <path d="M3 4h14v13H3zM6 2v4M14 2v4M3 8h14M7 11h6M7 14h4" />
        </>
      ) : null}
      {kind === 'duty' ? (
        <>
          <path d="M3 17h14M5 17V6l5-3 5 3v11M8 17v-5h4v5M8 7h.01M12 7h.01" />
        </>
      ) : null}
      {kind === 'location' ? (
        <>
          <path d="M16 8c0 4-6 9-6 9S4 12 4 8a6 6 0 1 1 12 0Z" />
          <circle cx="10" cy="8" r="2" />
        </>
      ) : null}
    </svg>
  );
}

export function HomeActivityCard({
  activity,
  motion = true
}: {
  activity: ActivitySummary;
  motion?: boolean;
}) {
  const sameDay = beijingDate(activity.startsAt) === beijingDate(activity.endsAt);
  const crossYear = beijingDate(activity.startsAt).slice(0, 4) !== beijingDate(activity.endsAt).slice(0, 4);
  const contentName = activity.scene === 'OFFLINE' ? activity.location : activity.duty?.name;
  const participants = activity.participants.slice(0, 6);
  const remaining = Math.max(0, activity.registeredCount - participants.length);
  const card = (
    <Card
      variant="borderless"
      classNames={{ root: 'paper-panel paper-activity home-activity-card', body: 'home-activity-card-body' }}
    >
      <div className="home-activity-title">
        <ActivityTypeTag
          type={activity.mode === 'SERIES' ? 'long-term' : 'single'}
          scene={activity.scene}
          mode={activity.mode}
        />
        <h3>
          <Link data-home-card-link href={`/activities/${activity.id}`}>
            {activity.title}
          </Link>
        </h3>
      </div>
      <p className="activity-note home-activity-fact">
        <HomeActivityFactIcon kind="period" />
        <span>
          {activity.series ? (
            <>
              第{activity.series.periodNumber} / {activity.series.totalPeriods}期
            </>
          ) : (
            '单次任务'
          )}
        </span>
      </p>
      {contentName ? (
        <p className="activity-note home-activity-context home-activity-fact" title={contentName}>
          <HomeActivityFactIcon kind={activity.scene === 'OFFLINE' ? 'location' : 'duty'} />
          <span>{contentName}</span>
        </p>
      ) : null}
      <p
        className="home-activity-time"
        title={`${beijingFull(activity.startsAt)} - ${beijingFull(activity.endsAt)}（北京时间）`}
      >
        <Image src="/artzoo/icons/calendar-days.svg" alt="" width={20} height={20} unoptimized />
        <span>
          <time dateTime={activity.startsAt}>
            {monthDay(activity.startsAt, crossYear)} · {beijingTime(activity.startsAt)}
          </time>
          {' - '}
          <time dateTime={activity.endsAt}>
            {!sameDay && `${monthDay(activity.endsAt, crossYear)} `}
            {beijingTime(activity.endsAt)}
          </time>
        </span>
      </p>
      <div className="home-activity-participants">
        <div className="home-activity-count">
          <Image src="/artzoo/icons/users.svg" alt="" width={20} height={20} unoptimized />
          <span>
            {isAwaitingSeriesRoster(activity)
              ? '待首期成团'
              : activity.capacityUnlimited
                ? `${activity.registeredCount} 人 · 不限人数`
                : `${activity.registeredCount} / ${activity.capacity} 人`}
          </span>
        </div>
        {(participants.length > 0 || remaining > 0) && (
          <div
            className="home-activity-people"
            aria-label={`已报名 ${activity.registeredCount} 人，显示 ${participants.length} 位成员`}
          >
            {participants.length > 0 && <ActivityAvatars participants={participants} />}
            {remaining > 0 && (
              <span className="home-activity-more" aria-label={`另有 ${remaining} 位已报名成员`}>
                +{remaining}
              </span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
  return motion ? (
    <HomeCardSurface>{card}</HomeCardSurface>
  ) : (
    <HomeCardNavigationSurface>{card}</HomeCardNavigationSurface>
  );
}

const stateClasses = {
  root: 'paper-panel paper-activity home-activities-state',
  body: 'paper-panel-body home-activities-state-body'
};

export default function HomeActivities() {
  const { session, loading, error: sessionError, openLogin } = useAuthSession();
  const userId = session?.user?.id;
  const [result, setResult] = useState<{ userId: string; data?: ActivityList; error?: string } | null>(null);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    accountRequest<ActivityList>('/api/activities?upcoming=1', { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ userId, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setResult({ userId, error: errorDetail(error).message });
      });
    return () => controller.abort();
  }, [userId]);
  const current = result?.userId === userId ? result : null;
  if (loading || (userId && !current))
    return (
      <Card variant="borderless" classNames={stateClasses}>
        <p role="status">正在读取活动…</p>
      </Card>
    );
  if (!userId)
    return (
      <Card variant="borderless" classNames={stateClasses}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={sessionError || '登录后查看近期活动'}>
          {!sessionError && <Button onClick={() => openLogin('/')}>登录</Button>}
        </Empty>
      </Card>
    );
  if (current?.error)
    return (
      <Card variant="borderless" classNames={stateClasses}>
        <p role="alert">{current.error}</p>
      </Card>
    );
  const items =
    current?.data?.items
      .filter(
        (item) =>
          item.status === 'OPEN' &&
          (!item.series || (item.series.periodNumber === 1 && item.series.state === 'RECRUITING'))
      )
      .slice(0, 3) ?? [];
  if (!items.length)
    return (
      <Card variant="borderless" classNames={stateClasses}>
        <p>
          暂无可参与活动 · <Link href="/activities">查看正式活动</Link>
        </p>
      </Card>
    );
  return items.map((item) => <HomeActivityCard key={item.id} activity={item} />);
}
