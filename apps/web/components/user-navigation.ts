import { beginUserOperation } from './user-operation';

let pending: { href: string; from: string; end(): void } | null = null;
export const hasUserNavigation = () => pending !== null;

/** Start before router.push/replace; the provider releases on route commit or cancellation. */
export function startUserNavigation(href: string): () => void {
  if (typeof window === 'undefined') return () => {};
  const next = new URL(href, window.location.href);
  if (
    next.origin !== window.location.origin ||
    next.pathname + next.search === window.location.pathname + window.location.search
  )
    return () => {};
  pending?.end();
  const release = beginUserOperation();
  // Abandoned/failed Next navigations have no public rejection callback. Bound that token;
  // this never releases independently tracked API requests that are still in flight.
  const timer = window.setTimeout(() => end(), 20_000);
  const end = () => {
    window.clearTimeout(timer);
    release();
    if (pending?.end === end) pending = null;
  };
  pending = { href: next.href, from: window.location.href, end };
  return end;
}

export function finishUserNavigation() {
  pending?.end();
}

export function installUserNavigation(target: Document) {
  const click = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const element = event.target instanceof Element ? event.target : null;
    const anchor = element?.closest<HTMLAnchorElement>('a[href]');
    if (
      !anchor ||
      anchor.hasAttribute('download') ||
      anchor.getAttribute('aria-disabled') === 'true' ||
      anchor.closest('[data-no-user-progress]') ||
      (anchor.target && anchor.target !== '_self')
    )
      return;
    startUserNavigation(anchor.href);
  };
  target.addEventListener('click', click, true);
  const pagehide = () => finishUserNavigation();
  window.addEventListener('pagehide', pagehide);
  // Next commits both pathname and search-only navigation through History API.
  const history = window.history;
  const push = history.pushState;
  const replace = history.replaceState;
  function committed() {
    if (pending && window.location.href !== pending.from) finishUserNavigation();
  }
  const pushTracked: History['pushState'] = function (...args) {
    push.apply(history, args);
    committed();
  };
  const replaceTracked: History['replaceState'] = function (...args) {
    replace.apply(history, args);
    committed();
  };
  history.pushState = pushTracked;
  history.replaceState = replaceTracked;
  return () => {
    target.removeEventListener('click', click, true);
    window.removeEventListener('pagehide', pagehide);
    if (history.pushState === pushTracked) history.pushState = push;
    if (history.replaceState === replaceTracked) history.replaceState = replace;
    finishUserNavigation();
  };
}
