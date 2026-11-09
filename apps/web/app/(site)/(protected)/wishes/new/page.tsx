import WishPublisher from '../../../../../components/wishes/wish-publisher';
import { requirePageAccount } from '../../../../../server/auth/page-guards';
import { forbidden } from 'next/navigation';
export default async function Page() {
  const actor = await requirePageAccount('/wishes/new');
  if (actor.membership !== 'MEMBER') forbidden();
  return <WishPublisher />;
}
