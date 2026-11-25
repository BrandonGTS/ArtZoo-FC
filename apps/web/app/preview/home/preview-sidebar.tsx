'use client';

import Link from 'next/link';
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import LessonIcon from '../../../components/site-help/lesson-icon';
import { type PreviewPage, previewPages } from '../preview-pages';
import styles from './home-preview.module.css';

const navIcons = {
  home: 'home',
  daily: 'daily',
  activities: 'activities',
  album: 'albums',
  share: 'knowledge'
} as const;

function closePopover(panel: HTMLElement | null) {
  if (panel?.hidePopover && panel.matches(':popover-open')) panel.hidePopover();
}

export function getPreviewNavControl(nav: HTMLElement | null, page: PreviewPage) {
  return (
    nav?.querySelector<HTMLElement>('a[data-preview-nav-page="' + page.id + '"]') ??
    nav?.querySelector<HTMLElement>('button[data-preview-nav-more]')
  );
}

export default function PreviewSidebar({
  page,
  navRef,
  highlightRef,
  onNavigate
}: {
  page: PreviewPage;
  navRef: RefObject<HTMLElement | null>;
  highlightRef: RefObject<HTMLSpanElement | null>;
  onNavigate(page: PreviewPage): void;
}) {
  const sidebarRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLLIElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const moreId = useId();
  const observedCount = useRef<number>(previewPages.length);
  const [visibleCount, setVisibleCount] = useState<number>(previewPages.length);
  const [openFor, setOpenFor] = useState<PreviewPage | null>(null);
  const moreOpen = openFor === page;
  const overflowPages = previewPages.slice(visibleCount);
  const currentInOverflow = overflowPages.includes(page);

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    const nav = navRef.current;
    if (!sidebar || !nav) return;

    const observer = new ResizeObserver(() => {
      // Share the row limits with the CSS container queries that set the rail layout.
      const count = Number.parseInt(getComputedStyle(nav).getPropertyValue('--nav-visible-items'), 10);
      if (Number.isNaN(count) || count === observedCount.current) return;

      observedCount.current = count;
      closePopover(panelRef.current);
      setOpenFor(null);
      setVisibleCount(count);
    });
    observer.observe(sidebar);
    return () => observer.disconnect();
  }, [navRef]);

  useLayoutEffect(() => {
    closePopover(panelRef.current);
  }, [page]);

  useEffect(() => {
    if (!moreOpen || panelRef.current?.showPopover) return;

    function dismissFallback(event: PointerEvent) {
      if (event.target instanceof Node && !moreRef.current?.contains(event.target)) setOpenFor(null);
    }

    document.addEventListener('pointerdown', dismissFallback);
    return () => document.removeEventListener('pointerdown', dismissFallback);
  }, [moreOpen]);

  function closeMore(restoreFocus = false) {
    closePopover(panelRef.current);
    setOpenFor(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  return (
    <aside className={styles.sidebar} ref={sidebarRef} data-overflow-open={moreOpen ? '' : undefined}>
      <div className={styles.logoPlaceholder} aria-hidden="true" />
      <nav ref={navRef} className={styles.sidebarNav} aria-label="主导航">
        <span className={styles.navHighlight} ref={highlightRef} aria-hidden="true" />
        <ul>
          {previewPages.slice(0, visibleCount).map((destination) => (
            <li key={destination.id}>
              <Link
                className={styles.navItem}
                href={destination.href}
                data-preview-nav-page={destination.id}
                aria-current={page === destination ? 'page' : undefined}
                onNavigate={(event) => {
                  event.preventDefault();
                  onNavigate(destination);
                }}
              >
                <span className={styles.navIcon} aria-hidden="true" />
                <span className={styles.compactNavIcon}>
                  <LessonIcon lessonId={navIcons[destination.id]} />
                </span>
                <span className={styles.navLabel}>{destination.label}</span>
              </Link>
            </li>
          ))}
          {overflowPages.length > 0 && (
            <li
              ref={moreRef}
              onBlur={(event) => {
                if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) closeMore();
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || !moreOpen || panelRef.current?.hidePopover) return;
                event.preventDefault();
                closeMore(true);
              }}
            >
              <button
                type="button"
                className={styles.navItem + ' ' + styles.moreNavButton}
                data-preview-nav-more
                data-current={currentInOverflow ? '' : undefined}
                ref={triggerRef}
                aria-label={currentInOverflow ? '更多，当前页面 ' + page.label : undefined}
                aria-controls={moreId}
                aria-expanded={moreOpen}
                popoverTarget={moreId}
                onClick={() => {
                  if (!panelRef.current?.showPopover) setOpenFor(moreOpen ? null : page);
                }}
              >
                更多
              </button>
              <div
                id={moreId}
                ref={panelRef}
                popover="auto"
                className={styles.moreNavPanel}
                data-preview-nav-more-panel
                data-open={moreOpen ? '' : undefined}
                onToggle={(event) => setOpenFor(event.newState === 'open' ? page : null)}
              >
                <ul>
                  {overflowPages.map((destination) => (
                    <li key={destination.id}>
                      <Link
                        className={styles.moreNavLink}
                        href={destination.href}
                        aria-current={page === destination ? 'page' : undefined}
                        onNavigate={(event) => {
                          event.preventDefault();
                          closeMore(true);
                          onNavigate(destination);
                        }}
                      >
                        <LessonIcon lessonId={navIcons[destination.id]} />
                        {destination.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          )}
        </ul>
      </nav>
      <button className={styles.help} type="button" disabled aria-label="帮助">
        ?
      </button>
    </aside>
  );
}
