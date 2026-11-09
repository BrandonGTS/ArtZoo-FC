import WishBrowser from '../../../../components/wishes/wish-browser';
import { requirePageAccount } from '../../../../server/auth/page-guards';
export default async function Page() {
  await requirePageAccount('/wishes');
  return <WishBrowser />;
}
