'use client';
import { createContext, useCallback, useContext, useState } from 'react';
import { useAuthSession } from '../auth-session';
import { ErrorNotice } from '../account/account-ui';
type Scope = { ownerKey: string; actorId: string; deny(): void };
const SuperContext = createContext<Scope | null>(null);
export function SuperAdminOnly({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuthSession(),
    actor = session?.user;
  if (loading || !actor || actor.adminRole !== 'SUPER_ADMIN') return null;
  return (
    <SuperOwner
      key={[actor.id, actor.membership, actor.adminRole].join(':')}
      actorId={actor.id}
      ownerKey={[actor.id, actor.membership, actor.adminRole].join(':')}
    >
      {children}
    </SuperOwner>
  );
}
function SuperOwner({
  children,
  ownerKey,
  actorId
}: {
  children: React.ReactNode;
  ownerKey: string;
  actorId: string;
}) {
  const [denied, setDenied] = useState(false);
  const deny = useCallback(() => setDenied(true), [setDenied]);
  if (denied)
    return (
      <main className="home-content" id="main-content">
        <ErrorNotice message="管理权限已变化，请重新确认登录状态。" />
      </main>
    );
  return <SuperContext.Provider value={{ ownerKey, actorId, deny }}>{children}</SuperContext.Provider>;
}
export function useSuperAdminScope() {
  const scope = useContext(SuperContext);
  if (!scope) throw new Error('Super administrator scope required');
  return scope;
}
