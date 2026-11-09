import { handleWishes } from '../../../../../server/wishes/http';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleWishes(request, 'remove', (await params).id);
}
