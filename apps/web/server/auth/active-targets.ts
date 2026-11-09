import { Prisma } from '@artzoo/db';
import { lotteryAccountActive } from '@artzoo/db/lottery-eligibility';
import { AccountError } from '@artzoo/domain';
type Tx = Prisma.TransactionClient;
function busy(error: unknown): boolean {
  const seen = new Set<unknown>();
  function visit(value: unknown, depth: number): boolean {
    if (!value || typeof value !== 'object' || depth > 12 || seen.has(value)) return false;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (['code', 'originalCode', 'sqlState', 'sqlstate'].some((key) => record[key] === '55P03')) return true;
    return [
      ...new Set([...Object.keys(record), 'cause', 'meta', 'driverAdapterError', 'originalError', 'error'])
    ].some((key) => visit(record[key], depth + 1));
  }
  return visit(error, 0);
}
/** Read Committed transaction; targets remain SHARE-locked until commit.
 * Never wait on a target while holding a team/series lock: lifecycle owns target then business locks. */
export async function requireActiveTargets(tx: Tx, accountIds: string[]) {
  const ids = [...new Set(accountIds)].sort();
  if (!ids.length) return;
  try {
    await tx.$executeRaw`LOCK TABLE "Account" IN ROW SHARE MODE NOWAIT`;
    const rows = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Account" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR SHARE NOWAIT`
    );
    if (rows.length !== ids.length) throw new AccountError('VALIDATION_ERROR', '请选择已注册站内成员', 400);
    for (const id of ids)
      if (!(await lotteryAccountActive(tx, id)))
        throw new AccountError('VALIDATION_ERROR', '所选账号已停用，请重新选择成员', 400);
  } catch (error) {
    if (busy(error)) throw new AccountError('CONFLICT', '成员状态正在变化，请重新读取后重试', 409);
    throw error;
  }
}
