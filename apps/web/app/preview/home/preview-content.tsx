import PreviewHeader from '../preview-header';
import type { PreviewPage } from '../preview-pages';
import AlbumPreview from './album-preview';
import EventPreview from './event-preview';
import styles from './home-preview.module.css';
import WishPreview from './wish-preview';

export default function PreviewContent({ pane }: { pane: PreviewPage['id'] | 'transition' }) {
  return (
    <div className={styles.content}>
      <PreviewHeader announcement="部队相册欢迎投稿，带上你旅途中最喜欢的一帧。">
        <div className={styles.hero}>
          <div className={styles.titleGroup}>
            <h1 className={styles.title} lang="en">
              Sample <em>Journal</em>
            </h1>
          </div>
          <p className={styles.subtitle}>公会手记</p>
        </div>
      </PreviewHeader>

      <section className={styles.features} aria-label="公会精选">
        <AlbumPreview />

        <div className={styles.featureStack}>
          <EventPreview headingId={pane + '-event-heading'} />

          <WishPreview headingId={pane + '-wish-heading'} />
        </div>
      </section>
    </div>
  );
}
