import WishDetailPage from '../../../../../components/wishes/wish-detail';
import { requirePageAccount } from '../../../../../server/auth/page-guards';
export default async function Page({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params,
    query = await searchParams,
    commentId = typeof query.commentId === 'string' ? query.commentId : undefined;
  await requirePageAccount(
    '/wishes/' + id + (commentId ? '?commentId=' + encodeURIComponent(commentId) : '')
  );
  return <WishDetailPage key={id + ':' + (commentId ?? '')} id={id} commentId={commentId} />;
}
