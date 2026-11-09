import { handlePenaltyAppeals } from '../../../../../server/activities/penalty-appeals-http';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handlePenaltyAppeals(request, 'decide', (await params).id);
}
