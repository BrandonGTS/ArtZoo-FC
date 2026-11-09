import type { MediaBudgetPolicy } from '@artzoo/domain';
import {
  listWishOrphanCandidatesTx,
  prepareWishOrphanTx,
  type PrismaClient,
  type WishOrphanBatch
} from '@artzoo/db';
import type { PhotoStorage } from './photo-storage.js';
import { retireWishOrphan } from './stock-retirement.js';
import {
  runPhotoOrphanMaintenance,
  type PhotoOrphanMaintenanceOptions,
  type PhotoOrphanMaintenanceResult
} from './photo-orphan-maintenance.js';
export type WishOrphanMaintenanceOptions = PhotoOrphanMaintenanceOptions;
export type WishOrphanMaintenanceResult = PhotoOrphanMaintenanceResult<WishOrphanBatch>;
export function processWishOrphanMaintenance(
  db: PrismaClient,
  policy: MediaBudgetPolicy,
  storage: PhotoStorage,
  options?: WishOrphanMaintenanceOptions
): Promise<WishOrphanMaintenanceResult> {
  return runPhotoOrphanMaintenance(db, policy, storage, options, {
    scope: 'wish',
    list: listWishOrphanCandidatesTx,
    prepare: prepareWishOrphanTx,
    retire: retireWishOrphan
  });
}
