import AdminEntry from '../../../../components/admin-entry';
import { requirePageAdministrator } from '../../../../server/auth/page-guards';

export const dynamic = 'force-dynamic';

export default async function Admin() {
  const user = await requirePageAdministrator('/admin');
  return <AdminEntry user={user} />;
}
