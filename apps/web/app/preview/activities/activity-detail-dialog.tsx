'use client';

import { DUTY_TYPE_LABELS, toBeijingParts, toBeijingPicker } from '@artzoo/domain';
import { type CSSProperties, useId, useRef } from 'react';
import type { PreviewActivity } from './activities-preview-data';
import styles from './activity-detail-dialog.module.css';

function clockTime(instant: string) {
  return toBeijingPicker(instant).slice(11);
}

function ActivityDateTime({ instant }: { instant: string }) {
  const { month, day } = toBeijingParts(instant);

  return (
    <time dateTime={instant}>
      <span>
        {month} 月 {day} 日
      </span>{' '}
      <span>{clockTime(instant)}</span>
    </time>
  );
}

export default function ActivityDetailDialog({ activity }: { activity: PreviewActivity }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const start = Date.parse(activity.startsAt);
  const endsAt = new Date(start + activity.durationMinutes * 60_000).toISOString();
  const artworkStyle = activity.artwork
    ? ({ '--detail-artwork': `url("${activity.artwork}")` } as CSSProperties)
    : undefined;

  return (
    <>
      <button
        className={styles.trigger}
        type="button"
        aria-haspopup="dialog"
        aria-label={'活动详情：' + activity.title}
        onClick={() => {
          const dialog = dialogRef.current;
          if (!dialog) return;
          dialog.showModal();
          dialog.scrollTop = 0;
        }}
      >
        活动详情
      </button>
      <dialog className={styles.dialog} ref={dialogRef} aria-labelledby={titleId}>
        <form method="dialog" className={styles.toolbar}>
          <button className={styles.close} type="submit" aria-label="关闭活动详情" autoFocus />
        </form>
        <header className={styles.header} style={artworkStyle}>
          <div className={styles.heading}>
            <p className={styles.type}>单次任务</p>
            <h2 id={titleId}>{activity.title}</h2>
          </div>
        </header>
        <div className={styles.body}>
          <div className={styles.info}>
            <section className={styles.section}>
              <h3>基本信息</h3>
              <dl className={styles.facts}>
                <div>
                  <dt>{activity.dutyType ? '具体副本' : '活动地点'}</dt>
                  <dd>{activity.location}</dd>
                </div>
                {activity.dutyType && (
                  <div>
                    <dt>副本类型</dt>
                    <dd>{DUTY_TYPE_LABELS[activity.dutyType]}</dd>
                  </div>
                )}
                <div>
                  <dt>{activity.dutyType ? '队伍构成' : '人数上限'}</dt>
                  <dd>
                    {activity.capacity} 人{activity.dutyType ? '小队' : ''}
                  </dd>
                </div>
              </dl>
            </section>
            <section className={styles.section}>
              <h3>
                时间信息 <span>北京时间</span>
              </h3>
              <dl className={styles.facts}>
                <div>
                  <dt>开始时间</dt>
                  <dd>
                    <ActivityDateTime instant={activity.startsAt} />
                  </dd>
                </div>
                <div>
                  <dt>结束时间</dt>
                  <dd>
                    <ActivityDateTime instant={endsAt} />
                  </dd>
                </div>
                <div>
                  <dt>报名截止时间</dt>
                  <dd>
                    <ActivityDateTime instant={activity.registrationClosesAt} />
                  </dd>
                </div>
              </dl>
            </section>
            <section className={styles.section}>
              <h3>活动安排</h3>
              <ol className={styles.agenda} role="list">
                {activity.agenda.map(({ minutesAfterStart, description }) => {
                  const instant = new Date(start + minutesAfterStart * 60_000).toISOString();
                  return (
                    <li key={minutesAfterStart}>
                      <time dateTime={instant}>{clockTime(instant)}</time>
                      <span>{description}</span>
                    </li>
                  );
                })}
              </ol>
            </section>
            <section className={styles.section}>
              <h3>参与要求</h3>
              <p>{activity.requirements}</p>
            </section>
          </div>
          <section className={styles.participation}>
            <h3>活动参与</h3>
            <p className={styles.count}>
              <strong>
                {activity.registeredCount} / {activity.capacity}
              </strong>{' '}
              <span>人已报名</span>
            </p>
            <div className={styles.seats} aria-hidden="true">
              {Array.from({ length: activity.capacity }, (_, index) => (
                <span
                  key={index}
                  className={index < activity.registeredCount ? styles.filledSeat : styles.emptySeat}
                />
              ))}
            </div>
            <button className={styles.register} type="button" disabled>
              报名参加活动
            </button>
          </section>
        </div>
      </dialog>
    </>
  );
}
