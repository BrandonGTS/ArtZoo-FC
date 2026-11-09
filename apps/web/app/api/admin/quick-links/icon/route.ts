import { handleQuickIconUpload } from '../../../../../server/quick-links/upload-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return handleQuickIconUpload(request);
}
