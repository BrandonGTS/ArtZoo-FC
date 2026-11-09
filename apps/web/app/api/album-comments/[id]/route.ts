import { handleAlbums } from '../../../../server/albums/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleAlbums(request, 'comment', (await context.params).id);
}
