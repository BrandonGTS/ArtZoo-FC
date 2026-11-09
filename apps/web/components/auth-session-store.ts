import type { AvatarSummary, SessionSnapshot } from '@artzoo/domain';
export type AuthSnapshot = Readonly<{
  session: SessionSnapshot | null;
  avatar: AvatarSummary | null;
  loading: boolean;
  error: string | null;
}>;
type Ports = {
  session(signal: AbortSignal): Promise<SessionSnapshot>;
  avatar(session: SessionSnapshot, signal: AbortSignal): Promise<AvatarSummary | null>;
  now?: () => number;
};
const guest = (): SessionSnapshot => ({
  user: null,
  expiresAt: null,
  capabilities: { manageInvitations: false, manageMembership: false }
});
export function createAuthStore(ports: Ports) {
  const now = ports.now ?? Date.now;
  const initial: AuthSnapshot = { session: null, avatar: null, loading: true, error: null };
  let snapshot = initial,
    initialized = false,
    revision = 0,
    verifiedAt = -Infinity;
  let logoutPending = false,
    fallbackAllowed = false;
  let inflight: { promise: Promise<void>; abort: AbortController; revision: number } | null = null;
  let profile: AbortController | null = null;
  let leases = 0,
    disposalVersion = 0;
  const listeners = new Set<() => void>();
  const publish = (next: AuthSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const validSeed = (value: SessionSnapshot) =>
    !value.user ||
    (typeof value.expiresAt === 'string' &&
      Number.isFinite(Date.parse(value.expiresAt)) &&
      Date.parse(value.expiresAt) > now());
  const canSeed = (value: SessionSnapshot) =>
    !initialized && revision === 0 && !logoutPending && validSeed(value);
  function loadAvatar(value: SessionSnapshot, stamp: number) {
    profile?.abort();
    profile = null;
    if (!value.user) {
      if (snapshot.avatar) publish({ ...snapshot, avatar: null });
      return;
    }
    const controller = new AbortController();
    profile = controller;
    void ports
      .avatar(value, controller.signal)
      .catch(() => null)
      .then((avatar) => {
        if (!controller.signal.aborted && revision === stamp && !logoutPending)
          publish({ ...snapshot, avatar });
      });
  }
  function invalidate() {
    ++revision;
    inflight?.abort.abort();
    inflight = null;
    profile?.abort();
    profile = null;
    verifiedAt = -Infinity;
  }
  function refresh(force = true): Promise<void> {
    if (logoutPending) return Promise.resolve();
    const expiry = snapshot.session?.expiresAt ? Date.parse(snapshot.session.expiresAt) : Infinity;
    if (!force && initialized && now() - verifiedAt < 60_000 && expiry > now()) return Promise.resolve();
    if (inflight) return inflight.promise;
    const stamp = ++revision,
      controller = new AbortController();
    const request = Promise.resolve()
      .then(() => ports.session(controller.signal))
      .then((value) => {
        if (revision !== stamp || logoutPending) return;
        initialized = true;
        verifiedAt = now();
        const sameOwner = snapshot.session?.user?.id === value.user?.id;
        publish({ session: value, avatar: sameOwner ? snapshot.avatar : null, loading: false, error: null });
        loadAvatar(value, stamp);
      })
      .catch((failure) => {
        if (revision !== stamp || controller.signal.aborted || logoutPending) return;
        verifiedAt = -Infinity;
        const message = failure instanceof Error ? failure.message : '无法读取登录状态';
        publish({ session: null, avatar: null, loading: false, error: message });
        throw new Error(message);
      })
      .finally(() => {
        if (inflight?.revision === stamp) inflight = null;
      });
    inflight = { promise: request, abort: controller, revision: stamp };
    return request;
  }
  return {
    attach() {
      ++leases;
      ++disposalVersion;
      return () => {
        --leases;
        const stamp = ++disposalVersion;
        queueMicrotask(() => {
          if (leases === 0 && stamp === disposalVersion) invalidate();
        });
      };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    canSeed,
    isInitialized: () => initialized,
    seed(value: SessionSnapshot) {
      if (!canSeed(value)) return false;
      initialized = true;
      verifiedAt = now();
      publish({ session: value, avatar: null, loading: false, error: null });
      loadAvatar(value, revision);
      return true;
    },
    bootstrap(protectedPath: boolean) {
      if (initialized) return Promise.resolve();
      if (!initialized && protectedPath && !fallbackAllowed && revision === 0) return Promise.resolve();
      return refresh(false);
    },
    fallback() {
      fallbackAllowed = true;
      return refresh(false);
    },
    visible(protectedPath: boolean) {
      if (!initialized && protectedPath && !fallbackAllowed && revision === 0) return Promise.resolve();
      return refresh(false);
    },
    refresh,
    invalidate,
    beginLogout() {
      if (logoutPending) return false;
      invalidate();
      logoutPending = true;
      return true;
    },
    completeLogout() {
      initialized = true;
      verifiedAt = now();
      publish({ session: guest(), avatar: null, loading: false, error: null });
    },
    failLogout(message: string) {
      publish({ ...snapshot, error: message, loading: false });
    },
    endLogout() {
      logoutPending = false;
    },
    isLogoutPending: () => logoutPending,
    dispose() {
      invalidate();
    }
  };
}
export type AuthStore = ReturnType<typeof createAuthStore>;
