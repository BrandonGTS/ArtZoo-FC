import { redirect } from 'next/navigation';
import { requirePageAdministrator } from '../../../../../server/auth/page-guards';
export default async function AdminPage() {
  await requirePageAdministrator('/admin/album-categories');
  redirect('/admin/featured');
}
