import { createPhotoStorage } from '@artzoo/media/cos-routed-storage';
import { resolve, join } from 'node:path';
import { LocalPhotoStorage } from '../media/photo-storage';
export { processPhoto, withPhotoSlot } from '../media/photo-processor';
export type { PhotoStorage, PhotoVariant } from '../media/photo-storage';
export function wishStorage() {
  const base = resolve(/* turbopackIgnore: true */ process.cwd(), '.local', 'wish-media');
  const legacy = new LocalPhotoStorage(
    process.env.ARTZOO_WISH_ORIGINAL_DIR ??
      (process.env.NODE_ENV === 'production'
        ? '/app/storage/original/wishes'
        : join(/* turbopackIgnore: true */ base, 'original')),
    process.env.ARTZOO_WISH_DERIVED_DIR ??
      (process.env.NODE_ENV === 'production'
        ? '/app/storage/derived/wishes'
        : join(/* turbopackIgnore: true */ base, 'derived'))
  );
  return createPhotoStorage({ scope: 'wishes', legacy });
}
