import AlbumDetail from '../../../../../components/albums/album-detail';
import { requirePageAccount } from '../../../../../server/auth/page-guards';
import { isMemberId } from '@artzoo/domain';
export default async function AlbumPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    periodActivityId?: string;
    photoId?: string;
    comments?: string;
    commentId?: string;
  }>;
}) {
  const { id } = await params,
    query = await searchParams;
  const period =
    typeof query.periodActivityId === 'string' && isMemberId(query.periodActivityId)
      ? query.periodActivityId
      : undefined;
  const photo = typeof query.photoId === 'string' && isMemberId(query.photoId) ? query.photoId : undefined;
  const comment =
    typeof query.commentId === 'string' && isMemberId(query.commentId) ? query.commentId : undefined;
  const comments = query.comments === '1' || Boolean(comment && !photo);
  const suffix =
    (photo ? '?photoId=' + photo : period ? '?periodActivityId=' + period : comments ? '?comments=1' : '') +
    (comment ? '&commentId=' + comment : '');
  await requirePageAccount('/albums/' + id + suffix);
  return (
    <AlbumDetail
      id={id}
      initialPeriod={period}
      initialPhoto={photo}
      initialComments={comments}
      initialCommentId={comment}
    />
  );
}
