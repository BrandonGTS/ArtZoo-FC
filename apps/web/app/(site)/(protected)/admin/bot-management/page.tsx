import BotManagement from '../../../../../components/bot-management/bot-management';
import { requirePageSuperAdministrator } from '../../../../../server/auth/page-guards';
export default async function BotManagementPage() {
  await requirePageSuperAdministrator('/admin/bot-management');
  return <BotManagement />;
}
