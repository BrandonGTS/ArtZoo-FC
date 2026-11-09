import { handleActivities } from '../../../../server/activities/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleActivities(request, 'detail', (await context.params).id);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleActivities(request, 'edit', (await context.params).id);
}
