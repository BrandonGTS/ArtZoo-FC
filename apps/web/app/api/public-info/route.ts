import { handleActivityShares } from '../../../server/activity-shares/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleActivityShares(request, 'info');
}
