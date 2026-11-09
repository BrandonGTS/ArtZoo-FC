import { mediaBudgetFail, type MediaBudgetPolicy } from '@artzoo/domain';
import {
  createMaintenanceState,
  runMaintenanceItem,
  type PrismaClient,
  type MaintenanceRunState,
  type Prisma,
  type DailyOrphanCursor
} from '@artzoo/db';
import type { PhotoStorage } from './photo-storage.js';

export interface PhotoOrphanMaintenanceOptions {
  now?: () => Date;
  after?: DailyOrphanCursor;
  state?: MaintenanceRunState;
}
export interface PhotoOrphanMaintenanceResult<B extends object> {
  enabled: boolean;
  scanned: number;
  fenced: number;
  retired: number;
  retained: number;
  failed: number;
  nextCursor: DailyOrphanCursor | null;
  /** Same-process capabilities only; retry these to retain any proved partial unlink evidence.
   * Never serialize, persist, expose to HTTP or reconstruct them after a crash. */
  pending: readonly B[];
}
/** Not scheduled by Worker. Explicit dual gate; bounded DB work and lock-free storage IO. */
export async function runPhotoOrphanMaintenance<C extends object, B extends object>(
  db: PrismaClient,
  policy: MediaBudgetPolicy,
  storage: PhotoStorage | null,
  options: PhotoOrphanMaintenanceOptions | undefined,
  ops: {
    scope: 'daily' | 'wish' | 'lottery-image' | 'knowledge' | 'album-comment';
    resolveStorage?(batch: B): PhotoStorage | Promise<PhotoStorage>;
    list(
      tx: Prisma.TransactionClient,
      now: Date,
      after?: DailyOrphanCursor
    ): Promise<{ candidates: readonly C[]; nextCursor: DailyOrphanCursor | null }>;
    prepare(tx: Prisma.TransactionClient, candidate: C, now: Date): Promise<B | null>;
    retire(
      db: PrismaClient,
      namespaces: Awaited<ReturnType<NonNullable<PhotoStorage['boundPhotoNamespaces']>>>,
      batch: B,
      policy: MediaBudgetPolicy,
      now: () => Date
    ): Promise<boolean>;
  }
): Promise<PhotoOrphanMaintenanceResult<B>> {
  const result: PhotoOrphanMaintenanceResult<B> = {
    enabled: false,
    scanned: 0,
    fenced: 0,
    retired: 0,
    retained: 0,
    failed: 0,
    nextCursor: null,
    pending: []
  };
  if (policy.enabled !== true || policy.cleanupExecute !== true) return result;
  result.enabled = true;
  if (typeof db.$connect !== 'function' || typeof db.$disconnect !== 'function')
    mediaBudgetFail('MEDIA_BUDGET_ROOT_CLIENT_REQUIRED');
  const state = options?.state ?? createMaintenanceState();
  const before = state.failed;
  const now = options?.now ?? (() => new Date());
  const txOptions = { maxWait: 5000, timeout: 15000 };
  result.nextCursor = options?.after ?? null;
  if (state.stopping()) return result;
  const page = await runMaintenanceItem(state, ops.scope + 'Orphans.list', 'batch', () =>
    db.$transaction((tx) => ops.list(tx, now(), options?.after), txOptions)
  );
  const pending: B[] = [];
  if (page) {
    let acknowledged = true;
    for (const candidate of page.candidates) {
      if (state.stopping()) {
        acknowledged = false;
        break;
      }
      result.scanned++;
      const batch = await runMaintenanceItem(state, ops.scope + 'Orphans.fence', 'item', () =>
        db.$transaction((tx) => ops.prepare(tx, candidate, now()), txOptions)
      );
      if (batch === undefined) {
        acknowledged = false;
        continue;
      }
      if (batch === null) {
        result.retained++;
        continue;
      }
      result.fenced++;
      const retired = await runMaintenanceItem(state, ops.scope + 'Orphans.retire', 'item', async () => {
        if (ops.resolveStorage) {
          const scopedStorage = await ops.resolveStorage(batch);
          if (!scopedStorage?.boundPhotoNamespaces) mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
          const namespaces = await scopedStorage.boundPhotoNamespaces(ops.scope);
          return ops.retire(db, namespaces, batch, policy, now);
        }
        if (storage === null) mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
        if (!storage.boundPhotoNamespaces) mediaBudgetFail('MEDIA_BOUND_PROOF_REQUIRED');
        const namespaces = await storage.boundPhotoNamespaces(ops.scope);
        return ops.retire(db, namespaces, batch, policy, now);
      });
      if (retired === true) result.retired++;
      else {
        acknowledged = false;
        pending.push(batch);
      }
    }
    if (acknowledged) result.nextCursor = page.nextCursor;
  }
  result.pending = pending;
  result.failed = state.failed - before;
  return result;
}
