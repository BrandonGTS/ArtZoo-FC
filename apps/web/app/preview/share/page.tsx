import type { Metadata } from 'next';
import PreviewContent from '../home/preview-content';

export const metadata: Metadata = { title: 'ArtZoo-D-Astra 其他预览' };

export default function OtherPreviewPage() {
  return <PreviewContent pane="share" />;
}
