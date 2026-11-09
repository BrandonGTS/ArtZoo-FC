'use client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ActiveAnnouncements } from '../../server/announcements/contract';
import './announcements.css';
export default function AnnouncementBar() {
  const [items, setItems] = useState<ActiveAnnouncements['items']>([]);
  useEffect(() => {
    let disposed = false,
      request: AbortController | null = null;
    async function refresh() {
      if (document.visibilityState !== 'visible') return;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const response = await fetch('/api/announcements/active', {
          cache: 'no-store',
          credentials: 'omit',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
        });
        const result = await response.json();
        if (
          !disposed &&
          !controller.signal.aborted &&
          response.ok &&
          result.ok === true &&
          Array.isArray(result.data?.items) &&
          result.data.items.every(
            (item: { id?: unknown; text?: unknown }) =>
              typeof item.id === 'string' && typeof item.text === 'string'
          )
        )
          setItems(result.data.items);
      } catch {
        /* Retain the last readable announcement on a transient failure. */
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 60000);
    const activate = () => void refresh();
    window.addEventListener('focus', activate);
    window.addEventListener('artzoo:announcements-updated', activate);
    document.addEventListener('visibilitychange', activate);
    return () => {
      disposed = true;
      request?.abort();
      clearInterval(timer);
      window.removeEventListener('focus', activate);
      window.removeEventListener('artzoo:announcements-updated', activate);
      document.removeEventListener('visibilitychange', activate);
    };
  }, []);
  return items.length ? (
    <AnnouncementMarquee key={items.map((item) => item.id).join(':')} items={items} />
  ) : null;
}
function AnnouncementMarquee({ items }: ActiveAnnouncements) {
  const lane = useRef<HTMLDivElement>(null),
    group = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ width: 0, duration: 30 });
  useEffect(() => {
    if (!lane.current || !group.current) return;
    let disposed = false;
    const measure = () => {
      if (disposed || !lane.current || !group.current) return;
      const width = lane.current!.clientWidth;
      const distance = Math.max(group.current!.scrollWidth, width);
      setMetrics((previous) =>
        previous.width === width && previous.duration === distance / 38
          ? previous
          : { width, duration: distance / 38 }
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(lane.current);
    observer.observe(group.current);
    measure();
    void document.fonts.ready.then(measure);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, []);
  const content = items.map((item) => (
    <span className="announcement-marquee-item" key={item.id}>
      {item.text}
    </span>
  ));
  return (
    <aside className="announcement-bar" aria-label="站点公告">
      <div className="announcement-bar-inner">
        <span className="announcement-label">公告</span>
        <div
          className="announcement-lane"
          ref={lane}
          style={
            {
              '--announcement-lane-width': `${metrics.width}px`,
              '--announcement-duration': `${metrics.duration}s`
            } as CSSProperties
          }
        >
          <div className="announcement-track">
            <div className="announcement-group" ref={group}>
              {content}
            </div>
            <div className="announcement-group announcement-copy" aria-hidden="true">
              {content}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
