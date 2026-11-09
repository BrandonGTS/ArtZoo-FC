import { handleResources } from '../../../server/resources/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleResources(request, false);
}
export function POST(request: Request) {
  return handleResources(request, false);
}
