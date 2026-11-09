import type { ReactNode } from 'react';
import AuthServerSnapshot from '../../components/auth-server-snapshot';
import { requestPageSession } from './request-session';
export default async function ProtectedSessionSnapshot({ children }: { children: ReactNode }) {
  const { session } = await requestPageSession();
  return <AuthServerSnapshot session={session}>{children}</AuthServerSnapshot>;
}
