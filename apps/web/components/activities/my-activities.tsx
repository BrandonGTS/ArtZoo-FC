'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Tabs } from 'antd';
import { ListPagination } from '../collection-controls';
import { isAwaitingSeriesRoster } from '@artzoo/domain';
import type {
  ActivityPeriod,
  ActivitySummary,
  MyActivities as MyActivitiesData,
  MyActivitiesPagination
} from '@artzoo/domain';
import { useActivityResource } from './use-activity-resource';
import Image from 'next/image';
import { HomeCardNavigationSurface } from '../home-card-surface';
import { PublisherFactIcon } from './publisher-fact-icon';
import {
  ActivityHeading,
  ActivityLoadState,
  ActivityPaper,
  RequirementIcon,
  beijingDate,
  beijingTime
} from './activity-ui';
import { ActivityTypeTag } from './activity-type-tag';
import './my-activities.css';

function activityDay(value: string) {
  const [, month, day] = beijingDate(value).split('-');
  return `${Number(month)}月${Number(day)}日`;
}

function activityTimeRange(activity: ActivitySummary) {
  return (
    <>
      <time dateTime={activity.startsAt}>{beijingTime(activity.startsAt)}</time> -{' '}
      <time dateTime={activity.endsAt}>{beijingTime(activity.endsAt)}</time>
    </>
  );
}

function RegisteredActivity({ activity }: { activity: ActivitySummary }) {
  const content = activity.scene === 'OFFLINE' ? activity.location : activity.duty?.name;
  const participation = activity.myParticipation;
  const inactive =
    activity.status === 'CANCELLED' || participation?.status === 'CANCELLED'
      ? '已取消'
      : participation?.status === 'WITHDRAWN'
        ? '已退出'
        : null;
  const job = inactive ? null : (activity.myRegistration?.job ?? participation?.job);
  const registered = !!activity.myRegistration || participation?.status === 'ACTIVE';
  return (
    <HomeCardNavigationSurface>
      <ActivityPaper className="my-activity-row">
        <div className="my-activity-date">
          <time dateTime={activity.startsAt}>{activityDay(activity.startsAt)}</time>
          <span className="my-activity-time-range">{activityTimeRange(activity)}</span>
        </div>
        <div className="my-activity-summary">
          <div className="activity-title-row">
            <ActivityTypeTag scene={activity.scene} mode={activity.mode} />
            <h3>
              <Link data-home-card-link href={'/activities/' + activity.id}>
                {activity.title}
              </Link>
            </h3>
          </div>
        </div>
        <div className="my-activity-fact" title={content || undefined}>
          <PublisherFactIcon kind={activity.scene === 'OFFLINE' ? 'location' : 'duty'} />
          <span>{content || '—'}</span>
        </div>
        <div className="my-activity-fact">
          <Image src="/artzoo/icons/users.svg" alt="" width={20} height={20} unoptimized />
          <span>
            {isAwaitingSeriesRoster(activity)
              ? '成团后锁定名单'
              : activity.capacityUnlimited
                ? activity.registeredCount + ' 人 · 不限人数'
                : activity.registeredCount + ' / ' + activity.capacity + ' 人'}
          </span>
        </div>
        <div className="my-activity-fact my-activity-registration" aria-label="我的报名">
          {job ? (
            <>
              <RequirementIcon value={{ kind: 'JOB', job }} />
              <span>{job}</span>
            </>
          ) : (
            <span>{inactive ?? (registered ? '已报名' : '未报名')}</span>
          )}
        </div>
      </ActivityPaper>
    </HomeCardNavigationSurface>
  );
}

function PeriodActivities({
  id,
  pagination,
  loading,
  onPeriodChange,
  onPageChange,
  children
}: {
  id: string;
  pagination: MyActivitiesPagination;
  loading: boolean;
  onPeriodChange(period: ActivityPeriod): void;
  onPageChange(page: number): void;
  children: React.ReactNode;
}) {
  return (
    <div className="collection-filterbar">
      <Tabs
        id={id}
        activeKey={pagination.period}
        className="collection-tabs my-activities-period-tabs"
        type="line"
        animated={{ inkBar: true, tabPane: false }}
        indicator={{ align: 'center' }}
        classNames={{
          header: 'collection-tabs-header my-activities-period-header',
          content: 'my-activities-period-panel',
          indicator: 'collection-tabs-indicator my-activities-period-indicator'
        }}
        onChange={(key) => {
          if (key === 'current' || key === 'history') onPeriodChange(key);
        }}
        items={(['current', 'history'] as const).map((period) => ({
          key: period,
          label: period === 'current' ? '当前活动' : '历史活动',
          disabled: loading,
          children:
            period === pagination.period ? (
              <div className="my-activities-period-content" aria-busy={loading}>
                {children}
                {pagination.totalPages > 1 ? (
                  <ListPagination
                    page={pagination.page}
                    totalPages={pagination.totalPages}
                    loading={loading}
                    onPageChange={onPageChange}
                    label="我的活动分页"
                  />
                ) : null}
              </div>
            ) : null
        }))}
      />
    </div>
  );
}

export default function MyActivities() {
  const [reload, setReload] = useState(0);
  const [registeredPeriod, setRegisteredPeriod] = useState<ActivityPeriod>('current');
  const [registeredPage, setRegisteredPage] = useState(1);
  const query = new URLSearchParams({
    registeredPeriod,
    registeredPage: String(registeredPage),
    refresh: String(reload)
  });
  const resource = useActivityResource<MyActivitiesData>(`/api/me/activities?${query}`, {
    keepPreviousData: true
  });
  const data = resource.data;
  return (
    <main className="home-content activities-content my-activities-content" id="main-content">
      <ActivityHeading title="我的活动" />
      <ActivityLoadState
        loading={resource.loading && !data}
        error={resource.error}
        retry={() => setReload((value) => value + 1)}
      />
      {data ? (
        <div className="my-activities-layout">
          {resource.loading ? (
            <span className="my-activities-refresh-status" role="status">
              正在读取活动…
            </span>
          ) : null}
          <section className="home-section my-activities-registered" aria-label="我参与的活动">
            <PeriodActivities
              id="my-registered-period"
              pagination={data.registeredPagination}
              loading={resource.loading}
              onPeriodChange={(period) => {
                setRegisteredPeriod(period);
                setRegisteredPage(1);
              }}
              onPageChange={setRegisteredPage}
            >
              {data.registered.length ? (
                data.registered.map((activity) => (
                  <RegisteredActivity key={activity.id} activity={activity} />
                ))
              ) : (
                <p className="activity-note my-activities-empty">
                  {data.registeredPagination.period === 'history' ? '暂无历史参与记录' : '暂无当前参与的活动'}
                </p>
              )}
            </PeriodActivities>
          </section>
        </div>
      ) : null}
    </main>
  );
}
