import { Pool } from 'pg';
import { databasePoolOptions, probeDatabase } from './pool-health.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
export { PrismaClient } from './generated/prisma/client.js';
export { Prisma } from './generated/prisma/client.js';
export type { Account, AccountSession, Invitation, VerificationCode } from './generated/prisma/client.js';

export function databaseConfigured(): boolean {
  return Boolean(
    process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE && process.env.PGPASSWORD
  );
}
const globalDatabase = globalThis as unknown as {
  artzooDatabase?: PrismaClient;
  artzooPool?: Pool;
  artzooDisconnecting?: Promise<void>;
};
function getPool(): Pool {
  if (globalDatabase.artzooDisconnecting) throw new Error('Database is disconnecting');
  if (!databaseConfigured()) throw new Error('Database configuration is required');
  if (!globalDatabase.artzooPool) {
    const pool = new Pool(databasePoolOptions(process.env));
    // A disconnected idle connection must not terminate the process. Requests and
    // health checks still surface failures through their own error boundaries.
    pool.on('error', () => undefined);
    globalDatabase.artzooPool = pool;
  }
  return globalDatabase.artzooPool;
}
export function getDatabase(): PrismaClient {
  if (globalDatabase.artzooDisconnecting) throw new Error('Database is disconnecting');
  return (globalDatabase.artzooDatabase ??= new PrismaClient({
    // Keep direct Prisma disconnect compatible; explicit shutdown also covers probe-only startup.
    adapter: new PrismaPg(getPool(), { disposeExternalPool: true })
  }));
}
/** Close only existing resources. The pool can exist before Prisma ever starts,
 * so $disconnect alone cannot release a failed startup probe's idle handles. */
export function disconnectDatabase(): Promise<void> {
  if (globalDatabase.artzooDisconnecting) return globalDatabase.artzooDisconnecting;
  const client = globalDatabase.artzooDatabase,
    pool = globalDatabase.artzooPool;
  if (!client && !pool) return Promise.resolve();
  delete globalDatabase.artzooDatabase;
  delete globalDatabase.artzooPool;
  const closing = (async () => {
    try {
      await client?.$disconnect();
    } finally {
      if (pool && !pool.ending && !pool.ended) await pool.end();
    }
  })().finally(() => {
    if (globalDatabase.artzooDisconnecting === closing) delete globalDatabase.artzooDisconnecting;
  });
  globalDatabase.artzooDisconnecting = closing;
  return closing;
}

export async function checkDatabase(): Promise<void> {
  // This is the same pool used by the singleton Prisma client, never a new pool.
  await probeDatabase(getPool());
}

export * from './activity-standing.js';
export * from './activity-maintenance.js';
export * from './activity-completion.js';
export * from './activity-attendance-policy.js';
export * from './activity-auto-absence.js';
export * from './activity-series.js';

export * from './lottery-types.js';
export * from './lottery-eligibility.js';
export * from './lottery-maintenance.js';
export { insertAutomaticLotteryEntries } from './lottery-entry-insert.js';
export * from './lottery-checkin-enrollment.js';

export * from './official-event-sync.js';

export { validOfficialEventSourceUrl, validOfficialEventImageUrl } from './official-event-source.js';
export * from './official-event-images.js';

export * from './qq-official-config.js';
export * from './qq-official-notifications.js';

export * from './bot-management.js';

export * from './qq-groups.js';

export * from './transaction-retry.js';
export * from './maintenance-run.js';
export * from './security-cleanup.js';

export * from './media-budget.js';
export * from './media-budget-adapter.js';

export type {
  OfficialComponentAllocation,
  PhotoComponentAllocation,
  MediaComponentAllocation,
  MediaBoundComponentAllocation,
  MediaBoundAllocationTicket
} from './media-stock-components.js';

export { verifiedBoundAllocation } from './media-stock-components.js';

export type {
  QuickIconMutationPlan,
  QuickIconMutationCaptureInput,
  QuickIconSettlementInput,
  QuickIconStockPort
} from './media-quick-icon-contract.js';

export { captureQuickIconMutationTx, settleQuickIconMutationTx } from './media-quick-icon-stock.js';

export type {
  OfficialLiveCandidate,
  OfficialUnusedBatch,
  OfficialStockComponent,
  OfficialCandidateDescription,
  OfficialUnusedDescription,
  OfficialStockPort
} from './official-media-contract.js';

export {
  confirmOfficialCandidate,
  prepareOfficialUnusedBatchTx,
  guardOfficialCandidateAttachmentTx,
  verifiedOfficialLiveCandidate,
  verifiedOfficialUnusedBatch
} from './official-media-retirement.js';

export * from './media-reservation-contract.js';
export * from './media-reservation-maintenance.js';

export * from './media-orphan-contract.js';
export * from './media-orphan-maintenance.js';

export * from './media-wish-orphan-contract.js';
export * from './media-wish-orphan.js';

export { lotteryMediaFencedTx, markLotteryMediaMountedTx } from './media-lottery-mount.js';

export {
  listLotteryOrphanCandidatesTx,
  prepareLotteryOrphanTx,
  verifiedLotteryOrphanBatch
} from './media-lottery-orphan.js';
export * from './media-lottery-orphan-contract.js';

export * from './media-knowledge-orphan-contract.js';
export * from './media-knowledge-orphan.js';
export * from './media-album-comment-orphan-contract.js';
export * from './media-album-comment-orphan.js';

export { processMediaOrphanCompletion } from './media-orphan-completion.js';
export type { MediaOrphanCompletionOptions, MediaOrphanCompletionResult } from './media-orphan-completion.js';
