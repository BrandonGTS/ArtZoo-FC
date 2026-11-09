import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isMemberId } from '@artzoo/domain';
import MemberPhotos from '../../../../../../components/albums/member-photos';
import { PageHeading } from '../../../../../../components/home-content';
import { requirePageAccount } from '../../../../../../server/auth/page-guards';

export default async function MemberPhotosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isMemberId(id)) notFound();
  await requirePageAccount(`/members/${id}/photos`);
  return (
    <main className="home-content members-content" id="main-content">
      <div className="member-page-heading">
        <PageHeading level={1} decoration="burger">
          个人照片
        </PageHeading>
        <Link href={`/members/${encodeURIComponent(id)}`} className="member-text-link">
          返回个人主页
        </Link>
      </div>
      <MemberPhotos id={id} />
    </main>
  );
}
