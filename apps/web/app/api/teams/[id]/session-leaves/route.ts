import { handleTeams } from '../../../../../server/teams/http';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleTeams(request, 'recordLeave', (await params).id);
}
