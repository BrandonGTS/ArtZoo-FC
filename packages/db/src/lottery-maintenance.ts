import { insertAutomaticLotteryEntries } from './lottery-entry-insert.js';
import { randomInt, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from './generated/prisma/client.js';
import {
  AccountError,
  eligibility,
  monthBounds,
  prizeCount,
  selectWinners,
  type Identity,
  type Prize,
  type DrawResult
} from '@artzoo/domain';
import type { LotteryRow, Entry, LotteryPorts, DrawEligibilitySnapshot } from './lottery-types.js';
import { databaseLotteryPorts, readLotteryQualification, readLotteryRow } from './lottery-eligibility.js';
type Tx = Prisma.TransactionClient;
async function lock(tx: Tx, key: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`;
}
const deny = (message: string): never => {
  throw new AccountError('FORBIDDEN', message, 403);
};
class AccountFenceBusy extends Error {}
class DrawFenceRequired extends Error {}
function accountLockBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as {
    code?: string;
    meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } };
  };
  return (
    e.code === '55P03' ||
    (e.code === 'P2010' &&
      (e.meta?.code === '55P03' || e.meta?.driverAdapterError?.cause?.originalCode === '55P03'))
  );
}
async function retryDrawFence<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof DrawFenceRequired)) throw error;
    return action();
  }
}
async function retryAccountFence<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++)
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof AccountFenceBusy)) throw error;
      if (attempt >= 3)
        throw new AccountError('SERVICE_UNAVAILABLE', '账号状态正在变更，稍后自动重试开奖', 503);
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
}
export interface LotteryMaintenanceOptions {
  now?: () => Date;
  ports?: LotteryPorts;
  transaction?: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}
export class LotteryMaintenance {
  failures = 0;
  readonly now: () => Date;
  readonly ports: LotteryPorts;
  readonly transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  constructor(
    readonly db: PrismaClient,
    options: LotteryMaintenanceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.ports = options.ports ?? databaseLotteryPorts();
    this.transaction =
      options.transaction ?? ((fn) => db.$transaction(fn, { maxWait: 5000, timeout: 15000 }));
  }
  private async identity(tx: Tx, id: string): Promise<Identity> {
    const a = await tx.account.findUnique({
      where: { id },
      select: { id: true, displayName: true, membership: true }
    });
    if (!a) return deny('账号不存在');
    return { ...a, active: this.ports.accountActive ? await this.ports.accountActive(tx, id) : true };
  }
  private async reason(tx: Tx, row: LotteryRow, person: Identity) {
    return readLotteryQualification(tx, row, person, this.ports);
  }
  private async load(tx: Tx, id: string): Promise<LotteryRow> {
    return readLotteryRow(tx, id, true);
  }
  private async notify(
    tx: Tx,
    row: LotteryRow,
    key: string,
    kind: string,
    recipientId: string | null,
    now: Date,
    channel: 'QQ' | 'IN_APP' = 'IN_APP'
  ) {
    const payload = JSON.stringify({
      title: row.title,
      link: `/lotteries/${row.id}`,
      ...(kind === 'LOTTERY_WON'
        ? { prize: row.result?.winners.find((w) => w.accountId === recipientId)?.prize }
        : {})
    });
    await tx.$executeRaw`INSERT INTO "LotteryNotification" ("eventKey","lotteryId","recipientId","channel","kind","payload","createdAt") VALUES (${key},${row.id},${recipientId},${channel},${kind},${payload}::jsonb,${now}) ON CONFLICT ("eventKey") DO NOTHING`;
  }
  private async addAutomaticEntries(
    tx: Tx,
    row: LotteryRow,
    accountIds: string[],
    now: Date
  ): Promise<string[]> {
    return insertAutomaticLotteryEntries(tx, row.id, accountIds, now);
  }
  private async enroll(tx: Tx, row: LotteryRow, now: Date) {
    if (
      row.mode !== 'AUTO' ||
      row.state !== 'OPEN' ||
      row.drawAt <= now ||
      (row.kind === 'MONTHLY' && monthBounds(row.month!).end > now)
    )
      return;
    // Existing ACTIVE and WITHDRAWN entries are not candidates. Draw still uses the full T snapshot.
    const accounts = await tx.account.findMany({
      where: { lotteryEntries: { none: { lotteryId: row.id } } },
      select: { id: true },
      orderBy: { id: 'asc' }
    });
    const qualified: string[] = [];
    for (const { id } of accounts) {
      // Never wait on row-first lifecycle/check-in writers while holding the lottery advisory locks.
      try {
        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${id} FOR SHARE NOWAIT`;
      } catch (error) {
        if (accountLockBusy(error)) throw new AccountFenceBusy();
        throw error;
      }
      const person = await this.identity(tx, id),
        q = await this.reason(tx, row, person);
      if (!q.reason) qualified.push(id);
    }
    const added = await this.addAutomaticEntries(tx, row, qualified, now);
    for (const id of added)
      await this.notify(tx, row, `lottery:${row.id}:enrolled:${id}`, 'LOTTERY_ENROLLED', id, now);
  }
  /** Scheduler entry: run before deadline to continuously add newly qualified accounts; draw only once when due. */
  async maintain(id: string) {
    const outcome = await retryDrawFence(() =>
      retryAccountFence(() =>
        this.transaction(async (tx) => {
          await lock(tx, 'lottery:write');
          // This read is only a lock plan. Due draws re-read the same immutable T after the fence.
          const planned = await this.load(tx, id),
            plannedNow = this.now();
          if (planned.moderatedAt) return { state: 'MODERATED', result: planned.result };
          if (planned.state !== 'OPEN') return { state: planned.state, result: planned.result };
          const due = plannedNow >= planned.drawAt;
          if (!due && planned.mode !== 'AUTO') return { state: 'OPEN', result: null };
          if (due) {
            // Original table + every Account-row NOWAIT fence, always before the lottery lock.
            const [fence] = await tx.$queryRaw<
              { locked: boolean }[]
            >`SELECT lottery_try_account_fence() AS locked`;
            if (!fence?.locked) throw new AccountFenceBusy();
          }
          await lock(tx, `lottery:${id}`);
          const row = await this.load(tx, id),
            now = this.now();
          if (row.moderatedAt) return { state: 'MODERATED', result: row.result };
          if (row.state !== 'OPEN') return { state: row.state, result: row.result };
          // Time crossed while waiting. Roll back this transaction before acquiring the broader fence.
          if (!due && now >= row.drawAt) throw new DrawFenceRequired();
          if (now < row.drawAt) {
            await this.enroll(tx, row, now);
            if (this.now() >= row.drawAt) throw new DrawFenceRequired();
            return { state: 'OPEN', result: null };
          }
          const entries = await tx.$queryRaw<
            Entry[]
          >`SELECT "accountId","state","source","joinedAt" FROM "LotteryEntry" WHERE "lotteryId"=${id} AND "state"='ACTIVE' ORDER BY "accountId"`;
          const snapshot = await this.drawSnapshot(
            tx,
            row,
            row.mode === 'AUTO' ? null : entries.map((entry) => entry.accountId)
          );
          const qualified = snapshot.accounts
            .filter((record) => !eligibility(row, record.identity, record.monthCount))
            .map((record) => record.identity);
          if (row.mode === 'AUTO') {
            // Complete as-of-T universe fills tick gaps; ON CONFLICT preserves explicit opt-outs and manual reentry.
            await this.addAutomaticEntries(
              tx,
              row,
              qualified.map((person) => person.id),
              now
            );
          }
          const active =
            row.mode === 'AUTO'
              ? await tx.$queryRaw<
                  Entry[]
                >`SELECT "accountId","state","source","joinedAt" FROM "LotteryEntry" WHERE "lotteryId"=${id} AND "state"='ACTIVE' ORDER BY "accountId"`
              : entries;
          const activeIds = new Set(active.map((entry) => entry.accountId));
          const people = qualified.filter((person) => activeIds.has(person.id));
          const winners = selectWinners(people, row.prizes as Prize[], this.ports.randomInt ?? randomInt);
          const result: DrawResult = {
            drawnAt: row.drawAt.toISOString(),
            processedAt: now.toISOString(),
            participants: people.length,
            winners,
            unassigned: prizeCount(row.prizes) - winners.length
          };
          await tx.$executeRaw`UPDATE "Lottery" SET revision=revision+1,"state"='DRAWN',"result"=${JSON.stringify(result)}::jsonb,"closedAt"=${now} WHERE "id"=${id}`;
          return { state: 'DRAWN', result };
        })
      )
    );
    // Commit the immutable result first. Even outbox construction failure must never roll it back.
    if (outcome.state === 'DRAWN') await this.enqueueResultNotifications(id);
    return outcome;
  }
  private async drawSnapshot(
    tx: Tx,
    row: LotteryRow,
    accountIds: string[] | null
  ): Promise<DrawEligibilitySnapshot> {
    const unavailable = (): never => {
      throw new AccountError('SERVICE_UNAVAILABLE', '开奖时刻资格快照暂不可用，本场尚未开奖', 503);
    };
    if (!this.ports.drawEligibilityAt) return unavailable();
    const result = await this.ports.drawEligibilityAt(tx, {
      lottery: {
        id: row.id,
        kind: row.kind,
        audience: row.audience,
        month: row.month,
        minDays: row.minDays,
        drawAt: row.drawAt,
        createdAt: row.createdAt
      },
      accountIds
    });
    if (
      !result ||
      result.complete !== true ||
      !(result.at instanceof Date) ||
      result.at.getTime() !== row.drawAt.getTime() ||
      !Array.isArray(result.accounts)
    )
      return unavailable();
    const ids = new Set<string>(),
      expected = accountIds ? new Set(accountIds) : null;
    for (const record of result.accounts) {
      const person = record?.identity;
      if (
        !person ||
        typeof person.id !== 'string' ||
        ids.has(person.id) ||
        (expected && !expected.has(person.id)) ||
        typeof person.active !== 'boolean' ||
        !['MEMBER', 'FRIEND'].includes(person.membership) ||
        (person.displayName !== null && typeof person.displayName !== 'string') ||
        !(record.registeredAt instanceof Date) ||
        !Number.isFinite(record.registeredAt.getTime()) ||
        record.registeredAt >= row.drawAt
      )
        return unavailable();
      if (
        row.kind === 'MONTHLY' &&
        (!Number.isSafeInteger(record.monthCount) ||
          record.monthCount! < 0 ||
          record.monthCount! > monthBounds(row.month!).days)
      )
        return unavailable();
      if (row.kind === 'ORDINARY' && record.monthCount !== null) return unavailable();
      ids.add(person.id);
    }
    if (expected && ids.size !== expected.size) return unavailable();
    return result;
  }
  async enqueueResultNotifications(id: string) {
    await this.transaction(async (tx) => {
      await lock(tx, 'lottery:write');
      await lock(tx, `lottery-result-notices:${id}`);
      const row = await this.load(tx, id);
      if (row.moderatedAt || row.state !== 'DRAWN' || !row.result) return;
      const now = this.now();
      if (row.mode === 'AUTO') {
        const entries = await tx.$queryRaw<
          Entry[]
        >`SELECT "accountId","state","source","joinedAt" FROM "LotteryEntry" WHERE "lotteryId"=${id} AND "source"='AUTO'`;
        for (const entry of entries)
          await this.notify(
            tx,
            row,
            `lottery:${id}:enrolled:${entry.accountId}`,
            'LOTTERY_ENROLLED',
            entry.accountId,
            now
          );
      }
      for (const winner of row.result.winners) {
        await this.notify(
          tx,
          row,
          `lottery:${id}:won:${winner.accountId}:inapp`,
          'LOTTERY_WON',
          winner.accountId,
          now
        );
        await this.notify(
          tx,
          row,
          `lottery:${id}:won:${winner.accountId}:qq`,
          'LOTTERY_WON',
          winner.accountId,
          now,
          'QQ'
        );
      }
    });
  }
  async runDueAndEnrollment() {
    // Candidate pruning only: maintain rechecks state/time after the original locks and account fence.
    const now = this.now();
    const rows = await this.db.$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "Lottery" WHERE "moderatedAt" IS NULL AND "state"='OPEN' AND ("mode"='AUTO' OR "drawAt"<=${now}) ORDER BY "drawAt","id" LIMIT 100`;
    this.failures = 0;
    let processed = 0;
    for (const row of rows)
      try {
        await this.maintain(row.id);
        processed++;
      } catch {
        this.failures++;
      }
    const repair = await this.db.$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "Lottery" WHERE "moderatedAt" IS NULL AND "state"='DRAWN' AND NOT EXISTS (SELECT 1 FROM "LotteryNotification" n WHERE n."lotteryId"="Lottery"."id" AND n."kind"='LOTTERY_WON') AND jsonb_array_length("result"->'winners')>0 ORDER BY "drawAt","id" LIMIT 100`;
    for (const row of repair)
      try {
        await this.enqueueResultNotifications(row.id);
      } catch {
        this.failures++;
      }
    return processed;
  }
  /** Separate transaction from draw, simulation only. Retry never calls maintain or selects winners. */
  async simulateNotifications(beforeMark?: (key: string) => Promise<void>) {
    const rows = await this.db.$queryRaw<
      { eventKey: string }[]
    >`SELECT "eventKey" FROM "LotteryNotification" WHERE "simulatedAt" IS NULL ORDER BY "createdAt","eventKey" LIMIT 100`;
    for (const row of rows)
      await this.transaction(async (tx) => {
        await lock(tx, `lottery-notification:${row.eventKey}`);
        const pending = await tx.$queryRaw<
          { eventKey: string }[]
        >`SELECT "eventKey" FROM "LotteryNotification" WHERE "eventKey"=${row.eventKey} AND "simulatedAt" IS NULL`;
        if (!pending.length) return;
        if (beforeMark) await beforeMark(row.eventKey);
        await tx.$executeRaw`UPDATE "LotteryNotification" SET "simulatedAt"=${this.now()},"attempts"="attempts"+1 WHERE "eventKey"=${row.eventKey}`;
      });
    return rows.length;
  }
}

export async function processLotteryMaintenance(db: PrismaClient, options: LotteryMaintenanceOptions = {}) {
  const worker = new LotteryMaintenance(db, options);
  const processed = await worker.runDueAndEnrollment();
  const simulated = await worker.simulateNotifications();
  return { processed, simulated, failed: worker.failures, available: true };
}
