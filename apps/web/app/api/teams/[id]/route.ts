import { handleTeams } from '../../../../server/teams/http';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleTeams(request, 'get', (await params).id);
}
