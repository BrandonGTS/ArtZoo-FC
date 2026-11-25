import DailyPreviewFeed from './daily-preview-feed';
import styles from './daily-preview.module.css';

export default function DailyPreviewContent() {
  return (
    <div className={styles.daily}>
      <DailyPreviewFeed />
    </div>
  );
}
