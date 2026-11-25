import type { Metadata } from 'next';
import ActivitiesPreviewContent from './activities-preview-content';

export const metadata: Metadata = { title: 'ArtZoo-D-Astra 活动预览' };

export default function ActivitiesPreviewPage() {
  return <ActivitiesPreviewContent />;
}
