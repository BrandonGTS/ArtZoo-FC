import { AccountError, eligibility, type Identity } from '@artzoo/domain';
import type { LotteryPorts, LotteryRow } from './lottery-types.js';
import type { Prisma } from './generated/prisma/client.js';
type Tx = Prisma.TransactionClient;
export class LotteryHistoryUnavailable extends AccountError {
  constructor(message = '开奖时刻资格历史不可用') {
    super('SERVICE_UNAVAILABLE', message, 503);
  }
}
export interface EligibilityQuery {
  lottery: {
    id: string;
    kind: 'ORDINARY' | 'MONTHLY';
    audience: 'MEMBER' | 'MEMBER_FRIEND';
    month: string | null;
    minDays: number | null;
    drawAt: Date;
    createdAt: Date;
  };
  accountIds: string[] | null;
}
export interface EligibilitySnapshot {
  at: Date;
  complete: boolean;
  accounts: {
    identity: { id: string; displayName: string | null; membership: 'MEMBER' | 'FRIEND'; active: boolean };
    registeredAt: Date;
    monthCount: number | null;
  }[];
}
export async function lotteryCoverage(tx: Tx): Promise<{ enabledAt: Date; now: Date }> {
  const rows = await tx.$queryRaw<
    { enabledAt: Date; now: Date }[]
  >`SELECT "enabledAt",lottery_eligibility_now() AS now FROM "LotteryEligibilityControl" WHERE "id"=1`;
  if (!rows[0]) throw new LotteryHistoryUnavailable();
  return rows[0];
}
export async function assertLotteryPublicationCovered(tx: Tx, publishedAt: Date) {
  const coverage = await lotteryCoverage(tx);
  if (publishedAt < coverage.enabledAt) throw new LotteryHistoryUnavailable('Lottery predates activation');
}
/** Current policy, also usable by AccountService before issuing or accepting a session. */
export async function lotteryAccountActive(tx: Tx, id: string): Promise<boolean> {
  const [available] = await tx.$queryRaw<
    { available: boolean }[]
  >`SELECT to_regclass('"LotteryAccountStatus"') IS NOT NULL AS available`;
  if (!available?.available) return true; // Earlier app migrations retain their existing all-active account model.
  const rows = await tx.$queryRaw<
    { active: boolean }[]
  >`SELECT "active" FROM "LotteryAccountStatus" WHERE "accountId"=${id}`;
  if (!rows[0]) throw new LotteryHistoryUnavailable('Missing activated account policy');
  return rows[0].active;
}
/** Internal lifecycle integration primitive. Caller supplies its already-authorized transaction; no public route or new permission is invented. */
export async function setLotteryAccountActive(
  tx: Tx,
  input: { accountId: string; active: boolean; expectedRevision: number; reason: string; changedById: string }
) {
  if (
    typeof input.active !== 'boolean' ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !input.reason.trim() ||
    input.reason.length > 1000
  )
    throw new Error('Invalid account lifecycle command');
  await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${input.accountId} FOR NO KEY UPDATE`;
  const changed =
    await tx.$executeRaw`UPDATE "LotteryAccountStatus" SET "active"=${input.active},"revision"="revision"+1,"reason"=${input.reason.trim()},"changedById"=${input.changedById} WHERE "accountId"=${input.accountId} AND "revision"=${input.expectedRevision}`;
  if (changed !== 1) throw new Error('Account lifecycle revision conflict');
  return { revision: input.expectedRevision + 1 };
}
/** Caller must acquire Account table SHARE before any account row locks (the maintenance engine does so). */
export async function readLotteryEligibilityAt(
  tx: Tx,
  request: EligibilityQuery
): Promise<EligibilitySnapshot> {
  const { lottery, accountIds } = request,
    coverage = await lotteryCoverage(tx),
    at = lottery.drawAt;
  if (lottery.createdAt < coverage.enabledAt || at < coverage.enabledAt || coverage.now < at)
    throw new LotteryHistoryUnavailable('No historical facts before activation or before scheduled draw');
  const facts = await tx.$queryRaw<
    {
      accountId: string;
      displayName: string | null;
      membership: 'MEMBER' | 'FRIEND';
      active: boolean;
      registeredAt: Date;
    }[]
  >`
  SELECT DISTINCT ON ("accountId") "accountId","displayName","membership","active","registeredAt" FROM "LotteryAccountFact"
  WHERE "effectiveAt"<=${at} ORDER BY "accountId","effectiveAt" DESC,"sequence" DESC`;
  const expected = accountIds ? new Set(accountIds) : null;
  const selected = facts.filter((f) => f.registeredAt < at && (!expected || expected.has(f.accountId)));
  if (expected && selected.length !== expected.size)
    throw new LotteryHistoryUnavailable('Missing manual participant facts at scheduled draw');
  const accounts: EligibilitySnapshot['accounts'] = [];
  for (const fact of selected) {
    let monthCount: number | null = null;
    if (lottery.kind === 'MONTHLY') {
      if (!lottery.month) throw new LotteryHistoryUnavailable('Missing month');
      const rows = await tx.$queryRaw<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM "DailyCheckin" WHERE "accountId"=${fact.accountId} AND "day">=${lottery.month + '-01'} AND "day"<=${lottery.month + '-31'} AND "createdAt"<=${at}`;
      monthCount = rows[0]!.count;
    }
    accounts.push({
      identity: {
        id: fact.accountId,
        displayName: fact.displayName,
        membership: fact.membership,
        active: fact.active
      },
      registeredAt: fact.registeredAt,
      monthCount
    });
  }
  return { at, complete: true, accounts };
}

export function databaseLotteryPorts(): LotteryPorts {
  return {
    accountActive: lotteryAccountActive,
    drawEligibilityAt: readLotteryEligibilityAt,
    countMonth: async (tx, id, month) => {
      const rows = await tx.$queryRaw<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM "DailyCheckin" WHERE "accountId"=${id} AND "day">=${month + '-01'} AND "day"<=${month + '-31'}`;
      return rows[0]!.count;
    }
  };
}

/** Read current qualification using the caller's transaction and existing port binding. */
export async function readLotteryQualification(
  tx: Tx,
  row: LotteryRow,
  person: Identity,
  ports: LotteryPorts
) {
  let count: number | null = null;
  if (row.kind === 'MONTHLY') {
    if (!ports.countMonth) throw new AccountError('SERVICE_UNAVAILABLE', '签到资格暂时无法读取', 503);
    count = await ports.countMonth(tx, person.id, row.month!);
  }
  return { count, reason: eligibility(row, person, count) };
}

/** Read the current row using the caller's existing transaction and parameter binding. */
export async function readLotteryRow(tx: Tx, id: string, includeModerated = false): Promise<LotteryRow> {
  const rows = await tx.$queryRaw<LotteryRow[]>`SELECT * FROM "Lottery" WHERE "id"=${id}`;
  if (!rows[0] || (!includeModerated && rows[0].moderatedAt))
    throw new AccountError('NOT_FOUND', '抽奖不存在', 404);
  return rows[0];
}
