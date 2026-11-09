import PenaltyAppeals from '../../../../../components/activities/penalty-appeals';
import { requirePageAdministrator } from '../../../../../server/auth/page-guards';
export const dynamic = 'force-dynamic';
export default async function PenaltyAppealPage() {
  await requirePageAdministrator('/admin/penalty-appeals');
  return <PenaltyAppeals />;
}
