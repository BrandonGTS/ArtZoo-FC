import { handleAlbums } from '../../../../../server/albums/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleAlbums(request, 'like', (await context.params).id);
}
