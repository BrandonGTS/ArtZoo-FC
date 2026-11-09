import type { Prisma } from './generated/prisma/client.js';
type Tx = Pick<Prisma.TransactionClient, '$queryRaw'>;
/** Idempotent row insertion only. Callers retain candidate, lock, timing and notification policy. */
export async function insertAutomaticLotteryEntries(
  tx: Tx,
  lotteryId: string,
  accountIds: string[],
  now: Date
): Promise<string[]> {
  if (!accountIds.length) return [];
  const added = await tx.$queryRaw<{ accountId: string }[]>`
      INSERT INTO "LotteryEntry" ("lotteryId","accountId","state","source","joinedAt","updatedAt")
      SELECT ${lotteryId},candidate."accountId",'ACTIVE','AUTO',${now},${now}
      FROM unnest(${accountIds}::text[]) AS candidate("accountId") ORDER BY candidate."accountId"
      ON CONFLICT ("lotteryId","accountId") DO NOTHING RETURNING "accountId"`;
  return added.map((entry) => entry.accountId).sort();
}
