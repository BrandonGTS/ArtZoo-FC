import type { MediaBudgetPolicy } from '@artzoo/domain';
import {
  listAlbumCommentOrphanCandidatesTx,
  prepareAlbumCommentOrphanTx,
  type PrismaClient,
  type AlbumCommentOrphanBatch
} from '@artzoo/db';
import type { PhotoStorage } from './photo-storage.js';
import { retireAlbumCommentOrphan } from './stock-retirement.js';
import {
  runPhotoOrphanMaintenance,
  type PhotoOrphanMaintenanceOptions,
  type PhotoOrphanMaintenanceResult
} from './photo-orphan-maintenance.js';
export type AlbumCommentOrphanMaintenanceOptions = PhotoOrphanMaintenanceOptions;
export type AlbumCommentOrphanMaintenanceResult = PhotoOrphanMaintenanceResult<AlbumCommentOrphanBatch>;
export function processAlbumCommentOrphanMaintenance(
  db: PrismaClient,
  policy: MediaBudgetPolicy,
  storage: PhotoStorage,
  options?: AlbumCommentOrphanMaintenanceOptions
): Promise<AlbumCommentOrphanMaintenanceResult> {
  return runPhotoOrphanMaintenance(db, policy, storage, options, {
    scope: 'album-comment',
    list: listAlbumCommentOrphanCandidatesTx,
    prepare: prepareAlbumCommentOrphanTx,
    retire: retireAlbumCommentOrphan
  });
}
