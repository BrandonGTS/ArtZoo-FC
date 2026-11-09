import AccountLifecycleAdmin from '../../../../../components/admin-management/account-lifecycle-admin';
import { requirePageSuperAdministrator } from '../../../../../server/auth/page-guards';
export default async function AccountLifecyclePage() {
  await requirePageSuperAdministrator('/admin/account-lifecycle');
  return <AccountLifecycleAdmin />;
}
