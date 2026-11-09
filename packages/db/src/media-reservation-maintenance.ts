import type { PrismaClient } from './generated/prisma/client.js';
import { mediaBudgetFail, type MediaBudgetPolicy } from '@artzoo/domain';
import { listMediaReservationCandidates, expireMediaReservationTx } from './media-budget.js';
import { MEDIA_RESERVATION_BATCH_LIMIT, type MediaReservationCursor } from './media-reservation-contract.js';
import { createMaintenanceState, runMaintenanceItem, type MaintenanceRunState } from './maintenance-run.js';

export interface MediaReservationMaintenanceOptions {
  readonly now?: () => Date;
  readonly after?: MediaReservationCursor;
  readonly state?: MaintenanceRunState;
}
export interface MediaReservationMaintenanceResult {
  enabled: boolean;
  scanned: number;
  expired: number;
  retained: number;
  failed: number;
  nextCursor: MediaReservationCursor | null;
}

/** No IO, storage credits or UNKNOWN transitions. Core owns enrollment, byte bounds and lock order. */
export async function processMediaReservationMaintenance(
  db: PrismaClient,
  policy: MediaBudgetPolicy,
  options?: MediaReservationMaintenanceOptions
): Promise<MediaReservationMaintenanceResult> {
  const result: MediaReservationMaintenanceResult = {
    enabled: false,
    scanned: 0,
    expired: 0,
    retained: 0,
    failed: 0,
    nextCursor: null
  };
  // This must precede even db/options property access. OFF never validates unrelated configuration.
  if (policy.enabled !== true) return result;
  result.enabled = true;
  // Pinned Prisma permits nested transactions on an itx client; require both actual root markers.
  if (typeof db.$connect !== 'function' || typeof db.$disconnect !== 'function')
    mediaBudgetFail('MEDIA_RESERVATION_ROOT_REQUIRED');
  const state = options?.state ?? createMaintenanceState();
  const failuresBefore = state.failed;
  result.nextCursor = options?.after ?? null;
  if (state.stopping()) return result;
  const clock = options?.now ?? (() => new Date());
  const transactionOptions = { maxWait: 5000, timeout: 15000 };
  // Do not expose candidates until the ordinary bounded list transaction has a confirmed ACK.
  const page = await runMaintenanceItem(state, 'mediaReservations.list', 'batch', () =>
    db.$transaction(
      (tx) =>
        listMediaReservationCandidates(tx, {
          now: clock(),
          after: options?.after,
          limit: MEDIA_RESERVATION_BATCH_LIMIT
        }),
      transactionOptions
    )
  );
  if (page !== undefined) {
    // The opaque core page caps total stored bytes at 256MiB, including changed-generation checks.
    // One page per heartbeat; no wrap, retries or unbounded scans in this invocation.
    if (page.candidates.length > MEDIA_RESERVATION_BATCH_LIMIT)
      mediaBudgetFail('MEDIA_RESERVATION_BATCH_INVALID');
    let acknowledged = true;
    for (const candidate of page.candidates) {
      if (state.stopping()) {
        acknowledged = false;
        break;
      }
      result.scanned++;
      const outcome = await runMaintenanceItem(state, 'mediaReservations.expire', 'item', () =>
        db.$transaction((tx) => expireMediaReservationTx(tx, candidate, clock()), transactionOptions)
      );
      if (outcome === undefined) acknowledged = false;
      else if (outcome.kind === 'expired') result.expired++;
      else result.retained++;
    }
    // An uncertain ACK is not success. Never replay that capability or advance past it here.
    // A later invocation obtains fresh authoritative candidates; terminal rows cannot release twice.
    if (acknowledged) result.nextCursor = page.nextCursor;
  }
  result.failed = state.failed - failuresBefore;
  return result;
}
