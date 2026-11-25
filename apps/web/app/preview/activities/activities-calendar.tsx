'use client';

import { beijingDateKey, toBeijingParts } from '@artzoo/domain';
import { useState } from 'react';
import CardCarousel from '../home/card-carousel';
import homeStyles from '../home/home-preview.module.css';
import { previewActivities, previewWeekdays, type PreviewActivity } from './activities-preview-data';
import ActivityCardInfo from './activity-card-info';
import ActivityDetailDialog from './activity-detail-dialog';
import styles from './activities-preview.module.css';

const monthNames = [
  '一月',
  '二月',
  '三月',
  '四月',
  '五月',
  '六月',
  '七月',
  '八月',
  '九月',
  '十月',
  '十一月',
  '十二月'
];

const activitiesByDay = new Map<string, PreviewActivity[]>();
for (const activity of previewActivities) {
  const day = beijingDateKey(activity.startsAt);
  activitiesByDay.set(day, [...(activitiesByDay.get(day) ?? []), activity]);
}
const nextActivity = previewActivities[0];
const nextActivityDay = beijingDateKey(nextActivity.startsAt);
const { year: initialYear, month: initialMonth } = toBeijingParts(nextActivity.startsAt);

function calendarWeeks(month: Date) {
  const mondayOffset = (month.getUTCDay() + 6) % 7;
  return Array.from({ length: 6 }, (_, weekIndex) =>
    previewWeekdays.map((_, weekdayIndex) => {
      const date = new Date(month);
      date.setUTCDate(1 - mondayOffset + weekIndex * 7 + weekdayIndex);
      return date;
    })
  );
}

function ActivitySlide({ activity }: { activity: PreviewActivity }) {
  return (
    <>
      <div
        className={styles.activityCover}
        style={activity.artwork ? { backgroundImage: `url("${activity.artwork}")` } : undefined}
      >
        <ActivityDetailDialog activity={activity} />
      </div>
      <div className={styles.activityDetails}>
        <ActivityCardInfo activity={activity} />
      </div>
    </>
  );
}

function ActivityCard({ day, items = [] }: { day?: string; items?: readonly PreviewActivity[] }) {
  const [firstActivity] = items;

  return (
    <div className={styles.activityCard}>
      <span className={homeStyles.cardAssistiveText} role="status">
        {firstActivity ? `当天共 ${items.length} 场活动，第一场是${firstActivity.title}` : '本月暂无活动'}
      </span>
      {firstActivity ? (
        <CardCarousel
          key={day}
          cardName="当天活动"
          slideClassName={styles.activitySlide}
          markerLabels={items.map(
            (activity, index) => `显示第 ${index + 1} 场，共 ${items.length} 场，${activity.title}`
          )}
        >
          {items.map((activity) => (
            <ActivitySlide key={activity.id} activity={activity} />
          ))}
        </CardCarousel>
      ) : (
        <div className={styles.activitySlide}>
          <div className={styles.activityCover} aria-hidden="true" />
          <div className={styles.activityDetails}>
            <h2>本月暂无活动</h2>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ActivitiesCalendar() {
  const [{ month, selectedDay }, setCalendar] = useState<{ month: Date; selectedDay?: string }>({
    month: new Date(Date.UTC(initialYear, initialMonth - 1, 1)),
    selectedDay: nextActivityDay
  });
  const monthNumber = month.getUTCMonth();
  const year = month.getUTCFullYear();

  function navigateMonth(offset: number) {
    setCalendar((current) => {
      const nextMonth = new Date(current.month);
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + offset);
      const monthKey = nextMonth.toISOString().slice(0, 7);
      const firstActivityDay = [...activitiesByDay.keys()].find((day) => day.startsWith(monthKey));
      return { month: nextMonth, selectedDay: firstActivityDay };
    });
  }

  return (
    <div className={styles.activityLayout}>
      <section className={styles.calendar}>
        <div className={styles.calendarHeader}>
          <h2>
            {monthNames[monthNumber]} <span>{year}</span>
          </h2>
          <div className={styles.monthControls}>
            <button type="button" aria-label="上一月" onClick={() => navigateMonth(-1)}>
              <span className={styles.previous} aria-hidden="true" />
            </button>
            <button type="button" aria-label="下一月" onClick={() => navigateMonth(1)}>
              <span className={styles.next} aria-hidden="true" />
            </button>
          </div>
        </div>
        <table className={styles.monthTable} aria-label={`${year}年${monthNumber + 1}月活动月历`}>
          <thead>
            <tr>
              {previewWeekdays.map((day) => (
                <th key={day} scope="col" abbr={`周${day}`}>
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calendarWeeks(month).map((week, weekIndex) => (
              <tr key={weekIndex}>
                {week.map((date) => {
                  const key = date.toISOString().slice(0, 10);
                  const isCurrentMonth = date.getUTCMonth() === monthNumber;
                  const dayActivities = isCurrentMonth ? activitiesByDay.get(key) : undefined;
                  const day = date.getUTCDate();
                  return (
                    <td key={key}>
                      {dayActivities ? (
                        <button
                          className={styles.eventDay}
                          type="button"
                          aria-label={`${monthNumber + 1}月${day}日，${dayActivities.map(({ title }) => title).join('、')}`}
                          aria-pressed={selectedDay === key}
                          onClick={() => setCalendar({ month, selectedDay: key })}
                        >
                          {day}
                        </button>
                      ) : (
                        <time className={isCurrentMonth ? undefined : styles.adjacentDay} dateTime={key}>
                          {day}
                        </time>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.legend}>当天有活动</p>
      </section>
      <ActivityCard day={selectedDay} items={selectedDay ? activitiesByDay.get(selectedDay) : undefined} />
    </div>
  );
}
