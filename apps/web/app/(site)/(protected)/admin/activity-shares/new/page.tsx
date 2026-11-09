import ShareEditor from '../../../../../../components/public-sharing/share-editor';
import { requirePageAdministrator } from '../../../../../../server/auth/page-guards';
export default async function NewActivitySharePage({
  searchParams
}: {
  searchParams: Promise<{ activityId?: string }>;
}) {
  const { activityId } = await searchParams;
  await requirePageAdministrator(
    '/admin/activity-shares/new' + (activityId ? '?activityId=' + encodeURIComponent(activityId) : '')
  );
  return <ShareEditor activityId={activityId} />;
}
