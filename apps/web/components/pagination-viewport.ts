import type { MouseEvent } from 'react';

// This observer belongs to the click, so it survives controls temporarily
// unmounting while their parent fetches a new page. It never changes layout.
export function preservePaginationViewport(navigation: HTMLElement) {
  const key = navigation.dataset.paginationViewport;
  const page = navigation.dataset.paginationPage;
  const pathname = window.location.pathname;
  const matching = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-pagination-viewport]')).filter(
      (node) => node.dataset.paginationViewport === key
    );
  const index = matching().indexOf(navigation);
  const top = navigation.getBoundingClientRect().top;
  let waiting = false,
    frame = 0;
  const cancel = () => {
    observer.disconnect();
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timeout);
    window.removeEventListener('wheel', cancel);
    window.removeEventListener('touchstart', cancel);
    window.removeEventListener('pointerdown', cancel);
    window.removeEventListener('keydown', cancelOnKey);
  };
  const cancelOnKey = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancel();
  };
  const check = () => {
    frame = 0;
    if (window.location.pathname !== pathname) {
      cancel();
      return;
    }
    const current = matching()[index];
    if (!current || current.dataset.paginationLoading === 'true') {
      waiting = true;
      return;
    }
    if (!waiting && current.dataset.paginationPage === page) return;
    const delta = current.getBoundingClientRect().top - top;
    const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const destination = Math.max(0, Math.min(maximum, window.scrollY + delta));
    cancel();
    window.scrollTo({ top: destination, left: window.scrollX, behavior: 'instant' });
  };
  const observer = new MutationObserver(() => {
    if (!frame) frame = window.requestAnimationFrame(check);
  });
  const timeout = window.setTimeout(cancel, 15000);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-pagination-page', 'data-pagination-loading']
  });
  window.addEventListener('wheel', cancel, { passive: true });
  window.addEventListener('touchstart', cancel, { passive: true });
  window.addEventListener('pointerdown', cancel, { passive: true });
  window.addEventListener('keydown', cancelOnKey);
}

export function paginationViewportProps(page: number, loading: boolean, key: string) {
  return {
    'data-pagination-viewport': key,
    'data-pagination-page': page,
    'data-pagination-loading': loading,
    onClickCapture(event: MouseEvent<HTMLElement>) {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!loading && button && !button.disabled) preservePaginationViewport(event.currentTarget);
    }
  };
}
