'use client';
import Image from 'next/image';
import { useRef, useState, useSyncExternalStore } from 'react';
import type { ComponentProps, CSSProperties } from 'react';
import { Carousel } from 'antd';
import type { PhotoView } from '../../server/albums/contract';
import { useSharingResource } from './sharing-api';
import { useFeedbackMessage } from '../use-feedback-message';
import { useEffect } from 'react';
import { PageArrowButton } from '../collection-controls';
import './guest-featured-carousel.css';

type Photo = Pick<PhotoView, 'id' | 'description' | 'width' | 'height' | 'previewUrl' | 'thumbnailUrl'>;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function subscribeMotion(listener: () => void) {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
type GuestArrowProps = {
  direction: 'previous' | 'next';
  className?: string;
  style?: CSSProperties;
  onClick?: ComponentProps<typeof PageArrowButton>['onClick'] | null;
};
function GuestCarouselArrow({ direction, className, style, onClick }: GuestArrowProps) {
  return (
    <div
      className={['collection-page-navigation', 'guest-featured-arrow', className].filter(Boolean).join(' ')}
      style={style}
    >
      <PageArrowButton
        direction={direction}
        label={direction === 'previous' ? '上一张精选照片' : '下一张精选照片'}
        disabled={!onClick}
        onClick={onClick ?? undefined}
      />
    </div>
  );
}
export default function GuestFeaturedCarousel() {
  const resource = useSharingResource<{ items: Photo[] }>('/api/albums/featured?page=1');
  const items = (resource.data?.items ?? []).slice(0, 6);
  const [focusPaused, setFocusPaused] = useState(false);
  const pointerFocusPending = useRef(false);
  const reduceMotion = useSyncExternalStore(subscribeMotion, reduced, () => true);
  const lastError = useRef<string | null>(null);
  const { notify, contextHolder } = useFeedbackMessage();
  useEffect(() => {
    if (resource.error && lastError.current !== resource.error) notify('error', resource.error);
    lastError.current = resource.error;
  }, [resource.error, notify]);
  const slide = (item: Photo) => (
    <div className="guest-featured-slide" key={item.id}>
      <Image
        className="guest-featured-image"
        unoptimized
        src={item.previewUrl}
        alt={item.description || '精选照片'}
        width={item.width}
        height={item.height}
      />
      {item.description ? <p>{item.description}</p> : null}
    </div>
  );
  return (
    <div
      className="guest-featured-carousel"
      onPointerDownCapture={() => {
        pointerFocusPending.current = true;
        setFocusPaused(false);
      }}
      onPointerLeave={() => {
        pointerFocusPending.current = false;
      }}
      onPointerUpCapture={() => {
        pointerFocusPending.current = false;
      }}
      onPointerCancelCapture={() => {
        pointerFocusPending.current = false;
      }}
      onKeyDownCapture={() => {
        pointerFocusPending.current = false;
        setFocusPaused(true);
      }}
      onFocusCapture={() => {
        // Native focus follows pointerdown before React state necessarily rerenders.
        const pointerFocused = pointerFocusPending.current;
        pointerFocusPending.current = false;
        setFocusPaused(!pointerFocused);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          pointerFocusPending.current = false;
          setFocusPaused(false);
        }
      }}
    >
      {contextHolder}
      {resource.loading ? (
        <p role="status">正在读取精选照片…</p>
      ) : items.length > 1 ? (
        <Carousel
          autoplay={!focusPaused && !reduceMotion}
          autoplaySpeed={8000}
          pauseOnHover={false}
          pauseOnFocus={false}
          arrows
          prevArrow={<GuestCarouselArrow direction="previous" />}
          nextArrow={<GuestCarouselArrow direction="next" />}
          dots
          draggable
        >
          {items.map(slide)}
        </Carousel>
      ) : items.length === 1 ? (
        slide(items[0]!)
      ) : (
        <p className="public-empty">暂无精选照片</p>
      )}
    </div>
  );
}
