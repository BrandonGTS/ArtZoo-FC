import LotteryPublisher from '../../../../../components/lottery/lottery-publisher';
import { requirePageAccount } from '../../../../../server/auth/page-guards';
export default async function Page() {
  await requirePageAccount('/lotteries/new');
  return <LotteryPublisher />;
}
