import DailyFeed from '../../../../../components/daily/daily-feed';
import { requirePageAccount } from '../../../../../server/auth/page-guards';
export default async function DailyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePageAccount('/daily/' + id);
  return <DailyFeed focusId={id} />;
}
