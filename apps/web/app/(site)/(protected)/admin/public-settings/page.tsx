import { redirect } from 'next/navigation';
import { requirePageSuperAdministrator } from '../../../../../server/auth/page-guards';
export default async function PublicSettingsPage() {
  await requirePageSuperAdministrator('/admin/public-settings');
  redirect('/admin/contact-requests');
}
