import { notFound } from 'next/navigation';
import { isMemberId } from '@artzoo/domain';
import ActivityDetail from '../../../../../components/activities/activity-detail';
import { requirePageAccount } from '../../../../../server/auth/page-guards';

export default async function ActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isMemberId(id)) notFound();
  await requirePageAccount(`/activities/${id}`);
  return <ActivityDetail id={id} />;
}
