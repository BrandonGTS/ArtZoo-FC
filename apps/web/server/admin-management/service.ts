import type { Prisma, PrismaClient, Account } from '@artzoo/db';
import {
  AccountError,
  isMemberId,
  reasonInput,
  type ManagementAccount,
  type ManagementKind,
  type ManagementAudit
} from '@artzoo/domain';
import { AccountService, accountSummary, lock } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import { readPublicSiteSettings } from './public-settings';
type Tx = Prisma.TransactionClient;
type Actor = Awaited<ReturnType<AccountService['requireAccount']>>;
type Body = Record<string, unknown>;
function denied(): never {
  throw new AccountError('FORBIDDEN', '仅超级管理员可以执行此操作', 403);
}
function conflict(message = '内容已更新，请重新读取后操作'): never {
  throw new AccountError('CONFLICT', message, 409);
}
function invalid(message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400);
}
function fields(body: Body, allowed: string[]) {
  if (Object.keys(body).some((k) => !allowed.includes(k))) invalid('提交字段无效');
}
function revision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= 2147483647) invalid('版本无效');
  return Number(value);
}
function role(value: unknown): 'NONE' | 'ADMIN' {
  if (value !== 'NONE' && value !== 'ADMIN') invalid('请选择普通管理员资格');
  return value;
}
function key(value: unknown) {
  if (typeof value !== 'string' || !/^[-_a-zA-Z0-9]{16,128}$/.test(value)) invalid('提交标识无效');
  return value;
}
function identifier(value: string) {
  if (!isMemberId(value)) invalid('账号标识无效');
  return value;
}
function page(url: URL) {
  const number = (name: string, fallback: number, max: number) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    if (!/^[1-9]\d{0,6}$/.test(raw) || Number(raw) > max) invalid('分页参数无效');
    return Number(raw);
  };
  return { page: number('page', 1, 1000000), pageSize: number('pageSize', 20, 100) };
}
function accountView(row: Account): ManagementAccount {
  return { ...accountSummary(row), adminRoleRevision: row.adminRoleRevision };
}
export class AdminManagementService {
  constructor(readonly auth: AccountService) {}
  private async super(tx: Tx | PrismaClient, token?: string | null, expected?: Actor) {
    const actor = await this.auth.requireAccount(tx, token, true);
    if (actor.expiresAt <= this.auth.now())
      throw new AccountError('UNAUTHENTICATED', '登录已过期，请重新登录', 401);
    if (actor.account.adminRole !== 'SUPER_ADMIN') denied();
    if (
      expected &&
      (actor.id !== expected.id ||
        actor.accountId !== expected.accountId ||
        actor.account.membership !== expected.account.membership ||
        actor.account.adminRole !== expected.account.adminRole)
    )
      throw new AccountError('UNAUTHENTICATED', '登录身份已变化，请重新登录', 401);
    return actor;
  }
  private async writeActor(tx: Tx, token: string | null | undefined, expected: Actor, targetId?: string) {
    await lock(tx, 'admin-management:write');
    const target = targetId
      ? await tx.account.findUnique({ where: { id: targetId }, select: { phone: true } })
      : null;
    if (targetId && !target) throw new AccountError('NOT_FOUND', '账号不存在', 404);
    for (const phone of [...new Set([expected.account.phone, ...(target ? [target.phone] : [])])].sort())
      await lock(tx, 'phone:' + phone);
    const other = targetId ?? expected.accountId;
    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${expected.accountId} OR "id"=${other} ORDER BY "id" FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${expected.id} FOR UPDATE`;
    return this.super(tx, token, expected);
  }
  private async command(tx: Tx, actor: Actor, idempotencyKey: string, fingerprint: string) {
    const old = await tx.adminManagementCommand.findUnique({
      where: { actorId_idempotencyKey: { actorId: actor.accountId, idempotencyKey } }
    });
    if (old && old.requestFingerprint !== fingerprint) conflict('同次提交内容已变化，请使用原内容重试');
    return old;
  }
  async accounts(url: URL, token?: string | null) {
    const actor = await this.super(this.auth.db, token),
      paging = page(url),
      query = (url.searchParams.get('query') ?? '').trim();
    if (query.length > 100) invalid('搜索内容过长');
    const result = await this.auth.db.$transaction(
      async (tx) => {
        const where = {
          displayName: { contains: query.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' as const }
        };
        const total = query ? await tx.account.count({ where }) : 0;
        const items = query
          ? (
              await tx.account.findMany({
                where,
                skip: (paging.page - 1) * paging.pageSize,
                take: paging.pageSize,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
              })
            ).map(accountView)
          : [];
        return { items, ...paging, total };
      },
      { isolationLevel: 'RepeatableRead' }
    );
    await this.super(this.auth.db, token, actor);
    return result;
  }
  async settings(token?: string | null) {
    const actor = await this.super(this.auth.db, token);
    const result = await readPublicSiteSettings(this.auth.db);
    await this.super(this.auth.db, token, actor);
    return result;
  }
  async audits(url: URL, token?: string | null) {
    const actor = await this.super(this.auth.db, token),
      paging = page(url),
      scope = url.searchParams.get('scope');
    if (scope !== 'roles' && scope !== 'public-qq') invalid('记录范围无效');
    const kind: ManagementKind = scope === 'roles' ? 'ADMIN_ROLE_CHANGED' : 'PUBLIC_ADMIN_QQ_CHANGED';
    const result = await this.auth.db.$transaction(
      async (tx) => {
        const where = { kind },
          total = await tx.adminManagementAudit.count({ where });
        const rows = await tx.adminManagementAudit.findMany({
          where,
          skip: (paging.page - 1) * paging.pageSize,
          take: paging.pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: {
            actor: { select: { id: true, displayName: true } },
            target: { select: { id: true, displayName: true } }
          }
        });
        const items: ManagementAudit[] = rows.map((a) => ({
          id: a.id,
          kind: a.kind as ManagementKind,
          actor: a.actor,
          target: a.target,
          beforeRole: a.beforeRole,
          afterRole: a.afterRole,
          beforeQq: a.beforeQq,
          afterQq: a.afterQq,
          reason: a.reason,
          createdAt: a.createdAt.toISOString()
        }));
        return { items, ...paging, total };
      },
      { isolationLevel: 'RepeatableRead' }
    );
    await this.super(this.auth.db, token, actor);
    return result;
  }
  async changeRole(targetId: string, body: Body, token?: string | null) {
    identifier(targetId);
    fields(body, ['adminRole', 'expectedRole', 'expectedRevision', 'reason', 'idempotencyKey']);
    const adminRole = role(body.adminRole),
      expectedRole = role(body.expectedRole),
      expectedRevision = revision(body.expectedRevision),
      reason = reasonInput(body.reason),
      idempotencyKey = key(body.idempotencyKey);
    if (adminRole === expectedRole) invalid('请选择不同于当前的管理员资格');
    const fingerprint = tokenDigest(
        JSON.stringify({
          kind: 'ADMIN_ROLE_CHANGED',
          targetId,
          adminRole,
          expectedRole,
          expectedRevision,
          reason
        })
      ),
      actor = await this.super(this.auth.db, token);
    await this.auth.rate('admin-management:' + actor.accountId, 120, 900);
    return this.auth.transaction(async (tx) => {
      await this.writeActor(tx, token, actor, targetId);
      let target = await tx.account.findUniqueOrThrow({ where: { id: targetId } });
      if (target.adminRole === 'SUPER_ADMIN' || target.id === actor.accountId) denied();
      const old = await this.command(tx, actor, idempotencyKey, fingerprint);
      if (!old) {
        if (target.adminRole !== expectedRole || target.adminRoleRevision !== expectedRevision) conflict();
        target = await tx.account.update({
          where: { id: targetId },
          data: { adminRole, adminRoleRevision: { increment: 1 } }
        });
        await tx.adminManagementAudit.create({
          data: {
            actorId: actor.accountId,
            targetAccountId: targetId,
            kind: 'ADMIN_ROLE_CHANGED',
            reason,
            beforeRole: expectedRole,
            afterRole: adminRole,
            createdAt: this.auth.now()
          }
        });
        await tx.adminManagementCommand.create({
          data: {
            actorId: actor.accountId,
            targetAccountId: targetId,
            idempotencyKey,
            requestFingerprint: fingerprint,
            kind: 'ADMIN_ROLE_CHANGED',
            result: accountView(target) as unknown as Prisma.InputJsonValue,
            createdAt: this.auth.now()
          }
        });
      }
      const account = accountView(target);
      await this.super(tx, token, actor);
      return { account, replayed: Boolean(old) };
    });
  }
  async saveSettings(_body: Body, token?: string | null) {
    await this.super(this.auth.db, token);
    throw new AccountError('FORBIDDEN', '公开QQ配置已停用，请使用游客联系留言', 403);
  }
}
