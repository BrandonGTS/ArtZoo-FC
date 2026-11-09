import { createPhotoStorage } from '@artzoo/media/cos-routed-storage';
import { dirname, join, resolve } from 'node:path';
import { LocalPhotoStorage as SharedPhotoStorage } from '../media/photo-storage';
export type { PhotoStorage, PhotoVariant } from '../media/photo-storage';
function defaults() {
  const cwd = resolve(/* turbopackIgnore: true */ process.cwd());
  return join(
    /* turbopackIgnore: true */ cwd.endsWith('/apps/web') ? dirname(dirname(cwd)) : cwd,
    '.local',
    'album-media'
  );
}
/** Retain existing album env names and paths while sharing byte storage. */
export class LocalPhotoStorage extends SharedPhotoStorage {
  constructor(
    originalDirectory = process.env.ARTZOO_PHOTO_ORIGINAL_DIR ??
      (process.env.NODE_ENV === 'production'
        ? '/app/storage/original/albums'
        : join(/* turbopackIgnore: true */ defaults(), 'original')),
    derivedDirectory = process.env.ARTZOO_PHOTO_DERIVED_DIR ??
      (process.env.NODE_ENV === 'production'
        ? '/app/storage/derived/albums'
        : join(/* turbopackIgnore: true */ defaults(), 'derived'))
  ) {
    super(originalDirectory, derivedDirectory);
  }
}

/** Separate COS locators retain the existing local legacy directory contract. */
export function albumStorage() {
  return createPhotoStorage({ scope: 'albums', legacy: new LocalPhotoStorage() });
}
export function albumCommentStorage() {
  return createPhotoStorage({ scope: 'album-comments', legacy: new LocalPhotoStorage() });
}
