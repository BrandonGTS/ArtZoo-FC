import { handleQuickLinkIcon } from '../../../../../server/quick-links/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleQuickLinkIcon(request, (await context.params).id);
}
