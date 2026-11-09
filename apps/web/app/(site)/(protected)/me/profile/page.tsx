import { redirect } from 'next/navigation';
import { requirePageAccount } from '../../../../../server/auth/page-guards';

export default async function ProfilePage() {
  const account = await requirePageAccount('/me/profile');
  redirect(`/members/${encodeURIComponent(account.id)}?tab=settings`);
}
