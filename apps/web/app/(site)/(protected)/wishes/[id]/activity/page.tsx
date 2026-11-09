import { forbidden, redirect, notFound } from 'next/navigation';
import ActivityPublisher from '../../../../../../components/activities/activity-publisher';
import { WishPublishingProvider } from '../../../../../../components/wishes/activity-publishing';
import { requirePageAccount } from '../../../../../../server/auth/page-guards';
import { sessionToken } from '../../../../../../server/auth/http';
import { getAccountService } from '../../../../../../server/auth/runtime';
import { WishService } from '../../../../../../server/wishes/service';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params,
    actor = await requirePageAccount('/wishes/' + id + '/activity');
  const wish = await new WishService(getAccountService())
    .get(id, new URL('http://localhost/wishes'), await sessionToken())
    .catch((error) => {
      if (error?.code === 'NOT_FOUND') notFound();
      throw error;
    });
  if (actor.membership !== 'MEMBER' || !wish.isAuthor) forbidden();
  if (wish.activity) redirect('/activities/' + wish.activity.id);
  return (
    <WishPublishingProvider wish={{ id, title: wish.title, body: wish.body }}>
      <ActivityPublisher />
    </WishPublishingProvider>
  );
}
