'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';

const DESKTOP_HEADER = '(min-width: 984px)';
const FIXED_TOP = 4;

// The marker belongs to the original, stable slot, never the moving header.
// Exporting the controller permits boundary/cleanup checks without a browser.
export function observeCompactHeader(marker: HTMLElement, onChange: (compact: boolean) => void) {
  const desktop = window.matchMedia(DESKTOP_HEADER);
  let compact = false;
  let frame: number | undefined;
  let disposed = false;

  const update = (next: boolean) => {
    if (!disposed && compact !== next) {
      compact = next;
      onChange(next);
    }
  };
  const measure = () => update(desktop.matches && marker.getBoundingClientRect().bottom <= FIXED_TOP);
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            const entry = entries.find((item) => item.target === marker);
            if (entry) update(desktop.matches && entry.boundingClientRect.bottom <= FIXED_TOP);
          },
          { rootMargin: '-4px 0px 0px 0px', threshold: 0 }
        );

  const onScroll = () => {
    if (frame !== undefined) return;
    frame = window.requestAnimationFrame(() => {
      frame = undefined;
      measure();
    });
  };
  const onViewportChange = () => {
    observer?.disconnect();
    if (desktop.matches) observer?.observe(marker);
    measure();
  };

  desktop.addEventListener('change', onViewportChange);
  // Supported browsers need no scroll listener; fallback still batches reads.
  if (!observer) {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
  }
  onViewportChange();

  return () => {
    disposed = true;
    observer?.disconnect();
    desktop.removeEventListener('change', onViewportChange);
    if (!observer) {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    }
    if (frame !== undefined) window.cancelAnimationFrame(frame);
  };
}

export function useCompactHeader(onLayoutChange: () => void) {
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const [compact, setCompact] = useState(false);
  const onChange = useEffectEvent((next: boolean) => {
    setCompact(next);
    onLayoutChange();
  });

  useEffect(() => {
    if (!sentinelRef.current) return;
    return observeCompactHeader(sentinelRef.current, onChange);
  }, []);

  return { compact, sentinelRef };
}
