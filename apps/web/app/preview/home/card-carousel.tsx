'use client';

import {
  Children,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState
} from 'react';
import styles from './home-preview.module.css';

type CardCarouselProps = {
  headingId?: string;
  cardName: string;
  slideClassName: string | undefined;
  markerLabels?: readonly string[];
  children: ReactNode;
};

type MouseDrag = {
  pointerId: number;
  startX: number;
  startOffset: number;
  startSlide: number;
};

function clampSlide(track: HTMLDivElement, index: number) {
  return Math.max(0, Math.min(track.childElementCount - 1, index));
}

function nearestSlide(track: HTMLDivElement) {
  const secondSlide = track.children.item(1);
  if (!(secondSlide instanceof HTMLElement) || secondSlide.offsetLeft === 0) return 0;

  return clampSlide(track, Math.round(track.scrollLeft / secondSlide.offsetLeft));
}

function scrollToSlide(track: HTMLDivElement, index: number, behavior: ScrollBehavior = 'auto') {
  const slide = track.children.item(clampSlide(track, index));
  if (slide instanceof HTMLElement) track.scrollTo({ left: slide.offsetLeft, behavior });
}

export default function CardCarousel({
  headingId,
  cardName,
  slideClassName,
  markerLabels,
  children
}: CardCarouselProps) {
  const keyboardHintId = useId();
  const slideCount = Children.count(children);
  const showMarkers = markerLabels !== undefined;
  const canSlide = slideCount > 1;
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<MouseDrag | null>(null);
  const [settledSlide, setSettledSlide] = useState<number | null>(null);
  const [activeMarker, setActiveMarker] = useState(0);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const settle = () => {
      if (dragRef.current) return;
      const index = nearestSlide(track);
      setSettledSlide((previous) => ((previous ?? 0) === index ? previous : index));
    };

    const hasScrollEnd = 'onscrollend' in track;
    const eventName = hasScrollEnd ? 'scrollend' : 'scroll';
    let timeout: number | undefined;
    const listener = hasScrollEnd
      ? settle
      : () => {
          window.clearTimeout(timeout);
          timeout = window.setTimeout(settle, 150);
        };

    let markerFrame: number | undefined;
    const updateMarker = () => {
      if (markerFrame !== undefined) return;
      markerFrame = window.requestAnimationFrame(() => {
        markerFrame = undefined;
        setActiveMarker(nearestSlide(track));
      });
    };

    track.addEventListener(eventName, listener);
    if (showMarkers) track.addEventListener('scroll', updateMarker, { passive: true });
    return () => {
      track.removeEventListener(eventName, listener);
      track.removeEventListener('scroll', updateMarker);
      if (markerFrame !== undefined) window.cancelAnimationFrame(markerFrame);
      window.clearTimeout(timeout);
    };
  }, [showMarkers]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const track = event.currentTarget;
    if (event.target !== track || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;

    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    scrollToSlide(track, nearestSlide(track) + step, 'instant');
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (!canSlide || event.pointerType !== 'mouse' || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button, a[href], dialog')) return;

    const track = event.currentTarget;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startOffset: track.scrollLeft,
      startSlide: nearestSlide(track)
    };
    track.setPointerCapture(event.pointerId);
    track.dataset.dragging = 'true';
    track.scrollTo({ left: track.scrollLeft, behavior: 'instant' });
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;

    const distance = drag.startX - event.clientX;
    event.currentTarget.scrollLeft = drag.startOffset + distance;
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;

    const track = event.currentTarget;
    const distance = drag.startX - event.clientX;
    const threshold = Math.min(48, track.clientWidth * 0.15);
    const step = event.type === 'pointerup' && Math.abs(distance) >= threshold ? Math.sign(distance) : 0;

    dragRef.current = null;
    delete track.dataset.dragging;
    scrollToSlide(track, drag.startSlide + step);
  }

  return (
    <section
      className={styles.cardCarousel}
      data-markers={showMarkers ? '' : undefined}
      aria-labelledby={headingId}
      aria-label={headingId ? undefined : cardName}
      aria-roledescription="轮播"
    >
      <div
        className={styles.cardTrack}
        ref={trackRef}
        role="group"
        aria-label={cardName}
        aria-describedby={canSlide ? keyboardHintId : undefined}
        tabIndex={canSlide ? 0 : undefined}
        onKeyDown={handleKeyDown}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
      >
        {Children.map(children, (slide, index) => (
          <div
            className={[styles.cardSlide, slideClassName].filter(Boolean).join(' ')}
            role="group"
            aria-roledescription="卡片"
            aria-label={'第 ' + (index + 1) + ' 张，共 ' + slideCount + ' 张'}
          >
            {slide}
          </div>
        ))}
      </div>
      {markerLabels && (
        <div className={styles.albumDots + ' ' + styles.cardMarkers} role="group" aria-label="选择卡片">
          {markerLabels.map((label, index) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              aria-current={index === activeMarker ? 'true' : undefined}
              onClick={() => {
                const track = trackRef.current;
                if (track) scrollToSlide(track, index);
              }}
            />
          ))}
        </div>
      )}
      {canSlide && (
        <span className={styles.cardAssistiveText} id={keyboardHintId}>
          使用左右方向键切换{cardName}
        </span>
      )}
      <span className={styles.cardAssistiveText} role="status">
        {settledSlide === null ? '' : `第 ${settledSlide + 1} 张${cardName}，共 ${slideCount} 张`}
      </span>
    </section>
  );
}
