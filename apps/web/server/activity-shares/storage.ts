import { createPhotoStorage } from '@artzoo/media/cos-routed-storage';
import { resolve, join } from 'node:path';
import { LocalPhotoStorage } from '../media/photo-storage';
export function activityShareStorage() {
  const base = resolve(/* turbopackIgnore: true */ process.cwd(), '.local', 'activity-share-media');
  const legacy = new LocalPhotoStorage(
    process.env.NODE_ENV === 'production'
      ? '/app/storage/original/activity-shares'
      : join(/* turbopackIgnore: true */ base, 'original'),
    process.env.NODE_ENV === 'production'
      ? '/app/storage/derived/activity-shares'
      : join(/* turbopackIgnore: true */ base, 'derived')
  );
  return createPhotoStorage({ scope: 'activity-shares', legacy });
}
