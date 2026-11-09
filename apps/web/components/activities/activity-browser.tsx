'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, ConfigProvider, Grid, Popover, Table, theme } from 'antd';
import { isAwaitingSeriesRoster } from '@artzoo/domain';
import type { ActivityList, ActivitySummary } from '@artzoo/domain';
import { useActivityResource } from './use-activity-resource';
import { ActivityTypeTag } from './activity-type-tag';
import { getActivityTypeAppearance } from './activity-type-appearance';
import './activity-calendar.css';
import {
  OfficialCalendarLegend,
  OfficialDayCard,
  OfficialDayMarker,
  officialOnDay,
  useOfficialCalendar
} from '../official-events/official-calendar';
import { useAuthSession } from '../auth-session';
import { splitActivityDescription } from './activity-description';
import { PageHeading } from '../home-content';
import {
  ActivityAvatars,
  ActivityHeading,
  ActivityPaper,
  beijingDate,
  beijingFull,
  beijingTime,
  categoryLabels,
  statusLabels
} from './activity-ui';

const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
function monthDays(month: string) {
  const first = new Date(month + '-01T00:00:00Z');
  const firstWeekday = first.getUTCDay();
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(first);
    day.setUTCDate(1 - firstWeekday + index);
    return day.toISOString().slice(0, 10);
  });
}
function shiftMonth(month: string, offset: number) {
  const date = new Date(month + '-01T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}
function ActivityPreviewDescription({ description }: { description: string }) {
  const { arrangement, requirements } = splitActivityDescription(description);
  return (
    <div className="activity-preview-description">
      <section className="activity-preview-copy-section" aria-label="活动安排">
        <p>活动安排：</p>
        <p className="activity-preview-arrangement">{arrangement || '暂无活动说明'}</p>
      </section>
      {requirements !== null ? (
        <section className="activity-preview-copy-section" aria-label="参与要求">
          <p>参与要求：</p>
          <p className="activity-preview-requirements">{requirements}</p>
        </section>
      ) : null}
    </div>
  );
}
export default function ActivityBrowser({ initialDay }: { initialDay: string }) {
  const screens = Grid.useBreakpoint();
  const { token } = theme.useToken();
  const { session, loading: sessionLoading } = useAuthSession();
  const [month, setMonth] = useState(initialDay.slice(0, 7));
  const [selected, setSelected] = useState(initialDay);
  // Keep the list renderer available for a future entry point.
  const [mode] = useState<'calendar' | 'list'>('calendar');
  const [preview, setPreview] = useState<string | null>(null);
  const resource = useActivityResource<ActivityList>(
    `/api/activities?month=${month}${mode === 'calendar' ? '&calendar=1' : ''}`,
    { keepPreviousData: true }
  );
  const displayedMonth = resource.dataPath
    ? new URLSearchParams(resource.dataPath.split('?')[1]).get('month') || month
    : month;
  const owner =
    !sessionLoading && session?.user
      ? [session.user.id, session.user.membership, session.user.adminRole].join(':')
      : null;
  const calendarDays = monthDays(displayedMonth);
  const selectedDay = selected;
  const selectedInGrid = calendarDays.includes(selectedDay);
  const official = useOfficialCalendar(displayedMonth, mode === 'calendar', owner);
  // Manual month navigation preserves the selected day, including days outside this grid.
  const selectedCalendar = useOfficialCalendar(
    selectedDay.slice(0, 7),
    mode === 'calendar' && !selectedInGrid,
    owner
  );
  const selectedOfficial = selectedInGrid ? official : selectedCalendar;
  const items = resource.data?.items || [];
  const groups = new Map<string, ActivitySummary[]>();
  for (const item of items.filter((item) => !item.cancelledAt && item.status !== 'CANCELLED')) {
    const day = beijingDate(item.startsAt);
    groups.set(day, [...(groups.get(day) || []), item]);
  }
  function navigateMonth(offset: number) {
    setMonth((current) => shiftMonth(current, offset));
    setPreview(null);
  }
  function selectDay(day: string) {
    setSelected(day);
    setPreview(null);
  }
  const monthNavigation = (
    <div className="activity-month-navigation" role="group" aria-label="切换月份">
      <Button
        type="text"
        aria-label="上一月"
        onClick={() => navigateMonth(-1)}
        icon={
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="m14 5-7 7 7 7"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        }
      />
      <h3>
        {displayedMonth.slice(0, 4)}年{Number(displayedMonth.slice(5))}月
      </h3>
      <Button
        type="text"
        aria-label="下一月"
        onClick={() => navigateMonth(1)}
        icon={
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="m10 5 7 7-7 7"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        }
      />
    </div>
  );
  const statusMessage = resource.loading
    ? `正在读取 ${month} 的活动…${resource.data ? `当前显示 ${displayedMonth}` : ''}`
    : resource.error
      ? `${month}：${resource.error}${resource.data ? `（当前仍显示 ${displayedMonth}）` : ''}`
      : '';
  const dayOfficial =
    selectedOfficial.loading || selectedOfficial.error
      ? []
      : selectedOfficial.items
          .filter((item) => officialOnDay(item, selectedDay))
          .sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt));
  const loadState = (
    <div className="activity-browser-status">
      <p className="activity-note" role="status" title={statusMessage}>
        {statusMessage}
      </p>
    </div>
  );
  return (
    <main className="home-content activities-content activity-calendar-browser" id="main-content">
      <div className="activity-calendar-page-heading">
        <ActivityHeading title="正式活动" />
        <div className="activity-day-heading">
          <PageHeading decoration="tomato">当前进行</PageHeading>
        </div>
      </div>
      {mode === 'calendar' ? (
        <div className="activity-calendar-layout">
          <ActivityPaper className="activity-calendar-paper">
            <div className="activity-calendar-toolbar">
              {monthNavigation}
              {session?.user?.membership === 'MEMBER' ? (
                <Button
                  type="primary"
                  size="large"
                  className="activity-calendar-publish"
                  href="/activities/new"
                >
                  发起正式活动
                </Button>
              ) : null}
            </div>
            <OfficialCalendarLegend />
            {loadState}
            {official.error ? (
              <div className="official-calendar-load-state">
                <p className="activity-note" role="alert">
                  {official.error}
                </p>
              </div>
            ) : null}
            <div className="activity-calendar-weekdays">
              {weekdays.map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div
              className="activity-calendar-grid"
              aria-label={`${displayedMonth} 活动月历`}
              aria-busy={resource.loading}
            >
              {Array.from({ length: 6 }, (_, weekIndex) => {
                const week = weekIndex * 7;
                return (
                  <div className="activity-calendar-week" key={calendarDays[week]}>
                    {calendarDays.slice(week, week + 7).map((day) => {
                      const dayItems = groups.get(day) || [];
                      const more = Math.max(0, dayItems.length - 2);
                      return (
                        <div
                          key={day}
                          className={`activity-calendar-day${day.slice(0, 7) !== displayedMonth ? ' activity-outside-month' : ''}${selectedDay === day ? ' activity-day-selected' : ''}`}
                        >
                          <div className="activity-calendar-date-heading">
                            <Button
                              type="text"
                              className={`activity-day-number${day === initialDay ? ' activity-today' : ''}`}
                              aria-label={`选择 ${day}`}
                              aria-pressed={selectedDay === day}
                              onClick={() => selectDay(day)}
                            >
                              {Number(day.slice(8))}
                            </Button>
                          </div>
                          {dayItems.slice(0, 2).map((activity) => (
                            <Popover
                              key={activity.id}
                              trigger="click"
                              placement={screens.md === false ? 'bottom' : 'bottomLeft'}
                              arrow={false}
                              open={preview === activity.id}
                              onOpenChange={(open) => setPreview(open ? activity.id : null)}
                              classNames={{ container: 'activity-preview-popover' }}
                              content={
                                <div className="activity-preview">
                                  <div className="activity-preview-heading">
                                    <div className="activity-title-row">
                                      <ActivityTypeTag scene={activity.scene} mode={activity.mode} />
                                      <h3>{activity.title}</h3>
                                    </div>
                                    <Button
                                      type="text"
                                      aria-label="关闭活动浮窗"
                                      onClick={() => setPreview(null)}
                                    >
                                      ×
                                    </Button>
                                  </div>
                                  <p>
                                    {beijingFull(activity.startsAt)} ·{' '}
                                    {isAwaitingSeriesRoster(activity)
                                      ? '待首期成团'
                                      : statusLabels[activity.status]}
                                  </p>
                                  <div className="activity-participants">
                                    <span>
                                      {isAwaitingSeriesRoster(activity) ? (
                                        '成团后锁定名单'
                                      ) : (
                                        <>
                                          {activity.registeredCount}/
                                          {activity.capacityUnlimited ? '不限人数' : `${activity.capacity}人`}
                                        </>
                                      )}
                                    </span>
                                    <ActivityAvatars participants={activity.participants} />
                                  </div>
                                  <ActivityPreviewDescription description={activity.description} />
                                  <Button type="primary" href={`/activities/${activity.id}`}>
                                    查看详情
                                  </Button>
                                </div>
                              }
                            >
                              <Button
                                className="activity-calendar-event"
                                title={`${getActivityTypeAppearance(token, activity).label} · ${activity.title}`}
                                style={{
                                  backgroundColor: getActivityTypeAppearance(token, activity).color,
                                  borderColor: getActivityTypeAppearance(token, activity).color,
                                  color: token.colorWhite
                                }}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <span>{activity.title}</span>
                                <small>
                                  {beijingTime(activity.startsAt)}
                                  {isAwaitingSeriesRoster(activity)
                                    ? ' · 待首期成团'
                                    : activity.status === 'FULL'
                                      ? ' · 满员'
                                      : ''}
                                </small>
                              </Button>
                            </Popover>
                          ))}
                          {dayItems.length > 0 ? (
                            <Popover
                              trigger="click"
                              arrow={false}
                              placement={screens.md === false ? 'bottom' : 'bottomLeft'}
                              align={screens.md === false ? { offset: [0, 0] } : undefined}
                              open={preview === `day:${day}`}
                              onOpenChange={(open) => {
                                if (open) selectDay(day);
                                setPreview(open ? `day:${day}` : null);
                              }}
                              classNames={{ container: 'activity-calendar-overflow-popover' }}
                              content={
                                <div className="activity-calendar-overflow">
                                  <div className="activity-preview-heading">
                                    <h3>
                                      {Number(day.slice(5, 7))}月{Number(day.slice(8))}日 · 活动
                                    </h3>
                                    <Button
                                      type="text"
                                      aria-label="关闭当天活动浮窗"
                                      onClick={() => setPreview(null)}
                                    >
                                      ×
                                    </Button>
                                  </div>
                                  <div className="activity-calendar-overflow-list">
                                    {dayItems.map((activity) => (
                                      <Link
                                        key={activity.id}
                                        href={`/activities/${activity.id}`}
                                        className="activity-calendar-overflow-item"
                                      >
                                        <div className="activity-title-row">
                                          <ActivityTypeTag scene={activity.scene} mode={activity.mode} />
                                          <span>{activity.title}</span>
                                        </div>
                                        <span className="activity-note">
                                          {beijingTime(activity.startsAt)} — {beijingTime(activity.endsAt)} ·{' '}
                                          {isAwaitingSeriesRoster(activity)
                                            ? '待首期成团'
                                            : statusLabels[activity.status]}
                                        </span>
                                      </Link>
                                    ))}
                                  </div>
                                </div>
                              }
                            >
                              <Button
                                type="link"
                                size="small"
                                className={`activity-calendar-more${more === 0 ? ' activity-calendar-more-compact-only' : ''}`}
                                title={`查看当天全部${dayItems.length}项活动`}
                                aria-label={`${day}：${dayItems.length}项活动`}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <span className="activity-calendar-more-expanded">还有{more}项</span>
                                <span className="activity-calendar-more-compact">{dayItems.length}项</span>
                              </Button>
                            </Popover>
                          ) : null}
                          <OfficialDayMarker day={day} items={official.items} />
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </ActivityPaper>
          <aside
            className="home-section activity-day-aside"
            aria-label={`${selectedDay} 进行中的官方活动`}
            aria-busy={selectedOfficial.loading}
            data-selected-day={selectedDay}
          >
            <div className="activity-current-mobile-heading">
              <PageHeading decoration="tomato">当前进行</PageHeading>
            </div>
            {selectedOfficial.loading ? (
              <p className="activity-note" role="status">
                正在读取所选日期的官方活动…
              </p>
            ) : null}
            {selectedOfficial.error ? (
              <div className="official-calendar-load-state">
                <p className="activity-note" role="alert">
                  {selectedOfficial.error}
                </p>
              </div>
            ) : null}
            {!selectedOfficial.loading && !selectedOfficial.error && !dayOfficial.length ? (
              <p className="activity-note">
                {Number(selectedDay.slice(5, 7))}月{Number(selectedDay.slice(8))}日暂无进行中的官方活动
              </p>
            ) : null}
            {dayOfficial.map((event) => (
              <OfficialDayCard key={event.id} event={event} day={selectedDay} />
            ))}
          </aside>
        </div>
      ) : (
        <>
          <div className="activity-list-toolbar">
            <span>
              {displayedMonth.slice(0, 4)}年{Number(displayedMonth.slice(5))}月 · 北京时间
            </span>
            {monthNavigation}
            {loadState}
          </div>
          <ActivityPaper>
            <ConfigProvider
              theme={{
                components: {
                  Table: {
                    headerBg: 'transparent',
                    rowHoverBg: '#E4EBD8',
                    colorBgContainer: 'transparent',
                    headerSplitColor: 'transparent',
                    cellPaddingBlock: 20
                  }
                }
              }}
            >
              <Table<ActivitySummary>
                rowKey="id"
                dataSource={items}
                pagination={false}
                scroll={{ x: 940 }}
                loading={resource.loading}
                locale={{ emptyText: resource.error ? '暂时无法读取活动' : '这个月还没有活动' }}
                columns={[
                  {
                    title: '活动',
                    key: 'title',
                    width: '24%',
                    render: (_, activity) => (
                      <div>
                        <div className="activity-title-row">
                          <ActivityTypeTag scene={activity.scene} mode={activity.mode} />
                          <h4>{activity.title}</h4>
                        </div>
                        <p className="activity-note">
                          {activity.scene === 'OFFLINE'
                            ? activity.location || '线下活动'
                            : categoryLabels[activity.category]}
                          {activity.series
                            ? ` · 第${activity.series.periodNumber}/${activity.series.totalPeriods}期`
                            : ''}{' '}
                          · {activity.organizer.displayName || '成员'}
                        </p>
                      </div>
                    )
                  },
                  {
                    title: '时间',
                    key: 'time',
                    width: '22%',
                    render: (_, activity) => (
                      <span>
                        {beijingFull(activity.startsAt)}—
                        {beijingDate(activity.endsAt) === beijingDate(activity.startsAt)
                          ? beijingTime(activity.endsAt)
                          : beijingFull(activity.endsAt)}
                      </span>
                    )
                  },
                  {
                    title: '参与成员',
                    key: 'participants',
                    width: '27%',
                    render: (_, activity) => (
                      <div className="activity-participants">
                        <span>
                          {isAwaitingSeriesRoster(activity) ? (
                            '成团后锁定名单'
                          ) : (
                            <>
                              {activity.registeredCount}/
                              {activity.capacityUnlimited ? '不限人数' : `${activity.capacity}人`}
                            </>
                          )}
                        </span>
                        <ActivityAvatars participants={activity.participants} />
                      </div>
                    )
                  },
                  {
                    title: '状态',
                    key: 'status',
                    width: '16%',
                    render: (_, activity) => (
                      <span className={`activity-status-${activity.status.toLowerCase()}`}>
                        {isAwaitingSeriesRoster(activity) ? '待首期成团' : statusLabels[activity.status]}
                      </span>
                    )
                  },
                  {
                    title: '操作',
                    key: 'action',
                    render: (_, activity) => (
                      <Link className="activity-text-link" href={`/activities/${activity.id}`}>
                        查看活动
                      </Link>
                    )
                  }
                ]}
              />
            </ConfigProvider>
          </ActivityPaper>
        </>
      )}
    </main>
  );
}
