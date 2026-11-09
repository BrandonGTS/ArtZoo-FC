import { notFound } from 'next/navigation';
import { isMemberId } from '@artzoo/domain';
import MemberHome from '../../../../../components/members/member-home';
import { requirePageAccount } from '../../../../../server/auth/page-guards';

export default async function MemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isMemberId(id)) notFound();
  await requirePageAccount(`/members/${id}`);
  return <MemberHome id={id} />;
}
