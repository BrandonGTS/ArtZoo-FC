import { handleHelpProgress } from '../../../../server/site-help/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleHelpProgress(request);
}
export function POST(request: Request) {
  return handleHelpProgress(request);
}
