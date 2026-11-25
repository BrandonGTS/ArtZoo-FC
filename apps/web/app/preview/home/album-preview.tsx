'use client';

import { Fragment, useEffect, useState, useSyncExternalStore } from 'react';
import styles from './home-preview.module.css';

const slides = [0, 1, 2];
const rotationInterval = 4500;
const reducedMotionQuery = '(prefers-reduced-motion: reduce)';

function subscribeToReducedMotion(listener: () => void) {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

export default function AlbumPreview() {
  const [{ activeSlide, previousSlide }, setSlides] = useState<{
    activeSlide: number;
    previousSlide: number | null;
  }>({ activeSlide: 0, previousSlide: null });
  const reduceMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(reducedMotionQuery).matches,
    () => true
  );

  useEffect(() => {
    if (reduceMotion) return;
    const timer = window.setTimeout(
      () =>
        setSlides({
          activeSlide: (activeSlide + 1) % slides.length,
          previousSlide: activeSlide
        }),
      rotationInterval
    );
    return () => window.clearTimeout(timer);
  }, [activeSlide, reduceMotion]);

  return (
    <article className={styles.album} aria-label="相册图片占位" aria-roledescription="轮播">
      <div className={styles.albumViewport}>
        <Fragment key={activeSlide}>
          {previousSlide !== null && (
            <div
              className={styles.albumSlide}
              data-slide={previousSlide}
              data-motion="out"
              aria-hidden="true"
            />
          )}
          <div
            className={styles.albumSlide}
            data-slide={activeSlide}
            data-motion={previousSlide === null ? undefined : 'in'}
            role="group"
            aria-roledescription="幻灯片"
            aria-label={`第 ${activeSlide + 1} 张，共 ${slides.length} 张`}
            onAnimationEnd={() =>
              setSlides((current) =>
                current.activeSlide === activeSlide ? { activeSlide, previousSlide: null } : current
              )
            }
          />
        </Fragment>
      </div>
      <div className={styles.albumDots} role="group" aria-label="选择图片">
        {slides.map((slide) => (
          <button
            key={slide}
            type="button"
            aria-label={`显示第 ${slide + 1} 张`}
            aria-current={slide === activeSlide ? 'true' : undefined}
            onClick={() => {
              setSlides((current) =>
                current.activeSlide === slide
                  ? current
                  : { activeSlide: slide, previousSlide: reduceMotion ? null : current.activeSlide }
              );
            }}
          />
        ))}
      </div>
      <span className={styles.albumStatus} aria-atomic="true" aria-live={reduceMotion ? 'polite' : 'off'}>
        第 {activeSlide + 1} 张，共 {slides.length} 张
      </span>
    </article>
  );
}
