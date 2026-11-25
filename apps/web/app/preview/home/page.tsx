import type { Metadata } from 'next';
import PreviewContent from './preview-content';

export const metadata: Metadata = { title: 'ArtZoo-D-Astra 首页预览' };

export default function HomePreview() {
  return <PreviewContent pane="home" />;
}
