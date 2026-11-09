import TeamCreate from '../../../../../components/teams/team-create';
import { requirePageAccount } from '../../../../../server/auth/page-guards';

export default async function TeamsPage() {
  await requirePageAccount('/teams/new');
  return <TeamCreate />;
}
