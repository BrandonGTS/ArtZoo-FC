import { moderationInput } from '../content-moderation/contract';
import { randomUUID, createHash } from 'node:crypto';
import {
  LotteryMaintenance,
  insertAutomaticLotteryEntries,
  databaseLotteryPorts,
  assertLotteryPublicationCovered,
  markLotteryMediaMountedTx,
  type Prisma
} from '@artzoo/db';
import { readLotteryQualification, readLotteryRow } from '@artzoo/db/lottery-eligibility';
import { AccountError, activityId } from '@artzoo/domain';
import { AccountService, lock } from '../auth/service';
import { commandKey, eligibility, validateLottery, type Identity, type LotteryView } from './contract';
import { assertLotteryImages, lotteryImageParts } from './media';
type Tx = Prisma.TransactionClient;
export type { LotteryRow, LotteryPorts, DrawEligibilityRequest, DrawEligibilitySnapshot } from '@artzoo/db';
import type { LotteryRow, LotteryPorts } from '@artzoo/db';
type Entry = { accountId: string; state: 'ACTIVE' | 'WITHDRAWN'; source: 'MANUAL' | 'AUTO'; joinedAt: Date };
const deny = (message: string): never => {
  throw new AccountError('FORBIDDEN', message, 403);
};
const conflict = (message: string): never => {
  throw new AccountError('CONFLICT', message, 409);
};
export class LotteryService {
  private readonly maintenance: LotteryMaintenance;
  constructor(
    readonly auth: AccountService,
    readonly ports: LotteryPorts = databaseLotteryPorts()
  ) {
    this.maintenance = new LotteryMaintenance(auth.db, {
      ports,
      now: auth.now,
      transaction: (fn) => auth.transaction(fn)
    });
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
  private async actor(
    tx: Tx,
    token: string | null | undefined,
    expected: Awaited<ReturnType<AccountService['requireAccount']>>
  ) {
    await lock(tx, `phone:${expected.account.phone}`);
    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${expected.accountId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${expected.id} FOR UPDATE`;
    return this.revalidate(tx, token, expected);
  }
  private async revalidate(
    tx: Tx,
    token: string | null | undefined,
    expected: Awaited<ReturnType<AccountService['requireAccount']>>
  ) {
    const fresh = await this.auth.requireAccount(tx, token);
    if (fresh.id !== expected.id || fresh.accountId !== expected.accountId) deny('请重新登录');
    if (!(await this.identity(tx, fresh.accountId)).active) deny('账号已停用');
    if (fresh.expiresAt <= this.auth.now()) throw new AccountError('UNAUTHENTICATED', '请先登录', 401);
    return fresh;
  }
  private async load(tx: Tx, id: string): Promise<LotteryRow> {
    return readLotteryRow(tx, id);
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
  private async view(tx: Tx, row: LotteryRow, actorId: string): Promise<LotteryView> {
    if (row.moderatedAt) throw new AccountError('NOT_FOUND', '抽奖不存在或已违规删除', 404);
    const person = await this.identity(tx, actorId);
    if (!person.active) deny('账号已停用');
    const entries = await tx.$queryRaw<
      Entry[]
    >`SELECT "accountId","state","source","joinedAt" FROM "LotteryEntry" WHERE "lotteryId"=${row.id} AND "accountId"=${actorId}`;
    const creator = await tx.account.findUniqueOrThrow({
      where: { id: row.creatorId },
      select: { id: true, displayName: true }
    });
    const qualification = await this.reason(tx, row, person);
    const role = await tx.account.findUniqueOrThrow({ where: { id: actorId }, select: { adminRole: true } });
    return {
      ...this.present(row, person, entries[0], creator, qualification),
      revision: row.revision ?? 0,
      canModerate: role.adminRole === 'SUPER_ADMIN'
    };
  }
  private present(
    row: LotteryRow,
    person: Identity,
    mine: Entry | undefined,
    creator: { id: string; displayName: string | null },
    qualification: { count: number | null; reason: string | null }
  ): LotteryView {
    const actorId = person.id;
    // The public result exposes only game nicknames and prizes, never internal winner account IDs.
    return {
      id: row.id,
      title: row.title,
      kind: row.kind,
      mode: row.mode,
      audience: row.audience,
      month: row.month,
      minDays: row.minDays,
      prizes: row.prizes,
      drawAt: row.drawAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      state: row.state,
      result: row.result
        ? {
            ...row.result,
            winners: row.result.winners.map((w) => ({ gameNickname: w.gameNickname, prize: w.prize }))
          }
        : null,
      creator,
      isCreator: row.creatorId === actorId,
      serverNow: this.auth.now().toISOString(),
      mine: {
        gameNickname: person.displayName || '成员',
        membership: person.membership,
        eligible: !qualification.reason,
        ...qualification,
        prize: row.result?.winners.find((w) => w.accountId === actorId)?.prize ?? null,
        state: mine?.state ?? 'NONE',
        source: mine?.source ?? null,
        joinedAt: mine?.joinedAt.toISOString() ?? null
      }
    };
  }
  async list(
    token?: string | null,
    pageValue: unknown = 1,
    category: unknown = 'all',
    searchValue: unknown = ''
  ) {
    if (typeof searchValue !== 'string' || searchValue.trim().length > 80)
      throw new AccountError('VALIDATION_ERROR', '抽奖标题搜索最多80字', 400);
    const search = searchValue.trim();
    if (!['all', 'ongoing', 'completed'].includes(category as string))
      throw new AccountError('VALIDATION_ERROR', '抽奖分类无效', 400);
    const requestedPage =
      typeof pageValue === 'string' && /^[1-9]\d{0,6}$/.test(pageValue) ? Number(pageValue) : pageValue;
    if (
      typeof requestedPage !== 'number' ||
      !Number.isSafeInteger(requestedPage) ||
      requestedPage < 1 ||
      requestedPage > 1_000_000
    ) {
      throw new AccountError('VALIDATION_ERROR', '页码无效', 400);
    }
    const actor = await this.auth.requireAccount(this.auth.db, token);
    return this.auth.transaction(async (tx) => {
      await this.revalidate(tx, token, actor);
      const [count] = await tx.$queryRaw<
        [{ total: number }]
      >`SELECT count(*)::int AS total FROM "Lottery" WHERE "moderatedAt" IS NULL AND (position(lower(${search}) in lower("title")) > 0) AND (${category} = 'all' OR (${category} = 'ongoing' AND "state" = 'OPEN') OR (${category} = 'completed' AND "state" IN ('DRAWN','CANCELLED')))`;
      const total = count.total,
        pageSize = 5;
      const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
      const rows = await tx.$queryRaw<
        LotteryRow[]
      >`SELECT * FROM "Lottery" WHERE "moderatedAt" IS NULL AND (position(lower(${search}) in lower("title")) > 0) AND (${category} = 'all' OR (${category} = 'ongoing' AND "state" = 'OPEN') OR (${category} = 'completed' AND "state" IN ('DRAWN','CANCELLED'))) ORDER BY "createdAt" DESC,"id" DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
      const items: LotteryView[] = [];
      if (rows.length) {
        // This read context belongs only to this list request. Writes and the final identity check remain fresh.
        const person = await this.identity(tx, actor.accountId);
        if (!person.active) deny('账号已停用');
        const entries = await tx.lotteryEntry.findMany({
          where: { lotteryId: { in: rows.map((row) => row.id) }, accountId: actor.accountId },
          select: { lotteryId: true, accountId: true, state: true, source: true, joinedAt: true }
        });
        const creators = await tx.account.findMany({
          where: { id: { in: [...new Set(rows.map((row) => row.creatorId))] } },
          select: { id: true, displayName: true }
        });
        const entryByLottery = new Map(entries.map((entry) => [entry.lotteryId, entry]));
        const creatorById = new Map(creators.map((creator) => [creator.id, creator]));
        const monthCounts = new Map<string, number>();
        for (const row of rows) {
          const creator = creatorById.get(row.creatorId);
          if (!creator) throw new AccountError('NOT_FOUND', '抽奖发起者不存在', 404);
          let count: number | null = null;
          if (row.kind === 'MONTHLY') {
            if (!this.ports.countMonth)
              throw new AccountError('SERVICE_UNAVAILABLE', '签到资格暂时无法读取', 503);
            if (!monthCounts.has(row.month!))
              monthCounts.set(row.month!, await this.ports.countMonth(tx, person.id, row.month!));
            count = monthCounts.get(row.month!)!;
          }
          const entry = entryByLottery.get(row.id);
          items.push(
            this.present(
              row,
              person,
              entry
                ? { ...entry, state: entry.state as Entry['state'], source: entry.source as Entry['source'] }
                : undefined,
              creator,
              { count, reason: eligibility(row, person, count) }
            )
          );
        }
      }
      await this.revalidate(tx, token, actor);
      return { items, total, page, pageSize };
    });
  }
  async get(id: string, token?: string | null) {
    const key = activityId(id),
      actor = await this.auth.requireAccount(this.auth.db, token);
    return this.auth.transaction(async (tx) => {
      const row = await this.load(tx, key);
      const result = await this.view(tx, row, actor.accountId);
      const fresh = await this.revalidate(tx, token, actor);
      result.canModerate = fresh.account.adminRole === 'SUPER_ADMIN';
      result.revision = row.revision ?? 0;
      await this.revalidate(tx, token, actor);
      return result;
    });
  }
  async create(body: Record<string, unknown>, token?: string | null) {
    const input = validateLottery(body, this.auth.now(), false),
      actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`lottery-create:${actor.accountId}`, 60, 900);
    return this.auth.transaction(async (tx) => {
      await lock(tx, 'lottery:write');
      const fresh = await this.actor(tx, token, actor);
      if (fresh.account.membership !== 'MEMBER' && fresh.account.adminRole === 'NONE')
        deny('仅正式成员和管理员可以发起抽奖');
      await lock(tx, `lottery-create:${fresh.accountId}:${input.idempotencyKey}`);
      await this.revalidate(tx, token, fresh);
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const prior = await tx.$queryRaw<
        LotteryRow[]
      >`SELECT * FROM "Lottery" WHERE "creatorId"=${fresh.accountId} AND "idempotencyKey"=${input.idempotencyKey}`;
      if (prior[0]) {
        if (prior[0].fingerprint !== fingerprint) conflict('发布内容已变化，请重新确认');
        const result = await this.view(tx, prior[0], fresh.accountId);
        await this.revalidate(tx, token, fresh);
        return { lottery: result, replayed: true };
      }
      // Recheck schedule after all final business locks and before writing.
      const now = this.auth.now();
      validateLottery(body, now);
      await assertLotteryImages(input.prizes, fresh.accountId, tx);
      await assertLotteryPublicationCovered(tx, now);
      const id = randomUUID();
      await tx.$executeRaw`INSERT INTO "Lottery" ("id","creatorId","idempotencyKey","fingerprint","title","kind","mode","audience","month","minDays","prizes","drawAt","createdAt") VALUES (${id},${fresh.accountId},${input.idempotencyKey},${fingerprint},${input.title},${input.kind},${input.mode},${input.audience},${input.month},${input.minDays},${JSON.stringify(input.prizes)}::jsonb,${new Date(input.drawAt)},${now})`;
      await markLotteryMediaMountedTx(
        tx,
        fresh.accountId,
        input.prizes.flatMap((prize) => (prize.imageUrl ? [lotteryImageParts(prize.imageUrl).id] : [])),
        now
      );
      const row = await this.load(tx, id);
      if (row.kind === 'ORDINARY')
        await this.notify(tx, row, `lottery:${id}:published:qq`, 'LOTTERY_PUBLISHED', null, now, 'QQ');
      await this.enroll(tx, row, now, fresh.accountId);
      const result = await this.view(tx, row, fresh.accountId);
      await this.revalidate(tx, token, fresh);
      if (row.drawAt <= this.auth.now()) conflict('开奖时间已到，请重新设置');
      return { lottery: result, replayed: false };
    });
  }
  async moderate(id: string, body: Record<string, unknown>, token?: string | null) {
    const key = activityId(id),
      input = moderationInput(body),
      fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`lottery-change:${actor.accountId}`, 120, 900);
    return this.auth.transaction(async (tx) => {
      // Same lock order as participation/draw; row lock also fences check-in AUTO enrollment.
      await lock(tx, 'lottery:write');
      await this.actor(tx, token, actor);
      await lock(tx, `lottery:${key}`);
      await tx.$queryRaw`SELECT id FROM "Lottery" WHERE id=${key} FOR UPDATE`;
      const fresh = await this.revalidate(tx, token, actor);
      if (fresh.account.adminRole !== 'SUPER_ADMIN') deny('仅超级管理员可以违规删除抽奖');
      const row = await readLotteryRow(tx, key, true);
      const [previous] = await tx.$queryRaw<
        { action: string; requestFingerprint: string | null }[]
      >`SELECT action,"requestFingerprint" FROM "LotteryCommand" WHERE "lotteryId"=${key} AND "actorId"=${fresh.accountId} AND "key"=${input.idempotencyKey}`;
      if (previous && (previous.action !== 'moderate' || previous.requestFingerprint !== fingerprint))
        conflict('同次提交内容已变化，请使用原内容重试');
      if (!previous) {
        if (row.moderatedAt) conflict('抽奖已违规删除，请刷新页面');
        if ((row.revision ?? 0) !== input.expectedRevision) conflict('抽奖状态已更新，请重新确认');
        const now = this.auth.now();
        await tx.$executeRaw`UPDATE "Lottery" SET "moderatedAt"=${now},revision=revision+1 WHERE id=${key}`;
        const payload = JSON.stringify({
          reason: input.reason,
          expectedRevision: input.expectedRevision,
          before: {
            state: row.state,
            revision: row.revision ?? 0,
            closedAt: row.closedAt?.toISOString() ?? null
          },
          after: { revision: (row.revision ?? 0) + 1, moderatedAt: now.toISOString() }
        });
        await tx.$executeRaw`INSERT INTO "LotteryCommand" ("lotteryId","actorId","key",action,"requestFingerprint",payload,"createdAt") VALUES (${key},${fresh.accountId},${input.idempotencyKey},'moderate',${fingerprint},${payload}::jsonb,${now})`;
      }
      await this.revalidate(tx, token, fresh);
      return { id: key, moderated: true as const, replayed: Boolean(previous) };
    });
  }
  async change(
    id: string,
    action: 'join' | 'leave' | 'cancel',
    body: Record<string, unknown>,
    token?: string | null
  ) {
    const key = activityId(id),
      requestKey = commandKey(body.idempotencyKey);
    if (Object.keys(body).some((k) => k !== 'idempotencyKey')) conflict('操作字段无效');
    const actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`lottery-change:${actor.accountId}`, 120, 900);
    return this.auth.transaction(async (tx) => {
      await lock(tx, 'lottery:write');
      const fresh = await this.actor(tx, token, actor);
      await lock(tx, `lottery:${key}`);
      await this.revalidate(tx, token, fresh);
      const row = await this.load(tx, key);
      if (action === 'cancel' && row.creatorId !== fresh.accountId) deny('仅发起者可以取消抽奖');
      const previous = await tx.$queryRaw<
        { action: string }[]
      >`SELECT "action" FROM "LotteryCommand" WHERE "lotteryId"=${key} AND "actorId"=${fresh.accountId} AND "key"=${requestKey}`;
      if (previous[0]) {
        if (previous[0].action !== action) conflict('操作内容已变化');
        const result = await this.view(tx, row, fresh.accountId);
        await this.revalidate(tx, token, fresh);
        return { lottery: result, replayed: true };
      }
      if (row.state !== 'OPEN' || row.drawAt <= this.auth.now()) conflict('本场已停止参与变更');
      const now = this.auth.now();
      if (action === 'cancel') {
        const people = await tx.$queryRaw<
          { accountId: string }[]
        >`SELECT "accountId" FROM "LotteryEntry" WHERE "lotteryId"=${key} AND "state"='ACTIVE'`;
        await tx.$executeRaw`UPDATE "Lottery" SET revision=revision+1,"state"='CANCELLED',"closedAt"=${now} WHERE "id"=${key}`;
        for (const p of people)
          await this.notify(
            tx,
            row,
            `lottery:${key}:cancel:${p.accountId}`,
            'LOTTERY_CANCELLED',
            p.accountId,
            now
          );
      } else if (action === 'leave') {
        // Tombstone also handles AUTO enrollment not yet materialized by a scheduler tick.
        await tx.$executeRaw`INSERT INTO "LotteryEntry" ("lotteryId","accountId","state","source","joinedAt","updatedAt") VALUES (${key},${fresh.accountId},'WITHDRAWN','MANUAL',${now},${now}) ON CONFLICT ("lotteryId","accountId") DO UPDATE SET "state"='WITHDRAWN',"updatedAt"=${now}`;
      } else {
        if (row.mode === 'AUTO') deny('本场仅自动纳入，不能手动参加或退出后重新加入');
        const q = await this.reason(tx, row, await this.identity(tx, fresh.accountId));
        if (q.reason) deny(q.reason);
        await tx.$executeRaw`INSERT INTO "LotteryEntry" ("lotteryId","accountId","state","source","joinedAt","updatedAt") VALUES (${key},${fresh.accountId},'ACTIVE','MANUAL',${now},${now}) ON CONFLICT ("lotteryId","accountId") DO UPDATE SET "state"='ACTIVE',"source"='MANUAL',"joinedAt"=${now},"updatedAt"=${now}`;
      }
      await tx.$executeRaw`INSERT INTO "LotteryCommand" ("lotteryId","actorId","key","action","createdAt") VALUES (${key},${fresh.accountId},${requestKey},${action},${now})`;
      const result = await this.view(tx, await this.load(tx, key), fresh.accountId);
      await this.revalidate(tx, token, fresh);
      if (row.drawAt <= this.auth.now()) conflict('开奖时间已到，本次变更未生效');
      return { lottery: result, replayed: false };
    });
  }
  private async enroll(tx: Tx, row: LotteryRow, now: Date, alreadyLockedActor?: string) {
    if (row.mode !== 'AUTO' || row.state !== 'OPEN' || row.drawAt <= now) return;
    const accounts = await tx.account.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    for (const { id } of accounts) {
      // Publication already holds its own account row; others are share locked so lifecycle changes serialize.
      if (id !== alreadyLockedActor)
        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${id} FOR SHARE`;
      const person = await this.identity(tx, id),
        q = await this.reason(tx, row, person);
      if (q.reason) continue;
      const added = await insertAutomaticLotteryEntries(tx, row.id, [id], now);
      if (added.length)
        await this.notify(tx, row, `lottery:${row.id}:enrolled:${id}`, 'LOTTERY_ENROLLED', id, now);
    }
  }
  maintain(id: string) {
    return this.maintenance.maintain(id);
  }
  enqueueResultNotifications(id: string) {
    return this.maintenance.enqueueResultNotifications(id);
  }
  runDueAndEnrollment() {
    return this.maintenance.runDueAndEnrollment();
  }
  simulateNotifications(beforeMark?: (key: string) => Promise<void>) {
    return this.maintenance.simulateNotifications(beforeMark);
  }
}
