import TeamHistoryPage from '../../../../../../components/teams/team-history';
import { requirePageAccount } from '../../../../../../server/auth/page-guards';
export default async function Page() {
  await requirePageAccount('/me/teams/history');
  return <TeamHistoryPage />;
}
