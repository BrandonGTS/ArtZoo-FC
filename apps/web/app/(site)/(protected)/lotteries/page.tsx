import LotteryBrowser from '../../../../components/lottery/lottery-browser';
import { requirePageAccount } from '../../../../server/auth/page-guards';
export default async function Page() {
  await requirePageAccount('/lotteries');
  return <LotteryBrowser />;
}
