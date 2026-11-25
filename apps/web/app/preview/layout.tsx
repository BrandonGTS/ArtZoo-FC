import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import ActivitiesPreviewContent from './activities/activities-preview-content';
import AlbumPreviewContent from './album/album-preview-content';
import DailyPreviewContent from './daily/daily-preview-content';
import PreviewContent from './home/preview-content';
import PreviewNavigation from './home/preview-navigation';

export default function PreviewLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV !== 'development') notFound();

  return (
    <PreviewNavigation
      placeholder={<PreviewContent pane="transition" />}
      pagePreviews={{
        daily: <DailyPreviewContent />,
        activities: <ActivitiesPreviewContent />,
        album: <AlbumPreviewContent />
      }}
    >
      {children}
    </PreviewNavigation>
  );
}
