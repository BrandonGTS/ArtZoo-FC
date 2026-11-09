import { handleActivities } from '../../../../../server/activities/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleActivities(request, 'register', (await context.params).id);
}
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleActivities(request, 'move', (await context.params).id);
}
