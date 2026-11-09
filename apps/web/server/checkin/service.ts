import { randomUUID } from 'node:crypto';
import { enrollMonthlyCheckinAccount, MonthlyLotteryEnrollmentBusy, type Prisma } from '@artzoo/db';
import { AccountError } from '@artzoo/domain';
import { AccountService, lock } from '../auth/service';
import { beijingDay, checkinMonth, type CheckinSummary } from './contract';
type Tx = Prisma.TransactionClient;
/** Read-only natural-month total, including check-ins before a lottery was created. */
export async function countCheckinMonth(tx: Tx, accountId: string, month: string): Promise<number> {
  checkinMonth(month, new Date());
  const rows = await tx.$queryRaw<
    { count: number }[]
  >`SELECT count(*)::int AS count FROM "DailyCheckin" WHERE "accountId" = ${accountId} AND "day" >= ${month + '-01'} AND "day" <= ${month + '-31'}`;
  return rows[0]!.count;
}
export class CheckinService {
  constructor(readonly auth: AccountService) {}
  private async summary(tx: Tx, accountId: string, now: Date, month: string): Promise<CheckinSummary> {
    const today = beijingDay(now);
    const rows = await tx.$queryRaw<
      { day: string }[]
    >`SELECT "day" FROM "DailyCheckin" WHERE "accountId" = ${accountId} AND "day" >= ${month + '-01'} AND "day" <= ${month + '-31'} ORDER BY "day"`;
    const days = rows.map((r) => r.day);
    const checkedInToday =
      month === today.slice(0, 7)
        ? days.includes(today)
        : (
            await tx.$queryRaw<
              { present: boolean }[]
            >`SELECT EXISTS(SELECT 1 FROM "DailyCheckin" WHERE "accountId" = ${accountId} AND "day" = ${today}) AS present`
          )[0]!.present;
    return { month, today, checkedInToday, count: days.length, days, serverNow: now.toISOString() };
  }
  async read(token?: string | null, requestedMonth?: unknown) {
    const actor = await this.auth.requireAccount(this.auth.db, token),
      now = this.auth.now();
    return this.summary(this.auth.db, actor.accountId, now, checkinMonth(requestedMonth, now));
  }
  async submit(body: Record<string, unknown>, token?: string | null) {
    if (Object.keys(body).length) throw new AccountError('VALIDATION_ERROR', '签到请求字段无效', 400);
    const actor = await this.auth.requireAccount(this.auth.db, token);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.auth.transaction(async (tx) => {
          await lock(tx, `phone:${actor.account.phone}`);
          await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${actor.accountId} FOR NO KEY UPDATE`;
          await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id" = ${actor.id} FOR UPDATE`;
          const fresh = await this.auth.requireAccount(tx, token);
          if (fresh.accountId !== actor.accountId) throw new AccountError('FORBIDDEN', '请重新登录', 403);
          // Clock is read only after the locks and identity revalidation, including midnight waits.
          const now = this.auth.now(),
            day = beijingDay(now);
          await tx.$executeRaw`INSERT INTO "DailyCheckin" ("id", "accountId", "day", "createdAt") VALUES (${randomUUID()}, ${fresh.accountId}, ${day}, ${now}) ON CONFLICT ("accountId", "day") DO NOTHING`;
          const result = await this.summary(tx, fresh.accountId, now, day.slice(0, 7));
          await enrollMonthlyCheckinAccount(
            tx,
            {
              accountId: fresh.accountId,
              membership: fresh.account.membership,
              month: result.month,
              count: result.count
            },
            this.auth.now()
          );
          // Sign-in, enrollment and its in-app notice all roll back if the same session expired while writing.
          const final = await this.auth.requireAccount(tx, token);
          if (final.accountId !== fresh.accountId) throw new AccountError('FORBIDDEN', '请重新登录', 403);
          return result;
        });
      } catch (error) {
        if (!(error instanceof MonthlyLotteryEnrollmentBusy)) throw error;
        if (attempt >= 3)
          throw new AccountError('SERVICE_UNAVAILABLE', '抽奖资格正在更新，请稍后再试签到', 503);
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
}
