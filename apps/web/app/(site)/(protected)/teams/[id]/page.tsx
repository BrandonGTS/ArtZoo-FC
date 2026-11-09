import { notFound } from 'next/navigation';
import { isMemberId } from '@artzoo/domain';
import TeamWorkspace from '../../../../../components/teams/team-workspace';
import { requirePageAccount } from '../../../../../server/auth/page-guards';

export default async function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isMemberId(id)) notFound();
  await requirePageAccount(`/teams/${id}`);
  return <TeamWorkspace id={id} />;
}
