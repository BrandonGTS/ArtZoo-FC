import { AccountError, localQcAccountAllowed } from '@artzoo/domain';
import {
  lockCurrentQqGroup,
  configuredQqGroups,
  sameQqScope,
  qqPassiveEnabled,
  type Account,
  type Prisma,
  type QqOfficialConfig,
  type QqScope
} from '@artzoo/db';
import { lotteryAccountActive } from '@artzoo/db/lottery-eligibility';
import { AccountService, lock } from '../auth/service';
import { tokenDigest, opaqueToken } from '../auth/crypto';

type Tx = Prisma.TransactionClient;
const bad = (message: string): never => {
  throw new AccountError('FORBIDDEN', message, 403);
};
const conflict = (message: string): never => {
  throw new AccountError('CONFLICT', message, 409);
};
const field = (body: Record<string, unknown>, key: string, max = 128): string => {
  const value = body[key];
  if (typeof value !== 'string' || !value || value.length > max || /\s/.test(value))
    throw new AccountError('VALIDATION_ERROR', '绑定信息无效，请重新发起', 400);
  return value;
};
const identityKey = (scope: QqScope, member: string) =>
  tokenDigest(JSON.stringify([scope.appId, scope.botId, scope.groupOpenId, member]));
export type BoundQqActor = { accountId: string; account: Account; bindingId: string; bindingVersion: number };
async function lockAccount(tx: Tx, account: Account): Promise<void> {
  await lock(tx, `phone:${account.phone}`);
  await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${account.id} FOR NO KEY UPDATE`;
}
export async function resolveBoundActor(
  tx: Tx,
  scope: QqScope,
  memberOpenId: string,
  auth: AccountService
): Promise<BoundQqActor> {
  const initial = await tx.qqOfficialBinding.findFirst({ where: { ...scope, memberOpenId } });
  if (!initial) return bad('请先在网站账号设置中完成QQ群身份绑定');
  if (![1, 2].includes(initial.protocolVersion)) return bad('QQ群绑定版本不可用，请到网站确认后重新绑定');
  const hint = await tx.account.findUnique({ where: { id: initial.accountId } });
  if (!hint) return bad('绑定账号当前不可用，请到网站查看');
  await lockAccount(tx, hint);
  await lock(tx, `qq-identity:${identityKey(scope, memberOpenId)}`);
  const binding = await tx.qqOfficialBinding.findFirst({ where: { ...scope, memberOpenId } });
  if (
    !binding ||
    ![1, 2].includes(binding.protocolVersion) ||
    binding.id !== initial.id ||
    binding.accountId !== hint.id
  )
    return bad('绑定已变化，请到网站重新确认');
  const account = await tx.account.findUnique({ where: { id: hint.id } });
  if (!account || !localQcAccountAllowed(account) || !(await lotteryAccountActive(tx, account.id)))
    return bad('绑定账号当前不可用，请到网站查看');
  void auth;
  return { accountId: account.id, account, bindingId: binding.id, bindingVersion: binding.version };
}
export async function revalidateBoundActor(
  tx: Tx,
  scope: QqScope,
  memberOpenId: string,
  auth: AccountService,
  expected: { accountId: string; bindingId: string; bindingVersion: number }
): Promise<void> {
  const binding = await tx.qqOfficialBinding.findFirst({ where: { ...scope, memberOpenId } });
  if (
    !binding ||
    ![1, 2].includes(binding.protocolVersion) ||
    binding.id !== expected.bindingId ||
    binding.version !== expected.bindingVersion ||
    binding.accountId !== expected.accountId ||
    !(await lotteryAccountActive(tx, expected.accountId))
  )
    bad('绑定或账号状态已变化，请到网站重新确认');
  void auth;
}
export class QqBindingService {
  constructor(
    readonly auth: AccountService,
    readonly config: QqOfficialConfig
  ) {}
  private enabled(): QqScope & { enabledAt: Date } {
    if (
      !qqPassiveEnabled(this.config) ||
      !this.config.target?.enabled ||
      !(this.config.target.testGroupOnly || this.config.target.managed) ||
      this.config.target.enabledAt > this.auth.now() ||
      this.config.mode === 'disabled'
    )
      return bad('QQ群身份绑定暂不可用');
    return this.config.target;
  }
  private async currentGroup(tx: Tx) {
    this.enabled();
    // Match BotGroupService: management lock, group row, account/session.
    if (this.config.managedGroups) await lock(tx, 'bot-management:write');
    if (!(await lockCurrentQqGroup(tx, this.config, this.auth.now()))) bad('群已停用或配置已变化');
  }
  private async actor(tx: Tx, token?: string | null, requireGroup = true) {
    // Managed-group serialization and row lock precede account/session locks.
    if (requireGroup) await this.currentGroup(tx);
    const hint = await this.auth.requireAccount(tx, token);
    await lockAccount(tx, hint.account);
    await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${hint.id} FOR UPDATE`;
    return this.auth.requireAccount(tx, token);
  }
  private async originalSession(tx: Tx, request: { sessionId: string; accountId: string }) {
    const session = await tx.accountSession.findUnique({
      where: { id: request.sessionId },
      include: { account: true }
    });
    if (
      !session ||
      session.accountId !== request.accountId ||
      session.revokedAt ||
      session.expiresAt <= this.auth.now() ||
      !localQcAccountAllowed(session.account) ||
      !(await lotteryAccountActive(tx, request.accountId))
    )
      return bad('生成密钥的登录状态已失效，请重新登录后生成');
    return session;
  }
  async status(token?: string | null) {
    const actor = await this.auth.requireAccount(this.auth.db, token);
    const groups = await this.auth.db.$transaction((tx) => configuredQqGroups(tx, this.config));
    const bindings = await this.auth.db.qqOfficialBinding.findMany({
      where: { accountId: actor.accountId },
      orderBy: { createdAt: 'desc' }
    });
    return {
      enabled: groups.length > 0 && qqPassiveEnabled(this.config),
      groups: groups.map((g) => ({ groupOpenId: g.groupOpenId, label: g.label })),
      bindings: bindings.map((row) => ({
        id: row.id,
        version: row.version,
        groupOpenId: row.groupOpenId,
        confirmedAt: row.confirmedAt.toISOString(),
        requiresRebind: ![1, 2].includes(row.protocolVersion),
        label:
          (groups.find((g) => g.groupOpenId === row.groupOpenId)?.label ?? '已绑定群') +
          ' · ' +
          identityKey(row, row.memberOpenId).slice(0, 8)
      }))
    };
  }
  async initiate(token?: string | null) {
    const scope = this.enabled(),
      initial = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`qq-binding-init:${initial.accountId}`, 5, 900);
    return this.auth.transaction(async (tx) => {
      const actor = await this.actor(tx, token);
      const occupied = await tx.qqOfficialBinding.findFirst({
        where: {
          appId: scope.appId,
          botId: scope.botId,
          groupOpenId: scope.groupOpenId,
          accountId: actor.accountId
        }
      });
      if (occupied) return conflict('此账号在该群已有绑定，请先确认解绑再重新绑定');
      const now = this.auth.now(),
        key = opaqueToken();
      if (actor.expiresAt <= now) return bad('生成密钥的登录状态已失效，请重新登录后生成');
      await tx.qqOfficialBindingKey.updateMany({
        where: { accountId: actor.accountId, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now }
      });
      const request = await tx.qqOfficialBindingKey.create({
        data: {
          accountId: actor.accountId,
          sessionId: actor.id,
          appId: scope.appId,
          botId: scope.botId,
          groupOpenId: scope.groupOpenId,
          enabledAt: scope.enabledAt,
          keyHash: tokenDigest(key),
          expiresAt: new Date(Math.min(now.getTime() + 5 * 60000, actor.expiresAt.getTime())),
          createdAt: now
        }
      });
      return { requestId: request.id, key, expiresAt: request.expiresAt.toISOString() };
    });
  }
  async bindKey(scope: QqScope, memberOpenId: string, key: string): Promise<string> {
    const target = this.enabled();
    if (!sameQqScope(scope, target)) return bad('QQ群目标不匹配');
    if (
      ![scope.appId, scope.botId, scope.groupOpenId, memberOpenId].every(
        (v) => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/\s/u.test(v)
      )
    )
      return bad('绑定来源无效');
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key))
      return bad('绑定密钥无效、已过期或已使用，请回网站重新生成');
    await this.auth.rate(`qq-binding-attempt:${identityKey(scope, memberOpenId)}`, 30, 60);
    return this.auth.transaction(async (tx) => {
      await this.currentGroup(tx);
      const hint = await tx.qqOfficialBindingKey.findUnique({ where: { keyHash: tokenDigest(key) } });
      if (!hint || !sameQqScope(hint, scope)) return bad('绑定密钥无效、已过期或已使用，请回网站重新生成');
      const account = await tx.account.findUnique({ where: { id: hint.accountId } });
      if (!account) return bad('绑定账号不可用，请回网站查看');
      await lockAccount(tx, account);
      await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${hint.sessionId} FOR UPDATE`;
      await lock(tx, `qq-binding-key:${hint.id}`);
      await lock(tx, `qq-identity:${identityKey(scope, memberOpenId)}`);
      await lock(tx, `qq-account:${identityKey(scope, hint.accountId)}`);
      // Re-read every authority after all SQL waits, before either write.
      await this.currentGroup(tx);
      const original = await this.originalSession(tx, hint);
      const request = await tx.qqOfficialBindingKey.findUniqueOrThrow({ where: { id: hint.id } });
      const now = this.auth.now();
      if (
        original.expiresAt <= now ||
        request.consumedAt ||
        request.invalidatedAt ||
        request.expiresAt <= now ||
        request.enabledAt.getTime() !== target.enabledAt.getTime() ||
        !sameQqScope(request, scope)
      )
        return bad('绑定密钥无效、已过期或已使用，请回网站重新生成');
      const occupied = await tx.qqOfficialBinding.findFirst({
        where: {
          appId: scope.appId,
          botId: scope.botId,
          groupOpenId: scope.groupOpenId,
          OR: [{ memberOpenId }, { accountId: request.accountId }]
        }
      });
      if (occupied) return conflict('该QQ群身份或网站账号已有绑定，请由原绑定账号先确认解绑');
      const binding = await tx.qqOfficialBinding.create({
        data: {
          appId: scope.appId,
          botId: scope.botId,
          groupOpenId: scope.groupOpenId,
          accountId: request.accountId,
          memberOpenId,
          protocolVersion: 2,
          confirmedAt: now
        }
      });
      await tx.qqOfficialBindingKey.update({
        where: { id: request.id },
        data: { consumedAt: now, bindingId: binding.id }
      });
      await tx.qqOfficialBindingAudit.create({
        data: {
          accountId: request.accountId,
          action: 'BOUND',
          identityDigest: identityKey(scope, memberOpenId),
          createdAt: now
        }
      });
      return 'QQ群身份绑定成功，可返回网站查看；如需更换，请在网站确认解绑后重新绑定';
    });
  }
  private async ownRequest(tx: Tx, body: Record<string, unknown>, token?: string | null, write = false) {
    const actor = write ? await this.actor(tx, token, false) : await this.auth.requireAccount(tx, token);
    const id = field(body, 'requestId');
    if (write) await lock(tx, `qq-binding-key:${id}`);
    const row = await tx.qqOfficialBindingKey.findUnique({ where: { id } });
    if (!row || row.accountId !== actor.accountId || row.sessionId !== actor.id)
      return bad('绑定请求不存在或登录状态已变化，请重新生成');
    return row;
  }
  async progress(body: Record<string, unknown>, token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const row = await this.ownRequest(tx, body, token);
      const binding =
        row.consumedAt && row.bindingId
          ? await tx.qqOfficialBinding.findFirst({
              where: { id: row.bindingId, accountId: row.accountId, protocolVersion: 2 }
            })
          : null;
      const state = binding
        ? 'BOUND'
        : row.invalidatedAt || row.consumedAt
          ? 'REVOKED'
          : row.expiresAt <= this.auth.now()
            ? 'EXPIRED'
            : 'PENDING';
      return { state, expiresAt: row.expiresAt.toISOString(), ...(binding ? { bindingId: binding.id } : {}) };
    });
  }
  async cancel(body: Record<string, unknown>, token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const row = await this.ownRequest(tx, body, token, true);
      if (row.consumedAt) return conflict('密钥已使用，请查看绑定状态；如需解除请确认解绑');
      if (!row.invalidatedAt)
        await tx.qqOfficialBindingKey.update({
          where: { id: row.id },
          data: { invalidatedAt: this.auth.now() }
        });
      return { cancelled: true };
    });
  }
  // Retired public proofs can never create or upgrade a binding.
  async select(_body: Record<string, unknown>, _token?: string | null): Promise<never> {
    void _body;
    void _token;
    return bad('旧版绑定流程已停用，请重新生成一次性密钥');
  }
  async confirm(_body: Record<string, unknown>, _token?: string | null): Promise<never> {
    void _body;
    void _token;
    return bad('旧版绑定流程已停用，请重新生成一次性密钥');
  }
  async prove(_scope: QqScope, _member: string, _proof: string): Promise<never> {
    void _scope;
    void _member;
    void _proof;
    return bad('旧版绑定流程已停用，请重新生成一次性密钥');
  }
  async unlink(body: Record<string, unknown>, token?: string | null) {
    if (body.confirmed !== true || !Number.isInteger(body.version)) return bad('请明确确认解除QQ群身份绑定');
    return this.auth.transaction(async (tx) => {
      const actor = await this.actor(tx, token, false),
        id = field(body, 'bindingId');
      const initial = await tx.qqOfficialBinding.findFirst({ where: { id, accountId: actor.accountId } });
      if (!initial) return conflict('绑定已变化，请刷新后查看');
      await lock(tx, `qq-identity:${identityKey(initial, initial.memberOpenId)}`);
      const row = await tx.qqOfficialBinding.findFirst({ where: { id, accountId: actor.accountId } });
      if (!row || row.version !== body.version) return conflict('绑定已变化，请刷新后查看');
      await this.auth.requireAccount(tx, token);
      await tx.qqOfficialBinding.delete({ where: { id: row.id } });
      await tx.qqOfficialBindingKey.updateMany({
        where: { accountId: actor.accountId, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: this.auth.now() }
      });
      await tx.qqOfficialChallenge.updateMany({
        where: { accountId: actor.accountId, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: this.auth.now() }
      });
      await tx.qqOfficialBindingAudit.create({
        data: {
          accountId: actor.accountId,
          action: 'UNBOUND',
          identityDigest: identityKey(row, row.memberOpenId),
          createdAt: this.auth.now()
        }
      });
      return { unbound: true };
    });
  }
}
