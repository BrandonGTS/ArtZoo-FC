import type {
  MediaReservationCursor,
  DailyOrphanCursor,
  DailyOrphanBatch,
  WishOrphanBatch,
  LotteryOrphanBatch,
  KnowledgeOrphanBatch,
  AlbumCommentOrphanBatch
} from '@artzoo/db';
import { resolve, join } from 'node:path';
import { environmentIdentity } from '@artzoo/domain';
import { createOfficialImagePorts } from '@artzoo/media/official';
import {
  assertLocalQcDatabaseAllowed,
  LocalQcDataBlocked,
  checkDatabase,
  databaseConfigured,
  getDatabase,
  disconnectDatabase,
  processActivityMaintenance,
  processLotteryMaintenance,
  processOfficialEventSync,
  createMaintenanceState,
  logMaintenanceFailure,
  processSecurityCleanup
} from '@artzoo/db';

// Direct CLI/image starts need the same role as compose, before the lazy pool is created.
process.env.ARTZOO_PROCESS_ROLE = 'worker';

const cleanupValue = process.env.ARTZOO_SECURITY_CLEANUP_ENABLED ?? '0';
if (cleanupValue !== '0' && cleanupValue !== '1') {
  console.error(
    JSON.stringify({
      service: 'artzoo-next-worker',
      cleanupEnabled: false,
      error: 'INVALID_SECURITY_CLEANUP_CONFIG'
    })
  );
  throw new Error('Invalid ARTZOO_SECURITY_CLEANUP_ENABLED');
}
const cleanupEnabled = cleanupValue === '1';

const once = process.argv.includes('--once');
const requireDatabase = process.argv.includes('--require-db');
let timer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
let connected = false;
let lastCleanupDay: string | undefined;
let reservationCursor: MediaReservationCursor | null = null;
const orphanCursors: Record<
  'daily' | 'wish' | 'lottery-image' | 'knowledge' | 'album-comment' | 'completion',
  DailyOrphanCursor | null
> = {
  daily: null,
  wish: null,
  'lottery-image': null,
  knowledge: null,
  'album-comment': null,
  completion: null
};
const orphanPending: {
  daily: readonly DailyOrphanBatch[];
  wish: readonly WishOrphanBatch[];
  'lottery-image': readonly LotteryOrphanBatch[];
  knowledge: readonly KnowledgeOrphanBatch[];
  'album-comment': readonly AlbumCommentOrphanBatch[];
} = {
  daily: [],
  wish: [],
  'lottery-image': [],
  knowledge: [],
  'album-comment': []
};
async function runWorkerMediaOrphans(db: ReturnType<typeof getDatabase>) {
  // Keep both flags before module/storage/capability/clock access, including pending retries.
  if (
    process.env.ARTZOO_MEDIA_BUDGET_ENABLED !== '1' ||
    process.env.ARTZOO_MEDIA_CLEANUP_EXECUTE !== '1' ||
    stopping
  )
    return undefined;
  const { mediaBudgetPolicy, isMemberId, mediaBudgetFail } = await import('@artzoo/domain');
  const policy = mediaBudgetPolicy(process.env);
  const { LocalPhotoStorage } = await import('@artzoo/media/photo-storage');
  const { processDailyOrphanMaintenance } = await import('@artzoo/media/daily-orphan-maintenance');
  const { processWishOrphanMaintenance } = await import('@artzoo/media/wish-orphan-maintenance');
  const { processLotteryOrphanMaintenance } = await import('@artzoo/media/lottery-orphan-maintenance');
  const { processKnowledgeOrphanMaintenance } = await import('@artzoo/media/knowledge-orphan-maintenance');
  const { processAlbumCommentOrphanMaintenance } =
    await import('@artzoo/media/album-comment-orphan-maintenance');
  const {
    retireDailyOrphan,
    retireWishOrphan,
    retireLotteryOrphan,
    retireKnowledgeOrphan,
    retireAlbumCommentOrphan
  } = await import('@artzoo/media/stock-retirement');
  const { verifiedLotteryOrphanBatch, runMaintenanceItem, processMediaOrphanCompletion } =
    await import('@artzoo/db');
  const state = createMaintenanceState(() => stopping);
  type Batch =
    | Parameters<typeof retireDailyOrphan>[2]
    | Parameters<typeof retireWishOrphan>[2]
    | Parameters<typeof retireLotteryOrphan>[2]
    | Parameters<typeof retireKnowledgeOrphan>[2]
    | Parameters<typeof retireAlbumCommentOrphan>[2];
  type Scope = 'daily' | 'wish' | 'lottery-image' | 'knowledge' | 'album-comment';
  const roots = (scope: Scope, owner?: string) => {
    const name =
      scope === 'daily'
        ? 'DAILY'
        : scope === 'wish'
          ? 'WISH'
          : scope === 'knowledge'
            ? 'KNOWLEDGE'
            : scope === 'album-comment'
              ? 'PHOTO'
              : 'LOTTERY';
    const directory =
      scope === 'daily'
        ? 'daily'
        : scope === 'wish'
          ? 'wishes'
          : scope === 'knowledge'
            ? 'knowledge'
            : scope === 'album-comment'
              ? 'albums'
              : 'lotteries';
    const original =
      process.env['ARTZOO_' + name + '_ORIGINAL_DIR'] ??
      (process.env.NODE_ENV === 'production' ? '/app/storage/original/' + directory : undefined);
    const derived =
      process.env['ARTZOO_' + name + '_DERIVED_DIR'] ??
      (process.env.NODE_ENV === 'production' ? '/app/storage/derived/' + directory : undefined);
    if (!original || !derived || !original.startsWith('/') || !derived.startsWith('/'))
      return mediaBudgetFail('MEDIA_ORPHAN_STORAGE_CONFIG_REQUIRED');
    if (scope === 'lottery-image') {
      if (typeof owner !== 'string' || !isMemberId(owner))
        return mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
      return new LocalPhotoStorage(join(resolve(original), owner), join(resolve(derived), owner));
    }
    return new LocalPhotoStorage(original, derived);
  };
  type Counts = {
    scanned: number;
    fenced: number;
    retired: number;
    retained: number;
    failed: number;
    pending: number;
  };
  const results: Partial<Record<Scope, Counts>> = {};
  const scope = async <B extends Batch>(
    name: Scope,
    old: readonly B[],
    save: (pending: readonly B[]) => void,
    process: () => Promise<{
      scanned: number;
      fenced: number;
      retired: number;
      retained: number;
      failed: number;
      nextCursor: DailyOrphanCursor | null;
      pending: readonly B[];
    }>,
    retry: (batch: B) => Promise<boolean>
  ) => {
    if (state.stopping()) return;
    if (old.length) {
      const kept: B[] = [];
      let retired = 0;
      const before = state.failed;
      for (let i = 0; i < old.length; i++) {
        if (state.stopping()) {
          kept.push(...old.slice(i));
          break;
        }
        const done = await runMaintenanceItem(state, 'mediaOrphans.' + name + '.retry', 'item', () =>
          retry(old[i]!)
        );
        if (done === true) retired++;
        else kept.push(old[i]!);
      }
      save(kept);
      results[name] = {
        scanned: 0,
        fenced: 0,
        retired,
        retained: 0,
        failed: state.failed - before,
        pending: kept.length
      };
      return; // One existing batch per scope, never accumulate a second batch while retrying.
    }
    const result = await runMaintenanceItem(state, 'mediaOrphans.' + name, 'batch', process);
    if (!result) return;
    if (result.pending.length > 10) mediaBudgetFail('MEDIA_ORPHAN_BATCH_INVALID');
    save(result.pending);
    orphanCursors[name] = result.nextCursor;
    results[name] = {
      scanned: result.scanned,
      fenced: result.fenced,
      retired: result.retired,
      retained: result.retained,
      failed: result.failed,
      pending: result.pending.length
    };
  };
  await scope(
    'daily',
    orphanPending.daily,
    (pending) => {
      orphanPending.daily = pending;
    },
    () =>
      processDailyOrphanMaintenance(db, policy, roots('daily'), {
        after: orphanCursors.daily ?? undefined,
        state
      }),
    async (batch) =>
      retireDailyOrphan(
        db,
        await roots('daily').boundPhotoNamespaces('daily'),
        batch,
        policy,
        () => new Date()
      )
  );
  await scope(
    'wish',
    orphanPending.wish,
    (pending) => {
      orphanPending.wish = pending;
    },
    () =>
      processWishOrphanMaintenance(db, policy, roots('wish'), {
        after: orphanCursors.wish ?? undefined,
        state
      }),
    async (batch) =>
      retireWishOrphan(db, await roots('wish').boundPhotoNamespaces('wish'), batch, policy, () => new Date())
  );
  await scope(
    'lottery-image',
    orphanPending['lottery-image'],
    (pending) => {
      orphanPending['lottery-image'] = pending;
    },
    () =>
      processLotteryOrphanMaintenance(db, policy, (owner) => roots('lottery-image', owner), {
        after: orphanCursors['lottery-image'] ?? undefined,
        state
      }),
    async (batch) => {
      const description = verifiedLotteryOrphanBatch(batch);
      if (!description) return mediaBudgetFail('MEDIA_BOUND_OWNER_REQUIRED');
      return retireLotteryOrphan(
        db,
        await roots('lottery-image', description.accountId).boundPhotoNamespaces('lottery-image'),
        batch,
        policy,
        () => new Date()
      );
    }
  );
  await scope(
    'knowledge',
    orphanPending['knowledge'],
    (pending) => {
      orphanPending['knowledge'] = pending;
    },
    () =>
      processKnowledgeOrphanMaintenance(db, policy, roots('knowledge'), {
        after: orphanCursors['knowledge'] ?? undefined,
        state
      }),
    async (batch) =>
      retireKnowledgeOrphan(
        db,
        await roots('knowledge').boundPhotoNamespaces('knowledge'),
        batch,
        policy,
        () => new Date()
      )
  );
  await scope(
    'album-comment',
    orphanPending['album-comment'],
    (pending) => {
      orphanPending['album-comment'] = pending;
    },
    () =>
      processAlbumCommentOrphanMaintenance(db, policy, roots('album-comment'), {
        after: orphanCursors['album-comment'] ?? undefined,
        state
      }),
    async (batch) =>
      retireAlbumCommentOrphan(
        db,
        await roots('album-comment').boundPhotoNamespaces('album-comment'),
        batch,
        policy,
        () => new Date()
      )
  );
  const completion = await processMediaOrphanCompletion(db, policy, {
    after: orphanCursors.completion ?? undefined,
    state
  });
  orphanCursors.completion = completion.nextCursor;
  return {
    enabled: true,
    scopes: results,
    completion: {
      scanned: completion.scanned,
      tombstoned: completion.tombstoned,
      retained: completion.retained,
      failed: completion.failed
    },
    failed: state.failed
  };
}

let wake: (() => void) | undefined;
const safetyStop = (error: unknown): boolean => {
  try {
    return error instanceof LocalQcDataBlocked;
  } catch {
    return false;
  }
};

async function heartbeat() {
  let database = 'unconfigured';
  let maintenance = { reduced: 0, cancelled: 0, completed: 0, autoAbsent: 0, failed: 0 };
  let lotteries = { processed: 0, simulated: 0, failed: 0, available: false };
  let officialEvents: Awaited<ReturnType<typeof processOfficialEventSync>> = {
    enabled: false,
    processed: false
  };
  let cleanup: Awaited<ReturnType<typeof processSecurityCleanup>> | undefined;
  let mediaReservations:
    { enabled: boolean; scanned: number; expired: number; retained: number; failed: number } | undefined;
  let mediaOrphans: Awaited<ReturnType<typeof runWorkerMediaOrphans>>;
  const failedSteps: string[] = [];
  const run = async (step: string, action: () => Promise<void>) => {
    if (stopping) return;
    try {
      await action();
    } catch (error) {
      if (safetyStop(error)) throw error;
      failedSteps.push(step);
      logMaintenanceFailure(step, 'batch', error);
    }
  };
  try {
    if (databaseConfigured() && !stopping) {
      connected = true;
      try {
        await checkDatabase();
        database = 'ok';
      } catch (error) {
        if (safetyStop(error)) throw error;
        database = 'unavailable';
        logMaintenanceFailure('database', 'probe', error);
      }
      if (database === 'ok' && !stopping) {
        // The guard is outside per-step isolation: a QC violation stops all later work.
        await assertLocalQcDatabaseAllowed(getDatabase());
        const state = createMaintenanceState(() => stopping);
        await run('activity', async () => {
          maintenance = await processActivityMaintenance(getDatabase(), undefined, state);
          if (maintenance.failed) failedSteps.push('activity');
        });
        await run('lottery', async () => {
          lotteries = await processLotteryMaintenance(getDatabase());
          if (lotteries.failed) failedSteps.push('lottery');
        });
        await run('officialEvents', async () => {
          officialEvents = await processOfficialEventSync(
            getDatabase(),
            process.env,
            createOfficialImagePorts()
          );
        });
        if (process.env.ARTZOO_MEDIA_BUDGET_ENABLED === '1') {
          await run('mediaReservations', async () => {
            const { mediaBudgetPolicy } = await import('@artzoo/domain');
            const { processMediaReservationMaintenance } = await import('@artzoo/db');
            const result = await processMediaReservationMaintenance(
              getDatabase(),
              mediaBudgetPolicy(process.env),
              { after: reservationCursor ?? undefined, state: createMaintenanceState(() => stopping) }
            );
            reservationCursor = result.nextCursor;
            // Cursor and writer identities are internal; heartbeat output contains fixed counts only.
            mediaReservations = {
              enabled: result.enabled,
              scanned: result.scanned,
              expired: result.expired,
              retained: result.retained,
              failed: result.failed
            };
            if (result.failed) failedSteps.push('mediaReservations');
          });
          if (process.env.ARTZOO_MEDIA_CLEANUP_EXECUTE === '1')
            await run('mediaOrphans', async () => {
              mediaOrphans = await runWorkerMediaOrphans(getDatabase());
              if (mediaOrphans?.failed) failedSteps.push('mediaOrphans');
            });
        }
        const day = new Date().toISOString().slice(0, 10);
        if (cleanupEnabled && lastCleanupDay !== day)
          await run('cleanup', async () => {
            cleanup = await processSecurityCleanup(
              getDatabase(),
              new Date(),
              createMaintenanceState(() => stopping)
            );
            if (cleanup.failed) failedSteps.push('cleanup');
            else if (!stopping) lastCleanupDay = day;
          });
      }
    } else if (requireDatabase && !stopping) process.exitCode = 1;
  } catch (error) {
    // A safety guard is not a database probe failure, and must retain its failing exit code.
    if (safetyStop(error)) {
      stopping = true;
      process.exitCode = 1;
    }
    failedSteps.push('safety');
    logMaintenanceFailure('safety', 'batch', error);
  }
  if (once && (database === 'unavailable' || failedSteps.length)) process.exitCode = 1;
  console.log(
    JSON.stringify({
      service: 'artzoo-next-worker',
      mode: environmentIdentity.notifications,
      database,
      maintenance,
      lotteries,
      officialEvents,
      cleanupEnabled,
      cleanup,
      mediaReservations,
      mediaOrphans,
      failedSteps,
      time: new Date().toISOString()
    })
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    wake?.();
  });
try {
  do {
    await heartbeat();
    if (once || stopping) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, 30_000);
    });
    wake = undefined;
  } while (!stopping);
} finally {
  if (timer) clearTimeout(timer);
  if (connected) {
    try {
      await disconnectDatabase();
    } catch (error) {
      process.exitCode = 1;
      logMaintenanceFailure('database', 'disconnect', error);
    }
  }
  console.log('Worker stopped');
}
