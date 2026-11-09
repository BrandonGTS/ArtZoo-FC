import OfficialAdmin from '../../../../../components/official-events/official-admin';
import { requirePageAdministrator } from '../../../../../server/auth/page-guards';
export default async function OfficialEventsAdminPage() {
  await requirePageAdministrator('/admin/official-events');
  return <OfficialAdmin />;
}
