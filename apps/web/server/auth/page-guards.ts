import { safeAccountReturnTo, type AccountSummary } from '@artzoo/domain';
import { forbidden, redirect } from 'next/navigation';
import { requestPageSession } from './request-session';
export async function requirePageAdministrator(returnTo: string): Promise<AccountSummary> {
  const destination = safeAccountReturnTo(returnTo);
  const safePath = destination === '/admin' || destination.startsWith('/admin/') ? destination : '/admin';
  const { hasToken, session } = await requestPageSession();
  if (!hasToken) redirect(`/login?returnTo=${encodeURIComponent(safePath)}`);
  if (!session.user) redirect(`/login?returnTo=${encodeURIComponent(safePath)}`);
  if (!session.capabilities.manageInvitations) forbidden();
  return session.user;
}

export async function requirePageAccount(returnTo: string): Promise<AccountSummary> {
  const safePath = safeAccountReturnTo(returnTo);
  const { hasToken, session } = await requestPageSession();
  if (!hasToken) redirect(`/login?returnTo=${encodeURIComponent(safePath)}`);
  if (!session.user) redirect(`/login?returnTo=${encodeURIComponent(safePath)}`);
  return session.user;
}

export async function requirePageSuperAdministrator(returnTo: string): Promise<AccountSummary> {
  const user = await requirePageAccount(returnTo);
  if (user.adminRole !== 'SUPER_ADMIN') forbidden();
  return user;
}
