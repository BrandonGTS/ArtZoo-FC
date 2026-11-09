import { handleTeams } from '../../../server/teams/http';
export async function GET(request: Request) {
  return handleTeams(request, 'list');
}
export async function POST(request: Request) {
  return handleTeams(request, 'create');
}
