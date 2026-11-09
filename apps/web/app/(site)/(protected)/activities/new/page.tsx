import { forbidden } from 'next/navigation';
import ActivityPublisher from '../../../../../components/activities/activity-publisher';
import { requirePageAccount } from '../../../../../server/auth/page-guards';

export default async function NewActivityPage() {
  const account = await requirePageAccount('/activities/new');
  if (account.membership !== 'MEMBER') forbidden();
  return <ActivityPublisher />;
}
