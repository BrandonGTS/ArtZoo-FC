'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import SiteShell from '../site-shell';
import { helpScrollForSpace } from './help-placement';
import { visibleHelpTarget } from './help-target';
import { HELP_LESSONS } from './help-content';
import HomeDailyDemo from './modules/home-daily-demo';
import AlbumsDemo from './modules/albums-demo';
import ActivitiesDemo from './modules/activities-demo';
import WishesDemo from './modules/wishes-demo';
import LotteriesDemo from './modules/lotteries-demo';
import KnowledgeDemo from './modules/knowledge-demo';

const subscribe = () => () => {};
const clientEmbedded = () => window.parent !== window;
const serverEmbedded = () => false;
export default function DemoPage() {
  const embedded = useSyncExternalStore(subscribe, clientEmbedded, serverEmbedded);
  const [current, setCurrent] = useState(0);
  const lessonId =
    typeof window === 'undefined'
      ? 'home'
      : (new URLSearchParams(window.location.search).get('lesson') ?? 'home');
  const lesson = HELP_LESSONS.find((item) => item.lessonId === lessonId);
  useEffect(() => {
    if (!embedded || !lesson) return;
    const command = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== window.location.origin) return;
      const data = event.data;
      if (
        data?.type === 'help-make-space' &&
        data.lesson === lesson.lessonId &&
        data.current === current &&
        Number.isFinite(data.cardHeight) &&
        data.cardHeight > 0
      ) {
        const target = visibleHelpTarget(lesson.steps[current]?.selector ?? '');
        if (!target) return;
        let ancestor: Element | null = target;
        while (ancestor) {
          if (getComputedStyle(ancestor).position === 'fixed') return;
          ancestor = ancestor.parentElement;
        }
        const bounds = target.getBoundingClientRect();
        const scrolling = document.scrollingElement;
        if (!scrolling) return;
        const next = helpScrollForSpace({
          target: bounds,
          viewport: { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
          scrollTop: scrolling.scrollTop,
          maxScroll: scrolling.scrollHeight - innerHeight,
          cardHeight: data.cardHeight
        });
        if (next !== null) window.scrollTo({ top: next, behavior: 'instant' });
        return;
      }
      if (
        data?.type === 'help-scroll' &&
        data.lesson === lesson.lessonId &&
        data.current === current &&
        [data.x, data.y, data.deltaY].every(Number.isFinite)
      ) {
        let element = document.elementFromPoint(data.x, data.y);
        while (element && element !== document.documentElement) {
          if (
            /auto|scroll/.test(getComputedStyle(element).overflowY) &&
            element.scrollHeight > element.clientHeight
          ) {
            element.scrollBy({ top: data.deltaY, behavior: 'instant' });
            return;
          }
          element = element.parentElement;
        }
        window.scrollBy({ top: data.deltaY, behavior: 'instant' });
        return;
      }
      if (
        data?.type === 'help-step' &&
        data.lesson === lesson.lessonId &&
        Number.isInteger(data.current) &&
        data.current >= 0 &&
        data.current < lesson.steps.length
      )
        setCurrent(data.current);
    };
    window.addEventListener('message', command);
    window.parent.postMessage({ type: 'help-ready', lesson: lesson.lessonId }, window.location.origin);
    return () => window.removeEventListener('message', command);
  }, [embedded, lesson, current]);
  useEffect(() => {
    if (!embedded || !lesson) return;
    let disposed = false;
    let scrolled: Element | null = null;
    let previous = '';
    let cachedTarget: HTMLElement | null = null,
      dirty = true;
    const invalidate = () => {
      dirty = true;
    };
    const observer = new MutationObserver(invalidate);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden']
    });
    document.addEventListener('transitionend', invalidate, true);
    document.addEventListener('animationend', invalidate, true);
    window.addEventListener('resize', invalidate);
    const report = () => {
      if (disposed) return;
      let target: HTMLElement | null = null;
      try {
        if (dirty || !cachedTarget?.isConnected) {
          cachedTarget = visibleHelpTarget(lesson.steps[current]?.selector ?? '');
          dirty = false;
        }
        target = cachedTarget;
      } catch {
        /* Parent keeps confirm disabled when missing. */
      }
      let rect = null;
      if (target && target.isConnected) {
        let bounds = target.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0) {
          if (scrolled !== target && (bounds.top < 0 || bounds.bottom > window.innerHeight)) {
            target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
            scrolled = target;
            bounds = target.getBoundingClientRect();
          }
          rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        }
      }
      const signature = JSON.stringify({ rect, width: window.innerWidth, height: window.innerHeight });
      if (signature !== previous) {
        previous = signature;
        window.parent.postMessage(
          { type: 'help-target', lesson: lesson.lessonId, current, rect },
          window.location.origin
        );
      }
    };
    // Track real layout/scroll/modal animation each frame; only changed bounds
    // cross the bridge. A 250ms poll visibly lags resizing and entrance motion.
    let animation = 0;
    const tick = () => {
      report();
      animation = window.requestAnimationFrame(tick);
    };
    tick();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(animation);
      observer.disconnect();
      document.removeEventListener('transitionend', invalidate, true);
      document.removeEventListener('animationend', invalidate, true);
      window.removeEventListener('resize', invalidate);
    };
  }, [embedded, lesson, current]);
  if (!embedded || !lesson)
    return (
      <main className="home-content">
        <p>请从网站使用帮助打开引导。</p>
      </main>
    );
  return (
    <SiteShell navigationPath={lesson.path}>
      {lesson.lessonId === 'home' || lesson.lessonId === 'daily' ? (
        <HomeDailyDemo lessonId={lesson.lessonId} current={current} />
      ) : lesson.lessonId === 'albums' ? (
        <AlbumsDemo current={current} />
      ) : lesson.lessonId === 'activities' ? (
        <ActivitiesDemo current={current} />
      ) : lesson.lessonId === 'wishes' ? (
        <WishesDemo current={current} />
      ) : lesson.lessonId === 'lotteries' ? (
        <LotteriesDemo current={current} />
      ) : (
        <KnowledgeDemo current={current} />
      )}
    </SiteShell>
  );
}
