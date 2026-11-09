import MyActivities from '../../../../../components/activities/my-activities';
import { requirePageAccount } from '../../../../../server/auth/page-guards';

export default async function MyActivitiesPage() {
  await requirePageAccount('/me/activities');
  return <MyActivities />;
}
