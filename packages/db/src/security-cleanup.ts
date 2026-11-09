import type { Prisma, PrismaClient } from './generated/prisma/client.js';
import { createMaintenanceState, runMaintenanceItem, type MaintenanceRunState } from './maintenance-run.js';

const DAY = 86_400_000;
const BATCH_SIZE = 1000;
const MAX_PER_RUN = 10_000;
type Kind = 'rateEvents' | 'sessions' | 'verificationCodes';
/** Only authentication ephemera, never accounts, audit rows, business data or media. */
export async function processSecurityCleanup(
  db: PrismaClient,
  now = new Date(),
  state: MaintenanceRunState = createMaintenanceState()
) {
  const result = { rateEvents: 0, sessions: 0, verificationCodes: 0, failed: 0 };
  const old = new Date(now.getTime() - DAY),
    expired = new Date(now.getTime() - 7 * DAY);
  let remaining = MAX_PER_RUN;
  const active = new Set<Kind>(['rateEvents', 'sessions', 'verificationCodes']);
  const failuresBefore = state.failed;
  // Round-robin prevents a large rate-event backlog starving the two other tables.
  while (remaining > 0 && active.size && !state.stopping()) {
    for (const kind of active) {
      if (remaining === 0 || state.stopping()) break;
      const take = Math.min(BATCH_SIZE, remaining);
      const count = await runMaintenanceItem(state, `cleanup.${kind}`, 'batch', () =>
        db.$transaction(
          async (tx) => {
            if (kind === 'rateEvents') {
              const where: Prisma.AccountRateEventWhereInput = { createdAt: { lt: old } };
              const rows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "AccountRateEvent" WHERE "createdAt" < ${old}
            ORDER BY "id" LIMIT ${take} FOR UPDATE SKIP LOCKED`;
              if (!rows.length) return 0;
              return (
                await tx.accountRateEvent.deleteMany({
                  where: { ...where, id: { in: rows.map((row) => row.id) } }
                })
              ).count;
            }
            if (kind === 'sessions') {
              const where: Prisma.AccountSessionWhereInput = {
                OR: [{ expiresAt: { lt: expired } }, { revokedAt: { lt: expired } }]
              };
              const rows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "AccountSession" WHERE "expiresAt" < ${expired} OR "revokedAt" < ${expired}
            ORDER BY "id" LIMIT ${take} FOR UPDATE SKIP LOCKED`;
              if (!rows.length) return 0;
              return (
                await tx.accountSession.deleteMany({
                  where: { ...where, id: { in: rows.map((row) => row.id) } }
                })
              ).count;
            }
            const where: Prisma.VerificationCodeWhereInput = { expiresAt: { lt: expired } };
            const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "VerificationCode" WHERE "expiresAt" < ${expired}
          ORDER BY "id" LIMIT ${take} FOR UPDATE SKIP LOCKED`;
            if (!rows.length) return 0;
            return (
              await tx.verificationCode.deleteMany({
                where: { ...where, id: { in: rows.map((row) => row.id) } }
              })
            ).count;
          },
          { maxWait: 5000, timeout: 15000 }
        )
      );
      if (count === undefined) {
        active.delete(kind);
        continue;
      }
      result[kind] += count;
      remaining -= count;
      if (count < take) active.delete(kind);
    }
  }
  result.failed = state.failed - failuresBefore;
  return result;
}
