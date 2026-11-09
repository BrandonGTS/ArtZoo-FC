import { handleAlbums } from '../../../../../server/albums/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleAlbums(request, 'media', (await context.params).id);
}
