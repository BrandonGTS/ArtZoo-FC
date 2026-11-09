import DailyFeed from '../../../../components/daily/daily-feed';
import { requirePageAccount } from '../../../../server/auth/page-guards';
export default async function DailyPage() {
  await requirePageAccount('/daily');
  return <DailyFeed />;
}
