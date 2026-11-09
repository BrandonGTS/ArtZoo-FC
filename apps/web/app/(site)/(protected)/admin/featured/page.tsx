import { FeaturedAdmin } from '../../../../../components/albums/album-admin';
import { requirePageAdministrator } from '../../../../../server/auth/page-guards';
export default async function AdminPage() {
  await requirePageAdministrator('/admin/featured');
  return <FeaturedAdmin />;
}
