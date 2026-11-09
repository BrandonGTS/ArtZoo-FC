import { handleAlbums } from '../../../../server/albums/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleAlbums(request, 'photo', (await context.params).id);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleAlbums(request, 'photo-detail', (await context.params).id);
}
