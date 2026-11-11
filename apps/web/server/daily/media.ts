// Integration seam: both albums and daily can use these byte-only primitives.
export { processPhoto, withPhotoSlot } from '../media/photo-processor';
export type { PhotoOutput } from '../media/photo-processor';
export type { PhotoStorage, PhotoVariant } from '../media/photo-storage';
import { LocalPhotoStorage } from '../media/photo-storage';
import { resolve, join } from 'node:path';
export function dailyStorage() {
  const base = resolve(/* turbopackIgnore: true */ process.cwd(), '.local', 'daily-media');
  return new LocalPhotoStorage(
    process.env.ARTZOO_DAILY_ORIGINAL_DIR ??
      (process.env.NODE_ENV === 'production'
        ? '/app/storage/original/daily'
        : join(/* turbopackIgnore: true */ base, 'original')),
    process.env.ARTZOO_DAILY_DERIVED_DIR ??
      (process.env.NODE_ENV === 'production'
        ? '/app/storage/derived/daily'
        : join(/* turbopackIgnore: true */ base, 'derived'))
  );
}
