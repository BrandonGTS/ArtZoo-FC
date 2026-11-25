import type { Metadata } from 'next';
import DailyPreviewContent from './daily-preview-content';

export const metadata: Metadata = { title: 'ArtZoo-D-Astra 日常预览' };

export default function DailyPreviewPage() {
  return <DailyPreviewContent />;
}
