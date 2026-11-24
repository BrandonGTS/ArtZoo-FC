import { toBeijingParts } from '@artzoo/domain';
import { PublisherFactIcon } from '../../../components/activities/publisher-fact-icon';
import { formatPreviewDuration, previewWeekdays, type PreviewActivity } from './activities-preview-data';
import styles from './activities-preview.module.css';

export default function ActivityCardInfo({
  activity,
  heading: Heading = 'h2'
}: {
  activity: PreviewActivity;
  heading?: 'h2' | 'h3';
}) {
  const date = toBeijingParts(activity.startsAt);

  return (
    <>
      <p className={styles.schedule}>
        <time dateTime={activity.startsAt}>
          {date.month} 月 {date.day} 日 / 周{previewWeekdays[(date.weekday + 6) % 7]} /{' '}
          {String(date.hour).padStart(2, '0')}:{String(date.minute).padStart(2, '0')}
        </time>
      </p>
      <Heading className={styles.activityTitle} title={activity.title}>
        {activity.title}
      </Heading>
      <ul className={styles.activityFacts} aria-label="活动信息" role="list">
        <li>
          <PublisherFactIcon kind="period" />
          <span>单次任务</span>
        </li>
        <li>
          <PublisherFactIcon kind="duty" />
          <span>{activity.location}</span>
        </li>
        <li>
          <PublisherFactIcon kind="duration" />
          <span>{formatPreviewDuration(activity.durationMinutes)}</span>
        </li>
        <li>
          <span className={styles.participantsIcon} aria-hidden="true" />
          <span>
            {activity.registeredCount} / {activity.capacity} 人
          </span>
        </li>
      </ul>
    </>
  );
}
