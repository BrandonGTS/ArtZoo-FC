import { notFound } from 'next/navigation';
import { isMemberId } from '@artzoo/domain';
import LotteryDetail from '../../../../../components/lottery/lottery-detail';
import { requirePageAccount } from '../../../../../server/auth/page-guards';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isMemberId(id)) notFound();
  await requirePageAccount('/lotteries/' + id);
  return <LotteryDetail id={id} />;
}
