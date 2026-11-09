import { handleAlbums } from '../../../../../../server/albums/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string; mediaId: string }> }) {
  return handleAlbums(request, 'comment-media', (await context.params).id);
}
