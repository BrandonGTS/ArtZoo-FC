import ShareEditor from '../../../../../../components/public-sharing/share-editor';
import { requirePageAdministrator } from '../../../../../../server/auth/page-guards';
export default async function ActivityShareEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePageAdministrator('/admin/activity-shares/' + id);
  return <ShareEditor id={id} />;
}
