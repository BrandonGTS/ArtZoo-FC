import { handleActivities } from '../../../../../../server/activities/http';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleActivities(request, 'series-cancel-period', (await params).id);
}
