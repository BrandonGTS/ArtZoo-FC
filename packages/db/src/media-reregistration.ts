import type { Prisma } from './generated/prisma/client.js';
import { lockEmptyMediaBaselineTarget } from './media-baseline.js';

/** Explicit offline maintenance, never an upload/baseline initializer. Locks out ALL media writers. */
export async function lockMediaReregistration(tx: Prisma.TransactionClient, database: string) {
  const state = await lockEmptyMediaBaselineTarget(tx, database);
  if (!state?.baselineInitializedAt || !state.baselineFingerprint || state.baselineBytes !== 0n)
    throw Error('MEDIA_REGISTER_BASELINE');
  const count = await tx.mediaStoredComponent.count();
  if (count > 10000) throw Error('MEDIA_REGISTER_LIMIT');
  if (await tx.mediaStoredComponent.count({ where: { sourceKind: { not: 'RECEIPT' } } }))
    throw Error('MEDIA_REGISTER_AGGREGATE');
  const [components, receipts, credits] = await Promise.all([
    tx.mediaStoredComponent.aggregate({ _sum: { chargedBytes: true } }),
    tx.mediaUploadReceipt.aggregate({ where: { state: 'COMMITTED' }, _sum: { storedBytes: true } }),
    tx.mediaStorageCredit.aggregate({ _sum: { bytes: true } })
  ]);
  if (
    state.committedBytes !== (components._sum.chargedBytes ?? 0n) ||
    state.committedBytes !== (receipts._sum.storedBytes ?? 0n) ||
    state.creditedBytes !== (credits._sum.bytes ?? 0n)
  )
    throw Error('MEDIA_REGISTER_LEDGER');
  return { state, count };
}

export function readMediaReregistrationPage(tx: Prisma.TransactionClient, after: string) {
  return tx.mediaStoredComponent.findMany({
    where: { id: { gt: after } },
    orderBy: { id: 'asc' },
    take: 128,
    include: { receipt: { include: { components: true } }, retirement: true, credit: true }
  });
}
