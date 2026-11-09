import TeamBrowser from '../../../../../components/teams/team-browser';
import { requirePageAccount } from '../../../../../server/auth/page-guards';

export default async function TeamsPage() {
  await requirePageAccount('/me/teams');
  return <TeamBrowser mine />;
}
