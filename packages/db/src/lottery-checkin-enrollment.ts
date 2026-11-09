import type { Prisma } from './generated/prisma/client.js';
type Tx = Prisma.TransactionClient;
/** The caller rolls back before retrying: never wait on a lottery row while holding its account row. */
export class MonthlyLotteryEnrollmentBusy extends Error {}
function lockUnavailable(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const value = error as {
    code?: string;
    meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } };
  };
  return (
    value.code === '55P03' ||
    (value.code === 'P2010' &&
      (value.meta?.code === '55P03' || value.meta?.driverAdapterError?.cause?.originalCode === '55P03'))
  );
}
/** Only the submitting account/month, in the same locked sign-in transaction; no worker or external transport. */
export async function enrollMonthlyCheckinAccount(
  tx: Tx,
  input: {
    accountId: string;
    membership: 'MEMBER' | 'FRIEND';
    month: string;
    count: number;
  },
  now: Date
) {
  let rows: { id: string; title: string }[];
  try {
    rows = await tx.$queryRaw<{ id: string; title: string }[]>`
      SELECT "id","title" FROM "Lottery"
      WHERE "moderatedAt" IS NULL AND "kind"='MONTHLY' AND "mode"='AUTO' AND "state"='OPEN'
        AND "month"=${input.month} AND "minDays"<=${input.count} AND "drawAt">${now}
        AND ("audience"='MEMBER_FRIEND' OR ${input.membership}='MEMBER')
      ORDER BY "id" FOR SHARE NOWAIT`;
  } catch (error) {
    if (lockUnavailable(error)) throw new MonthlyLotteryEnrollmentBusy();
    throw error;
  }
  for (const row of rows) {
    // SQL's trusted clock rechecks cutoff after the selection; never revive a WITHDRAWN entry.
    const inserted = await tx.$executeRaw`
      INSERT INTO "LotteryEntry" ("lotteryId","accountId","state","source","joinedAt","updatedAt")
      SELECT "id",${input.accountId},'ACTIVE','AUTO',${now},${now} FROM "Lottery"
      WHERE "id"=${row.id} AND "moderatedAt" IS NULL AND "state"='OPEN' AND "drawAt">lottery_eligibility_now()
      ON CONFLICT ("lotteryId","accountId") DO NOTHING`;
    if (!inserted) continue;
    const payload = JSON.stringify({ title: row.title, link: `/lotteries/${row.id}` });
    await tx.$executeRaw`
      INSERT INTO "LotteryNotification" ("eventKey","lotteryId","recipientId","channel","kind","payload","createdAt")
      VALUES (${`lottery:${row.id}:enrolled:${input.accountId}`},${row.id},${input.accountId},'IN_APP','LOTTERY_ENROLLED',${payload}::jsonb,${now})
      ON CONFLICT ("eventKey") DO NOTHING`;
  }
}
