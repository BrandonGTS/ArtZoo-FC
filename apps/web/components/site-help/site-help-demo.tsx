'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HelpLesson } from './help-content';
import './site-help-demo.css';
export default function SiteHelpDemo({
  lesson,
  current,
  onClose
}: {
  lesson: HelpLesson;
  current: number;
  onClose(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [target, setTarget] = useState<{
    current: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  useEffect(() => {
    const sync = () =>
      frame.current?.contentWindow?.postMessage(
        { type: 'help-step', lesson: lesson.lessonId, current },
        location.origin
      );
    const receive = (e: MessageEvent) => {
      if (
        e.origin !== location.origin ||
        e.source !== frame.current?.contentWindow ||
        e.data?.lesson !== lesson.lessonId
      )
        return;
      if (e.data.type === 'help-exit') {
        onClose();
        return;
      }
      if (e.data.type === 'help-focus') {
        document.querySelector<HTMLButtonElement>('.site-help-tour-section button:not(:disabled)')?.focus();
        return;
      }
      if (e.data.type !== 'help-target' || e.data.current !== current) return;
      const r = e.data.rect;
      const viewport = frame.current?.getBoundingClientRect();
      if (
        !viewport ||
        !r ||
        ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
        r.width <= 0 ||
        r.height <= 0
      ) {
        setTarget(null);
        return;
      }
      // Child bounds are iframe-viewport coordinates. Intersect with its actual
      // visible viewport before converting to the top-level fixed coordinate space.
      const left = Math.max(0, r.x),
        top = Math.max(0, r.y);
      const right = Math.min(viewport.width, r.x + r.width),
        bottom = Math.min(viewport.height, r.y + r.height);
      if (right <= left || bottom <= top) {
        setTarget(null);
        return;
      }
      const next = {
        current,
        x: viewport.left + left,
        y: viewport.top + top,
        width: right - left,
        height: bottom - top
      };
      setTarget((previous) =>
        previous?.current === next.current &&
        previous.x === next.x &&
        previous.y === next.y &&
        previous.width === next.width &&
        previous.height === next.height
          ? previous
          : next
      );
    };
    window.addEventListener('message', receive);
    sync();
    const timer = setInterval(sync, 300);
    return () => {
      window.removeEventListener('message', receive);
      clearInterval(timer);
    };
  }, [current, lesson.lessonId, onClose]);
  // The mask intentionally blocks example clicks, but must not trap scrolling
  // when a real page/card is taller than the viewport.
  useEffect(() => {
    const wheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest('.site-help-tour-section')) return;
      const bounds = frame.current?.getBoundingClientRect();
      if (
        !bounds ||
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
      frame.current?.contentWindow?.postMessage(
        {
          type: 'help-scroll',
          lesson: lesson.lessonId,
          current,
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
          deltaY: Math.max(-bounds.height, Math.min(bounds.height, event.deltaY * unit))
        },
        location.origin
      );
    };
    document.addEventListener('wheel', wheel, { passive: false });
    return () => document.removeEventListener('wheel', wheel);
  }, [current, lesson.lessonId]);
  // Tour retains the same proxy element while an iframe modal's entrance transform
  // changes its rectangle. Notify its measurement listener only after React commits
  // a genuinely changed proxy rectangle.
  useLayoutEffect(() => {
    const update = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    return () => cancelAnimationFrame(update);
  }, [target]);
  return (
    <div id="site-help-demo" className="site-help-demo">
      <iframe
        ref={frame}
        title="引导演示页面"
        src={'/help-demo?lesson=' + lesson.lessonId}
        sandbox="allow-scripts allow-same-origin"
      />
      {target?.current === current ? (
        <div
          className="site-help-demo-target"
          data-help-selector={lesson.steps[current]?.selector}
          style={{ left: target.x, top: target.y, width: target.width, height: target.height }}
        />
      ) : null}
    </div>
  );
}
