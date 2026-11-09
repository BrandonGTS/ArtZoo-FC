'use client';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useUserRouter as useRouter } from './user-operation-provider';
import {
  safeAccountReturnTo,
  type ApiResult,
  type MemberProfile,
  type SessionSnapshot
} from '@artzoo/domain';
import { createAuthStore } from './auth-session-store';
import { AuthStoreContext, AuthServerSnapshotContext } from './auth-session-context';
import { isProtectedSessionPath } from './auth-route-mode';
import { AUTH_EVENT_KEY, readAuthEvent, createAuthEventCursor } from './auth-session-events';
const AccountDialogHost = dynamic(() => import('./account/account-dialog-host'), { ssr: false });
export function AuthSessionProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(() =>
    createAuthStore({
      async session(signal) {
        const response = await fetch('/api/auth/session', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal
        });
        const result = (await response.json()) as ApiResult<SessionSnapshot>;
        if (!response.ok || !result.ok)
          throw new Error(result.ok ? '无法读取登录状态' : result.error.message);
        return result.data;
      },
      async avatar(session, signal) {
        if (!session.user) return null;
        const response = await fetch('/api/me/profile', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        });
        const result = (await response.json()) as ApiResult<MemberProfile>;
        return response.ok && result.ok && result.data.id === session.user.id ? result.data.avatar : null;
      }
    })
  );
  const [events] = useState(() =>
    createAuthEventCursor(readAuthEvent(), () => {
      store.invalidate();
      void store.refresh(true).catch(() => {});
    })
  );
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const [login, setLogin] = useState({ open: false, returnTo: '/' });
  const router = useRouter(),
    pathname = usePathname();
  const broadcast = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => store.refresh(true), [store]);
  useEffect(() => {
    const release = store.attach();
    const update = () => {
      if (document.visibilityState === 'visible' && !store.isLogoutPending()) {
        if (events.receive(readAuthEvent())) return;
        void store.visible(isProtectedSessionPath(pathname)).catch(() => {});
      }
    };
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted && !store.isLogoutPending()) {
        store.invalidate();
        void store.refresh(true).catch(() => {});
      } else update();
    };
    window.addEventListener('pageshow', restore);
    let channel: BroadcastChannel | null = null;
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUTH_EVENT_KEY) events.receive(event.newValue);
    };
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(AUTH_EVENT_KEY);
        channel.onmessage = (event) => {
          if (event.data?.type === 'auth-change') events.receive(event.data.id);
        };
      } catch {
        channel = null;
      }
    }
    window.addEventListener('storage', onStorage);
    broadcast.current = () => {
      let id: string;
      try {
        id = crypto.randomUUID();
        events.remember(id);
      } catch {
        // Advisory notification failure must not undo confirmed authentication.
        return;
      }
      try {
        localStorage.setItem(AUTH_EVENT_KEY, id);
      } catch {
        /* Storage can be unavailable. */
      }
      try {
        channel?.postMessage({ type: 'auth-change', id });
      } catch {
        /* Advisory delivery cannot fail confirmed authentication. */
      }
    };
    // Detect an auth change between initial browser render and listener attachment.
    events.receive(readAuthEvent());
    return () => {
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('storage', onStorage);
      channel?.close();
      broadcast.current = null;
      // Strict replay immediately reattaches; disposal targets only this detached store.
      release();
    };
  }, [store, pathname, events]);
  useEffect(() => {
    void store.bootstrap(isProtectedSessionPath(pathname)).catch(() => {});
  }, [store, pathname]);
  useEffect(() => {
    if (!state.session?.expiresAt) return;
    const timer = window.setTimeout(
      () => {
        void store.refresh(true).catch(() => {});
      },
      Math.max(0, Math.min(Date.parse(state.session.expiresAt) - Date.now(), 2_147_000_000))
    );
    return () => window.clearTimeout(timer);
  }, [store, state.session]);
  const openLogin = useCallback(
    (returnTo = '/') => setLogin({ open: true, returnTo: safeAccountReturnTo(returnTo) }),
    []
  );
  const logout = useCallback(async () => {
    if (!store.beginLogout()) return false;
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-ArtZoo-Request': '1' },
        body: '{}'
      });
      const result = (await response.json()) as ApiResult<{ loggedOut: true }>;
      if (!response.ok || !result.ok) throw new Error(result.ok ? '退出登录失败' : result.error.message);
      store.completeLogout();
      broadcast.current?.();
      router.replace('/');
      router.refresh();
      return true;
    } catch (failure) {
      store.failLogout(failure instanceof Error ? failure.message : '退出登录失败，请稍后再操作');
      return false;
    } finally {
      store.endLogout();
    }
  }, [router, store]);
  const passwordResetCompleted = useCallback(async () => {
    store.invalidate();
    try {
      await refresh();
    } finally {
      // The reset API has already succeeded; peer revocation must not depend on this read succeeding.
      broadcast.current?.();
    }
  }, [store, refresh]);
  const context = useMemo(
    () => ({ store, refresh, passwordResetCompleted, openLogin, logout }),
    [store, refresh, passwordResetCompleted, openLogin, logout]
  );
  return (
    <AuthStoreContext.Provider value={context}>
      {children}
      {login.open && (
        <AccountDialogHost
          open
          returnTo={login.returnTo}
          onClose={() => {
            setLogin((value) => ({ ...value, open: false }));
            if (pathname === '/login') router.replace('/');
          }}
          onAuthenticated={async () => {
            store.invalidate();
            await refresh();
            broadcast.current?.();
            router.refresh();
          }}
        />
      )}
    </AuthStoreContext.Provider>
  );
}

export function useAuthSession() {
  const context = useContext(AuthStoreContext),
    seed = useContext(AuthServerSnapshotContext);
  if (!context) throw new Error('useAuthSession requires AuthSessionProvider');
  const { store, refresh, passwordResetCompleted, openLogin, logout } = context;
  const snapshot = useSyncExternalStore(
    store.subscribe,
    () => (seed?.session && store.canSeed(seed.session) ? seed : store.getSnapshot()),
    () => seed ?? store.getServerSnapshot()
  );
  return { ...snapshot, refresh, passwordResetCompleted, openLogin, logout };
}
