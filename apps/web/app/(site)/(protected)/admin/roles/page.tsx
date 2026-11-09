import { redirect } from 'next/navigation';
import { requirePageSuperAdministrator } from '../../../../../server/auth/page-guards';
export default async function Page() {
  await requirePageSuperAdministrator('/admin/roles');
  redirect('/admin/accounts?tab=roles');
}
