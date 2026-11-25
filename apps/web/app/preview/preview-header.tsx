import type { ReactNode } from 'react';
import styles from './home/home-preview.module.css';

export default function PreviewHeader({
  announcement,
  children
}: {
  announcement: string;
  children: ReactNode;
}) {
  return (
    <header className={styles.pageHeader}>
      <div className={styles.topActions}>
        <button type="button" disabled>
          联系我们
        </button>
        <button className={styles.login} type="button" disabled>
          登录
        </button>
      </div>
      <dl className={styles.announcement}>
        <dt>公告</dt>
        <dd>{announcement}</dd>
      </dl>
      {children}
    </header>
  );
}
