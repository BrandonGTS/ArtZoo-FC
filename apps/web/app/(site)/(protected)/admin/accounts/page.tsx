import { Suspense } from 'react';
import IdentityAdmin from '../../../../../components/admin-management/identity-admin';
import { requirePageAdministrator } from '../../../../../server/auth/page-guards';
export default async function AccountsPage() {
  await requirePageAdministrator('/admin/accounts');
  return (
    <Suspense fallback={<p>正在读取…</p>}>
      <IdentityAdmin />
    </Suspense>
  );
}
