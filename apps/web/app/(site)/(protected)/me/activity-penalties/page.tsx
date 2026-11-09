import MyActivityPenalties from '../../../../../components/activities/my-activity-penalties';
import { requirePageAccount } from '../../../../../server/auth/page-guards';
export const dynamic = 'force-dynamic';
export default async function PenaltyPage() {
  await requirePageAccount('/me/activity-penalties');
  return <MyActivityPenalties />;
}
