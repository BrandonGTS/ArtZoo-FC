import { ActivityEditor } from '../../../../../../components/activities/activity-publisher';
import { requirePageAccount } from '../../../../../../server/auth/page-guards';
export default async function EditActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePageAccount(`/activities/${id}/edit`);
  return <ActivityEditor id={id} />;
}
