import type { MediaBudgetPolicy } from '@artzoo/domain';
import {
  listDailyOrphanCandidatesTx,
  prepareDailyOrphanTx,
  type PrismaClient,
  type DailyOrphanBatch
} from '@artzoo/db';
import type { PhotoStorage } from './photo-storage.js';
import { retireDailyOrphan } from './stock-retirement.js';
import {
  runPhotoOrphanMaintenance,
  type PhotoOrphanMaintenanceOptions,
  type PhotoOrphanMaintenanceResult
} from './photo-orphan-maintenance.js';
export type DailyOrphanMaintenanceOptions = PhotoOrphanMaintenanceOptions;
export type DailyOrphanMaintenanceResult = PhotoOrphanMaintenanceResult<DailyOrphanBatch>;
export function processDailyOrphanMaintenance(
  db: PrismaClient,
  policy: MediaBudgetPolicy,
  storage: PhotoStorage,
  options?: DailyOrphanMaintenanceOptions
): Promise<DailyOrphanMaintenanceResult> {
  return runPhotoOrphanMaintenance(db, policy, storage, options, {
    scope: 'daily',
    list: listDailyOrphanCandidatesTx,
    prepare: prepareDailyOrphanTx,
    retire: retireDailyOrphan
  });
}
