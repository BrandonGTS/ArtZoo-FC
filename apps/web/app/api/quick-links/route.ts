import { handleQuickLinks } from '../../../server/quick-links/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleQuickLinks(request);
}
