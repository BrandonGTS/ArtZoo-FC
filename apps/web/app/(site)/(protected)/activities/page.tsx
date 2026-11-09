import { beijingDateKey } from '@artzoo/domain';
import ActivityBrowser from '../../../../components/activities/activity-browser';
import { requirePageAccount } from '../../../../server/auth/page-guards';

export default async function ActivitiesPage() {
  await requirePageAccount('/activities');
  // Auth makes this a request-time server render; seed one stable Beijing date for hydration.
  // eslint-disable-next-line react-hooks/purity
  const initialDay = beijingDateKey(Date.now());
  return <ActivityBrowser initialDay={initialDay} />;
}
