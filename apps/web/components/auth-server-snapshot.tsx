'use client';
import { useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import type { SessionSnapshot } from '@artzoo/domain';
import type { AuthSnapshot } from './auth-session-store';
import { AuthServerSnapshotContext, AuthStoreContext } from './auth-session-context';
export default function AuthServerSnapshot({
  session,
  children
}: {
  session: SessionSnapshot;
  children: ReactNode;
}) {
  const context = useContext(AuthStoreContext);
  const [initial] = useState<AuthSnapshot>(() => ({ session, avatar: null, loading: false, error: null }));
  useLayoutEffect(() => {
    if (!context) return;
    if (!context.store.seed(session) && !context.store.isInitialized())
      void context.store.fallback().catch(() => {});
  }, [context, session]);
  return <AuthServerSnapshotContext.Provider value={initial}>{children}</AuthServerSnapshotContext.Provider>;
}
export function AuthFallbackBootstrap() {
  const context = useContext(AuthStoreContext);
  useLayoutEffect(() => {
    if (context) void context.store.fallback().catch(() => {});
  }, [context]);
  return null;
}
