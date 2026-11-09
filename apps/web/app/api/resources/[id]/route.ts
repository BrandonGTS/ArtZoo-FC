import { handleResources } from '../../../../server/resources/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleResources(request, false, (await context.params).id);
}
