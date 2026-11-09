import { handleActivities } from '../../../../../../server/activities/http';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleActivities(request, 'ordinary-cancel', id);
}
