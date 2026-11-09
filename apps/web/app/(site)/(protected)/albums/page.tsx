import AlbumBrowser from '../../../../components/albums/album-browser';
import { requirePageAccount } from '../../../../server/auth/page-guards';
export default async function AlbumsPage() {
  await requirePageAccount('/albums');
  return <AlbumBrowser />;
}
