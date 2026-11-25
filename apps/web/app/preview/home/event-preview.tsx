import { Fragment } from 'react';
import { previewActivities } from '../activities/activities-preview-data';
import ActivityCardInfo from '../activities/activity-card-info';
import ActivityDetailDialog from '../activities/activity-detail-dialog';
import CardCarousel from './card-carousel';
import styles from './home-preview.module.css';

export default function EventPreview({ headingId }: { headingId: string }) {
  return (
    <CardCarousel headingId={headingId} cardName="活动卡片" slideClassName={styles.event}>
      {previewActivities.map((activity, index) => (
        <Fragment key={activity.id}>
          <div className={styles.cardHeader}>
            <h2 id={index === 0 ? headingId : undefined} aria-hidden={index !== 0}>
              下一场活动
            </h2>
            <ActivityDetailDialog activity={activity} />
          </div>
          <div className={styles.eventDetails}>
            <ActivityCardInfo activity={activity} heading="h3" />
          </div>
        </Fragment>
      ))}
    </CardCarousel>
  );
}
