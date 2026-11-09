import { handleWishes } from '../../../../server/wishes/http';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleWishes(request, 'get', (await params).id);
}
