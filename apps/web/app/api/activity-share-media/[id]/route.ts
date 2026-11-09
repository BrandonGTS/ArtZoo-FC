import { handleActivityShares } from '../../../../server/activity-shares/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, c: { params: Promise<{ id: string }> }) {
  return handleActivityShares(request, 'media', (await c.params).id);
}
