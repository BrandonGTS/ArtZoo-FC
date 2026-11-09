import { handleAlbums } from '../../../../server/albums/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleAlbums(request, 'featured');
}
