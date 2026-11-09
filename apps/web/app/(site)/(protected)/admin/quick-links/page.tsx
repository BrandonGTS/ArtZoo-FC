import QuickLinkAdmin from '../../../../../components/quick-links/quick-link-admin';
import { requirePageAdministrator } from '../../../../../server/auth/page-guards';
export const dynamic = 'force-dynamic';
export default async function Page() {
  await requirePageAdministrator('/admin/quick-links');
  return <QuickLinkAdmin />;
}
