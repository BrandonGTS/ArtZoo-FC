import type { MediaBudgetPolicy } from '@artzoo/domain';
import {
  listKnowledgeOrphanCandidatesTx,
  prepareKnowledgeOrphanTx,
  type PrismaClient,
  type KnowledgeOrphanBatch
} from '@artzoo/db';
import type { PhotoStorage } from './photo-storage.js';
import { retireKnowledgeOrphan } from './stock-retirement.js';
import {
  runPhotoOrphanMaintenance,
  type PhotoOrphanMaintenanceOptions,
  type PhotoOrphanMaintenanceResult
} from './photo-orphan-maintenance.js';
export type KnowledgeOrphanMaintenanceOptions = PhotoOrphanMaintenanceOptions;
export type KnowledgeOrphanMaintenanceResult = PhotoOrphanMaintenanceResult<KnowledgeOrphanBatch>;
export function processKnowledgeOrphanMaintenance(
  db: PrismaClient,
  policy: MediaBudgetPolicy,
  storage: PhotoStorage,
  options?: KnowledgeOrphanMaintenanceOptions
): Promise<KnowledgeOrphanMaintenanceResult> {
  return runPhotoOrphanMaintenance(db, policy, storage, options, {
    scope: 'knowledge',
    list: listKnowledgeOrphanCandidatesTx,
    prepare: prepareKnowledgeOrphanTx,
    retire: retireKnowledgeOrphan
  });
}
