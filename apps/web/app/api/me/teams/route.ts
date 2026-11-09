import { handleTeams } from '../../../../server/teams/http';
export async function GET(request: Request) {
  return handleTeams(request, 'mine');
}
