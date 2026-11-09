'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  useTransition
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { beginUserOperation, installUserMutationTracking, userOperations } from './user-operation';
import {
  finishUserNavigation,
  hasUserNavigation,
  installUserNavigation,
  startUserNavigation
} from './user-navigation';
import './global-interaction.css';

const serverSnapshot = () => 0;

/** Owned scopes release their visual waiting state when their component unmounts. */
export function useUserOperation() {
  const scopes = useRef(new Set<() => void>());
  useEffect(() => {
    const owned = scopes.current;
    return () => {
      for (const end of owned) end();
      owned.clear();
    };
  }, []);
  const begin = useCallback((signal?: AbortSignal) => {
    const release = beginUserOperation(signal);
    const end = () => {
      release();
      scopes.current.delete(end);
    };
    scopes.current.add(end);
    return end;
  }, []);
  const run = useCallback(
    async <T,>(operation: () => Promise<T>, options: { signal?: AbortSignal } = {}) => {
      const end = begin(options.signal);
      try {
        return await operation();
      } finally {
        end();
      }
    },
    [begin]
  );
  return useMemo(() => ({ begin, run }), [begin, run]);
}

/** The normal Next router API with user-requested push/replace waiting feedback. */
export function useUserRouter() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const release = useRef<(() => void) | null>(null);
  const wasPending = useRef(false);
  useEffect(() => {
    if (pending) wasPending.current = true;
    else if (wasPending.current) {
      release.current?.();
      release.current = null;
      wasPending.current = false;
    }
  }, [pending]);
  useEffect(
    () => () => {
      release.current?.();
    },
    []
  );
  return useMemo(
    () => ({
      ...router,
      push: (href: string, options?: Parameters<typeof router.push>[1]) => {
        release.current?.();
        release.current = startUserNavigation(href);
        try {
          startTransition(() => router.push(href, options));
        } catch (error) {
          release.current?.();
          throw error;
        }
      },
      replace: (href: string, options?: Parameters<typeof router.replace>[1]) => {
        release.current?.();
        release.current = startUserNavigation(href);
        try {
          startTransition(() => router.replace(href, options));
        } catch (error) {
          release.current?.();
          throw error;
        }
      }
    }),
    [router]
  );
}

export function UserOperationProvider({ children }: { children: React.ReactNode }) {
  const count = useSyncExternalStore(userOperations.subscribe, userOperations.getSnapshot, serverSnapshot);
  const pathname = usePathname();
  const waitingBar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = waitingBar.current;
    if (!bar) return;
    // Chromium clips fixed descendants out of an empty stable root gutter.
    // Reserve that space in the body instead; keep the window as scroll owner.
    const root = document.documentElement;
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden;pointer-events:none';
    document.body.append(probe);
    const nativeScrollbar = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    root.style.setProperty('--site-native-scrollbar-width', nativeScrollbar + 'px');
    root.classList.add('site-scrollbar-compensated');
    // CSS derives the occupied gutter synchronously. Waiting for ResizeObserver
    // left both a real scrollbar and its previous padding for one frame.
    const updateWidth = () => {
      bar.style.width = root.clientWidth + 'px';
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(root);
    observer.observe(document.body);
    window.addEventListener('resize', updateWidth, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateWidth);
      root.classList.remove('site-scrollbar-compensated');
      root.style.removeProperty('--site-native-scrollbar-width');
    };
  }, []);
  useEffect(() => {
    const restoreFetch = installUserMutationTracking(window, {
      active: hasUserNavigation,
      failed: finishUserNavigation
    });
    const restoreNavigation = installUserNavigation(document);
    return () => {
      restoreFetch();
      restoreNavigation();
    };
  }, []);
  useEffect(() => {
    finishUserNavigation();
  }, [pathname]);
  return (
    <>
      <div
        ref={waitingBar}
        className="site-waiting"
        data-active={count > 0 ? 'true' : 'false'}
        aria-hidden="true"
      >
        <div className="site-waiting-indicator" />
      </div>
      <span className="site-waiting-status" role="status" aria-live="polite">
        {count > 0 ? '正在处理，请稍候' : ''}
      </span>
      {children}
    </>
  );
}
