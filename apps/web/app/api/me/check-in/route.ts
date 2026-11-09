import { handleCheckin } from '../../../../server/checkin/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleCheckin(request);
}
export function POST(request: Request) {
  return handleCheckin(request);
}
