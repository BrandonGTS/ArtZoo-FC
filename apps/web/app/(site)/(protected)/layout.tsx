import type { ReactNode } from 'react';
import ProtectedSessionSnapshot from '../../../server/auth/protected-session-snapshot';
import { SiteShellContent } from '../../../components/site-shell';
export default function ProtectedLayout({ children }: { children: ReactNode }) {
  return (
    <ProtectedSessionSnapshot>
      <SiteShellContent>{children}</SiteShellContent>
    </ProtectedSessionSnapshot>
  );
}
