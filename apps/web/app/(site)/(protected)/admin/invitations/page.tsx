import { redirect } from 'next/navigation';
import { requirePageAdministrator } from '../../../../../server/auth/page-guards';
export default async function Page() {
  await requirePageAdministrator('/admin/invitations');
  redirect('/admin/accounts?tab=invitations');
}
