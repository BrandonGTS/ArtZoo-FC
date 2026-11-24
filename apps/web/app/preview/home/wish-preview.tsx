import { Fragment } from 'react';
import CardCarousel from './card-carousel';
import styles from './home-preview.module.css';

const wishes = ['这是一条测试心愿', '想约大家拍部队合照', '想给部队小屋添绿植'];

export default function WishPreview({ headingId }: { headingId: string }) {
  return (
    <CardCarousel headingId={headingId} cardName="心愿卡片" slideClassName={styles.wish}>
      {wishes.map((wish, index) => (
        <Fragment key={wish}>
          <div>
            <h2 id={index === 0 ? headingId : undefined} aria-hidden={index !== 0}>
              心愿板
            </h2>
            <p>{wish}</p>
            <span className={styles.actionLabel}>
              更多心愿 <span className={styles.arrow} aria-hidden="true" />
            </span>
          </div>
          <div className={styles.wishArt} aria-hidden="true" />
        </Fragment>
      ))}
    </CardCarousel>
  );
}
