import homeStyles from '../home/home-preview.module.css';
import PreviewHeader from '../preview-header';
import ActivitiesCalendar from './activities-calendar';
import styles from './activities-preview.module.css';

export default function ActivitiesPreviewContent() {
  return (
    <div className={homeStyles.pageContent}>
      <PreviewHeader announcement="部队合照请提前到海雾村的部队小屋集合。">
        <hgroup className={homeStyles.hero + ' ' + homeStyles.pageHeading}>
          <h1 className={homeStyles.title} lang="en">
            Guild <em>Events</em>
          </h1>
          <p className={homeStyles.subtitle}>活动广场</p>
        </hgroup>
      </PreviewHeader>

      <ActivitiesCalendar />

      <div className={styles.reserve} aria-hidden="true">
        <div />
        <div />
        <div />
      </div>
    </div>
  );
}
