import { handleActivities } from '../../../server/activities/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleActivities(request, 'list');
}
export function POST(request: Request) {
  return handleActivities(request, 'list');
}
