import { handleActivityShares } from '../../../../server/activity-shares/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type C = { params: Promise<{ id: string }> };
export async function GET(request: Request, c: C) {
  return handleActivityShares(request, 'get', (await c.params).id);
}
export async function POST(request: Request, c: C) {
  return handleActivityShares(request, 'mutate', (await c.params).id);
}
