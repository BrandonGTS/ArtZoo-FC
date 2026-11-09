import { mediaBudgetFail, type MediaBudgetPolicy } from '@artzoo/domain';
import {
  listLotteryOrphanCandidatesTx,
  prepareLotteryOrphanTx,
  verifiedLotteryOrphanBatch,
  type PrismaClient,
  type LotteryOrphanBatch
} from '@artzoo/db';
import type { PhotoStorage } from './photo-storage.js';
import { retireLotteryOrphan } from './stock-retirement.js';
import {
  runPhotoOrphanMaintenance,
  type PhotoOrphanMaintenanceOptions,
  type PhotoOrphanMaintenanceResult
} from './photo-orphan-maintenance.js';
export type LotteryOrphanMaintenanceOptions = PhotoOrphanMaintenanceOptions;
export type LotteryOrphanMaintenanceResult = PhotoOrphanMaintenanceResult<LotteryOrphanBatch>;
/** Unscheduled, dual-gated fixed Lottery scope. Only private verified DB metadata routes owner storage. */
export function processLotteryOrphanMaintenance(
  db: PrismaClient,
  policy: MediaBudgetPolicy,
  storageForAccount: (accountId: string) => PhotoStorage | Promise<PhotoStorage>,
  options?: LotteryOrphanMaintenanceOptions
): Promise<LotteryOrphanMaintenanceResult> {
  return runPhotoOrphanMaintenance(db, policy, null, options, {
    scope: 'lottery-image',
    list: listLotteryOrphanCandidatesTx,
    prepare: prepareLotteryOrphanTx,
    retire: retireLotteryOrphan,
    resolveStorage: (batch) => {
      const verified = verifiedLotteryOrphanBatch(batch);
      if (!verified) mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
      return storageForAccount(verified.accountId);
    }
  });
}
