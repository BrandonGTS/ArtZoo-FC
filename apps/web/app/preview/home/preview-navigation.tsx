'use client';

import { usePathname, useRouter } from 'next/navigation';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import { type PreviewPage, previewPages } from '../preview-pages';
import styles from './home-preview.module.css';
import PreviewSidebar, { getPreviewNavControl } from './preview-sidebar';

const wheelThreshold = 480;
const wheelGestureGap = 180;
const hintMinimumTime = 200;
const hintIdleDelay = 1500;
const scrollableScreenClassName = styles.previewScreen + ' ' + styles.previewScrollbar;

function screenClassName(page: PreviewPage) {
  return page.id === 'daily' || page.id === 'activities' || page.id === 'album'
    ? scrollableScreenClassName
    : styles.previewScreen;
}

type PreviewNavigationProps = {
  children: ReactNode;
  placeholder: ReactNode;
  pagePreviews: Partial<Record<PreviewPage['id'], ReactNode>>;
};
type Presentation = {
  page: PreviewPage;
  hint: PreviewPage | null;
  revealed: boolean;
  destination: PreviewPage | null;
};

export default function PreviewNavigation({ children, placeholder, pagePreviews }: PreviewNavigationProps) {
  const pathname = usePathname();
  const router = useRouter();
  const pageIndex = Math.max(
    0,
    previewPages.findIndex(({ href }) => href === pathname)
  );
  const page = previewPages[pageIndex] ?? previewPages[0];
  const rootRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const highlightRef = useRef<HTMLSpanElement>(null);
  const viewportRef = useRef<HTMLElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const incomingRef = useRef<HTMLDivElement>(null);
  const navigation = useRef<{ destination: PreviewPage; rollback: number } | null>(null);
  const wheel = useRef({
    target: null as PreviewPage | null,
    revealedAt: 0,
    distance: 0,
    lastAt: 0,
    consumed: false
  });
  const hintTimer = useRef<number | undefined>(undefined);
  const [presentation, setPresentation] = useState<Presentation>({
    page,
    hint: null,
    revealed: false,
    destination: null
  });

  // Clear the transient presentation before painting a different URL, including history navigation.
  if (presentation.page !== page) {
    setPresentation({ page, hint: null, revealed: false, destination: null });
  }

  const closeHint = useCallback(() => {
    window.clearTimeout(hintTimer.current);
    if (navigation.current) return;
    if (!wheel.current.target) return;
    wheel.current.target = null;
    wheel.current.distance = 0;
    rootRef.current?.style.removeProperty('--wheel-progress');
    setPresentation((current) => ({ ...current, revealed: false }));
  }, []);

  const moveTo = useCallback(
    (destination: PreviewPage) => {
      if (navigation.current) return;
      const screen = screenRef.current;
      if (destination === page) {
        closeHint();
        screen?.scrollTo({ top: 0 });
        return;
      }

      window.clearTimeout(hintTimer.current);
      if (screen?.contains(document.activeElement)) {
        getPreviewNavControl(navRef.current, destination)?.focus({ preventScroll: true });
      }

      const rollback = window.setTimeout(() => {
        navigation.current = null;
        closeHint();
        setPresentation((current) => ({ ...current, destination: null }));
      }, 8000);
      navigation.current = { destination, rollback };
      setPresentation((current) => ({ ...current, destination }));
    },
    [closeHint, page]
  );

  const next = presentation.destination;
  const edge = presentation.hint && previewPages.indexOf(presentation.hint) < pageIndex ? 'top' : 'bottom';
  const hintVisible = presentation.revealed && !next;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const screen = screenRef.current;
    const incoming = incomingRef.current;
    if (!next || !viewport || !screen || !incoming) return;

    const finish = () => {
      if (navigation.current?.destination === next) {
        router.push(next.href, { scroll: false });
      }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !incoming.animate) {
      finish();
      return;
    }

    const travel = previewPages.indexOf(next) < pageIndex ? -viewport.clientHeight : viewport.clientHeight;
    const offset = screen.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    const options = { duration: 620, easing: 'cubic-bezier(0.45, 0, 0.2, 1)', fill: 'both' } as const;
    const translate = (y: number) => ({ transform: 'translateY(' + y + 'px)' });
    const enter = incoming.animate([translate(offset + travel), translate(0)], options);
    const animations = [screen.animate([translate(offset), translate(-travel)], options), enter];

    const nav = navRef.current;
    const highlight = highlightRef.current;
    const activeControl = getPreviewNavControl(nav, page);
    const nextControl = getPreviewNavControl(nav, next);
    if (nav && highlight && activeControl && nextControl && activeControl !== nextControl) {
      const navTop = nav.getBoundingClientRect().top;
      animations.push(
        highlight.animate(
          [
            translate(highlight.getBoundingClientRect().top - navTop),
            translate(nextControl.getBoundingClientRect().top - navTop)
          ],
          options
        ),
        activeControl.animate([{ color: 'var(--ink)' }, { color: 'var(--cream)' }], options),
        nextControl.animate([{ color: 'var(--cream)' }, { color: 'var(--ink)' }], options)
      );
    }

    void enter.finished.then(finish, () => {});
    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, [next, page, pageIndex, router]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const progress = wheel.current;

    const handleWheel = (event: WheelEvent) => {
      const screen = screenRef.current;
      if (!screen || event.ctrlKey || event.shiftKey || !event.cancelable) return;
      if (
        event.target instanceof Element &&
        event.target.closest('dialog:modal, [data-preview-nav-more-panel]')
      ) {
        return;
      }
      const mode = event.deltaMode;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

      const now = performance.now();
      if (now - progress.lastAt > wheelGestureGap) progress.consumed = false;
      progress.lastAt = now;
      if (progress.consumed || navigation.current) {
        event.preventDefault();
        return;
      }

      const direction = Math.sign(event.deltaY);
      const destination = previewPages[pageIndex + direction];
      const unit =
        mode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : mode === WheelEvent.DOM_DELTA_PAGE
            ? screen.clientHeight
            : 1;
      const distance = Math.abs(event.deltaY) * unit;
      const maximum = screen.scrollHeight - screen.clientHeight;
      const toEdge = Math.max(0, direction > 0 ? maximum - screen.scrollTop : screen.scrollTop);
      if (!destination || distance <= toEdge || (progress.target && progress.target !== destination)) {
        closeHint();
        // A wheel over the fixed sidebar still scrolls the active page.
        if (!screen.contains(event.target as Node)) {
          event.preventDefault();
          screen.scrollBy({ top: direction * distance });
        }
        return;
      }

      event.preventDefault();
      if (toEdge > 0) screen.scrollBy({ top: direction * toEdge });
      progress.distance = Math.min(wheelThreshold, progress.distance + distance - toEdge);
      root.style.setProperty('--wheel-progress', String(progress.distance / wheelThreshold));
      window.clearTimeout(hintTimer.current);
      hintTimer.current = window.setTimeout(closeHint, hintIdleDelay);
      if (!progress.target) {
        progress.target = destination;
        progress.revealedAt = now;
        setPresentation((current) => ({ ...current, hint: destination, revealed: true }));
        return;
      }
      if (progress.distance >= wheelThreshold && now - progress.revealedAt >= hintMinimumTime) {
        progress.consumed = true;
        moveTo(destination);
      }
    };

    root.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      root.removeEventListener('wheel', handleWheel);
      if (navigation.current) window.clearTimeout(navigation.current.rollback);
      navigation.current = null;
      progress.target = null;
      progress.distance = 0;
      window.clearTimeout(hintTimer.current);
      root.style.removeProperty('--wheel-progress');
    };
  }, [closeHint, moveTo, pageIndex]);

  return (
    <div
      className={styles.preview}
      ref={rootRef}
      data-active-page={page.id}
      style={{ '--active-nav-index': pageIndex } as CSSProperties}
      data-peeking={presentation.revealed ? edge : undefined}
    >
      <PreviewSidebar page={page} navRef={navRef} highlightRef={highlightRef} onNavigate={moveTo} />

      <main className={styles.previewViewport} ref={viewportRef}>
        <div className={styles.scrollHint} data-edge={edge} role="status">
          <div
            className={styles.scrollHintContent}
            data-visible={hintVisible ? '' : undefined}
            aria-hidden={!hintVisible}
          >
            <span className={styles.scrollHintLabel}>
              <span className={styles.scrollHintDirection} aria-hidden="true">
                {edge === 'bottom' ? '↓' : '↑'}
              </span>
              {presentation.hint &&
                (edge === 'bottom' ? '再向下滚动，切换到' : '再向上滚动，返回') + presentation.hint.label}
            </span>
            <span className={styles.scrollHintProgress} aria-hidden="true" />
          </div>
        </div>
        <div
          key={page.id}
          ref={screenRef}
          className={screenClassName(page)}
          data-preview-page={page.id}
          data-peek={presentation.revealed ? edge : undefined}
          inert={Boolean(next)}
          aria-label={page.label}
          role="region"
          tabIndex={0}
          onScroll={(event) => {
            const target = wheel.current.target;
            if (!target) return;

            const screen = event.currentTarget;
            const distance =
              previewPages.indexOf(target) > pageIndex
                ? screen.scrollHeight - screen.clientHeight - screen.scrollTop
                : screen.scrollTop;
            if (distance > 1) closeHint();
          }}
        >
          {children}
        </div>
        {next && (
          <div className={screenClassName(next)} data-incoming={next.id} ref={incomingRef} inert>
            {pagePreviews[next.id] ?? placeholder}
          </div>
        )}
      </main>
    </div>
  );
}
