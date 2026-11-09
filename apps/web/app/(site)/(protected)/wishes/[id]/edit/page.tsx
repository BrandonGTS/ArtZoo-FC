import { forbidden, notFound } from 'next/navigation';
import WishPublisher from '../../../../../../components/wishes/wish-publisher';
import { requirePageAccount } from '../../../../../../server/auth/page-guards';
import { getAccountService } from '../../../../../../server/auth/runtime';
import { sessionToken } from '../../../../../../server/auth/http';
import { WishService } from '../../../../../../server/wishes/service';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params,
    actor = await requirePageAccount('/wishes/' + id + '/edit');
  const wish = await new WishService(getAccountService())
    .get(id, new URL('http://localhost/wishes'), await sessionToken())
    .catch((error) => {
      if (error?.code === 'NOT_FOUND') notFound();
      throw error;
    });
  if (wish.author.id !== actor.id) forbidden();
  return <WishPublisher initialWish={wish} />;
}
