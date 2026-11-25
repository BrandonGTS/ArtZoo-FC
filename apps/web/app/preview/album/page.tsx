import type { Metadata } from 'next';
import AlbumPreviewContent from './album-preview-content';

export const metadata: Metadata = { title: 'ArtZoo-D-Astra 相册预览' };

export default function AlbumPreviewPage() {
  return <AlbumPreviewContent />;
}
