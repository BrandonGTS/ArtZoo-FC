import { handleWishes } from '../../../../../server/wishes/http';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleWishes(request, 'media', (await params).id);
}
