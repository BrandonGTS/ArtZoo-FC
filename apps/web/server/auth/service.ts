import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { invitationLinkUnavailable, type InvitationCipher } from './invitation-cipher';
import {
  BEIJING_OFFSET_MS,
  AccountError,
  ACCOUNT_RULES,
  anonymousSession,
  canAdminister,
  canChangeAccountMembership,
  invalid,
  membershipInput,
  reasonInput,
  textInput,
  validatePassword,
  validateGameNickname,
  validateGameServer,
  type AccountSummary,
  type InvitationSummary,
  type SessionSnapshot,
  type VerificationPurpose
} from '@artzoo/domain';
import type { Account, Invitation, Prisma, PrismaClient } from '@artzoo/db';
import { withTransactionRetry } from '@artzoo/db/transaction-retry';
import { lotteryAccountActive } from '@artzoo/db/lottery-eligibility';
import {
  DUMMY_PASSWORD_HASH,
  hashSecret,
  opaqueToken,
  tokenDigest,
  verificationCode,
  verifySecret
} from './crypto';
import { assertSmsEnvironment, authConfig, type PhonePolicy, type SmsSender } from './ports';

type Tx = Prisma.TransactionClient;
type Body = Record<string, unknown>;
type ListedInvitation = Invitation & { createdBy: { id: string; displayName: string | null } };
const creator = { createdBy: { select: { id: true, displayName: true } } } as const;
const DAY = 86_400_000;
export interface ServiceOptions {
  phone: PhonePolicy;
  sms: SmsSender;
  invitationCipher?: InvitationCipher;
  environment?: string;
  now?: () => Date;
  loginPhoneLimit?: number;
  loginSourceLimit?: number;
  loginPhoneSourceLimit?: number;
  writeSourceLimit?: number;
  writeAccountLimit?: number;
  writeGlobalLimit?: number;
  smsDailyLimit?: number;
  smsResponseDelay?: (milliseconds: number) => Promise<void>;
}
export function accountSummary(account: Account): AccountSummary {
  return {
    id: account.id,
    phoneMasked: `***${account.phone.slice(-4)}`,
    displayName: account.displayName,
    membership: account.membership,
    adminRole: account.adminRole,
    gameRegion: account.gameRegion ?? null,
    gameServer: account.gameServer ?? null
  };
}
export function invitationSummary(
  invitation: ListedInvitation,
  now: Date,
  cipherReady = false
): InvitationSummary {
  return {
    id: invitation.id,
    membership: invitation.membership,
    usageMode: invitation.usageMode,
    status: invitation.usedAt
      ? 'USED'
      : invitation.revokedAt
        ? 'REVOKED'
        : invitation.expiresAt <= now
          ? 'EXPIRED'
          : 'ACTIVE',
    createdAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
    usedAt: invitation.usedAt?.toISOString() ?? null,
    revokedAt: invitation.revokedAt?.toISOString() ?? null,
    createdBy: invitation.createdBy,
    linkAvailable:
      cipherReady &&
      !invitation.removedAt &&
      !invitation.usedAt &&
      !invitation.revokedAt &&
      invitation.expiresAt > now
  };
}
export function checkInvitation(invitation: Invitation | null, now: Date): asserts invitation is Invitation {
  if (!invitation || invitation.removedAt) throw new AccountError('INVITATION_INVALID', '邀请链接无效', 410);
  if (invitation.usedAt) throw new AccountError('INVITATION_USED', '此邀请已使用', 410);
  if (invitation.revokedAt) throw new AccountError('INVITATION_REVOKED', '此邀请已撤销', 410);
  if (invitation.expiresAt <= now) throw new AccountError('INVITATION_EXPIRED', '此邀请已过期', 410);
}
export async function lock(tx: Tx, key: string): Promise<void> {
  // Transaction-scoped PostgreSQL lock also covers keys whose row does not exist yet.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
}
/** Read-only counterpart: the exact same key/hash namespace, released with its transaction. */
export async function lockShared(tx: Tx, key: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))::text`;
}
export function gameNicknameTaken(): AccountError {
  return new AccountError('GAME_NICKNAME_TAKEN', '该服务器的游戏昵称已注册，请核对服务器和昵称', 409, {
    displayName: '该服务器的游戏昵称已注册'
  });
}
export function isGameNicknameConstraint(error: unknown): boolean {
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const pair = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.length === 2 &&
    value.includes('gameServer') &&
    value.includes('displayName');
  const knownIndex = 'Account_gameServer_displayName_key';
  const problem = object(error);
  if (problem?.code !== 'P2002') return false;
  const meta = object(problem.meta);
  if (pair(meta?.target) || meta?.target === knownIndex) return true;
  // Prisma 7's pg adapter reports the original constraint via cause, not meta.target.
  const cause = object(object(meta?.driverAdapterError)?.cause);
  if (cause?.kind !== 'UniqueConstraintViolation' || (cause.table !== undefined && cause.table !== 'Account'))
    return false;
  const constraint = object(cause.constraint);
  return constraint?.index === knownIndex || pair(constraint?.fields);
}
function unwrap<T>(result: T | AccountError): T {
  if (result instanceof AccountError) throw result;
  return result;
}
function tokenInput(value: unknown): string {
  const token = textInput(value, 'invitationToken', 128);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AccountError('INVITATION_INVALID', '邀请链接无效', 410);
  return token;
}
function codeInput(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value)) invalid('code', '请输入6位数字验证码');
  return value;
}
function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 && value! <= 10000 ? value! : fallback;
}
export function parsePage(url: URL) {
  const raw = url.searchParams.get('limit') || '20';
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) invalid('limit', '每页数量需为1–100');
  const cursor = url.searchParams.get('cursor') || null;
  if (cursor && !/^[a-f0-9-]{36}$/.test(cursor)) invalid('cursor', '分页游标无效');
  const query = url.searchParams.get('query')?.trim() || '';
  if (query.length > 100) invalid('query', '搜索内容过长');
  return { limit: Number(raw), cursor, query };
}
export class AccountService {
  readonly now: () => Date;
  constructor(
    readonly db: PrismaClient,
    readonly options: ServiceOptions
  ) {
    assertSmsEnvironment(options.sms, options.environment);
    this.now = options.now ?? (() => new Date());
  }
  config() {
    return authConfig(this.options.phone, this.options.sms);
  }
  phone(value: unknown): string {
    if (!this.options.phone.ready)
      throw new AccountError('PHONE_REGION_UNCONFIRMED', this.options.phone.hint, 503);
    const normalized = this.options.phone.normalize(textInput(value, 'phone', 80));
    if (!/^\+[1-9]\d{6,14}$/.test(normalized)) invalid('phone', '请输入有效手机号');
    return normalized;
  }
  transaction<T>(action: (tx: Tx) => Promise<T>, replaySafe = false): Promise<T> {
    return withTransactionRetry(
      () => this.db.$transaction(action, { maxWait: 5000, timeout: 15000, isolationLevel: 'ReadCommitted' }),
      { replaySafe }
    );
  }
  /** All buckets reserve atomically. Sorted lock order avoids quota-lock deadlocks. */
  async rateMany(
    buckets: Array<{ key: string; limit: number; seconds: number }>,
    consume = true
  ): Promise<void> {
    const ordered = buckets
      .map((bucket) => ({ ...bucket, digest: tokenDigest(bucket.key) }))
      .sort((a, b) => a.digest.localeCompare(b.digest));
    const result = await this.transaction(async (tx) => {
      for (const bucket of ordered) await lock(tx, `rate:${bucket.digest}`);
      const now = this.now();
      for (const bucket of ordered) {
        const where = {
          key: bucket.digest,
          createdAt: { gt: new Date(now.getTime() - bucket.seconds * 1000) }
        };
        if ((await tx.accountRateEvent.count({ where })) >= bucket.limit) {
          const oldest = await tx.accountRateEvent.findFirst({ where, orderBy: { createdAt: 'asc' } });
          const retry = Math.max(
            1,
            Math.ceil(
              ((oldest?.createdAt.getTime() ?? now.getTime()) + bucket.seconds * 1000 - now.getTime()) / 1000
            )
          );
          return new AccountError('RATE_LIMITED', '操作过于频繁，请稍后再试', 429, undefined, retry);
        }
      }
      if (consume)
        for (const bucket of ordered)
          await tx.accountRateEvent.create({ data: { key: bucket.digest, createdAt: now } });
    }, true);
    unwrap(result);
  }
  async rate(key: string, limit: number, seconds: number, consume = true): Promise<void> {
    return this.rateMany([{ key, limit, seconds }], consume);
  }
  private async writeBuckets(source: string, token?: string | null) {
    const session = await this.sessionIn(this.db, token);
    return [
      { key: `write:${source}`, limit: positiveLimit(this.options.writeSourceLimit, 300), seconds: 900 },
      { key: 'write-global', limit: positiveLimit(this.options.writeGlobalLimit, 10000), seconds: 900 },
      ...(session
        ? [
            {
              key: `write-account:${session.accountId}`,
              limit: positiveLimit(this.options.writeAccountLimit, 60),
              seconds: 900
            }
          ]
        : [])
    ];
  }
  async limitWriteSource(source: string, token?: string | null): Promise<void> {
    await this.rateMany(await this.writeBuckets(source, token));
  }
  async checkWriteSource(source: string, token?: string | null): Promise<void> {
    await this.rateMany(await this.writeBuckets(source, token), false);
  }
  async limitWriteParsing(source: string, accountId: string): Promise<void> {
    await this.rate(
      `write-parse:${source}:${accountId}`,
      positiveLimit(this.options.writeSourceLimit, 300),
      900
    );
  }
  async sessionIn(tx: Tx, token?: string | null) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = await tx.accountSession.findFirst({
      where: { tokenHash: tokenDigest(token), revokedAt: null, expiresAt: { gt: this.now() } },
      include: { account: true }
    });
    if (!session || !(await lotteryAccountActive(tx, session.accountId))) return null;
    return session.expiresAt > this.now() ? session : null;
  }
  async requireAccount(tx: Tx, token?: string | null, administrator = false) {
    const session = await this.sessionIn(tx, token);
    if (!session) throw new AccountError('UNAUTHENTICATED', '请先登录', 401);
    if (administrator && !canAdminister(session.account.adminRole))
      throw new AccountError('FORBIDDEN', '无管理权限', 403);
    return session;
  }
  snapshot(account: Account, expiresAt: Date): SessionSnapshot {
    const allowed = canAdminister(account.adminRole);
    return {
      user: accountSummary(account),
      expiresAt: expiresAt.toISOString(),
      capabilities: { manageInvitations: allowed, manageMembership: allowed }
    };
  }
  async session(token?: string | null): Promise<SessionSnapshot> {
    const session = await this.sessionIn(this.db, token);
    return session ? this.snapshot(session.account, session.expiresAt) : anonymousSession();
  }
  async login(body: Body, source: string) {
    const phone = this.phone(body.phone);
    const password = textInput(body.password, 'password', 30);
    await this.rateMany([
      {
        key: `login-source:${source}`,
        limit: positiveLimit(this.options.loginSourceLimit, 30),
        seconds: 900
      },
      {
        key: `login-phone-source:${phone}:${source}`,
        limit: positiveLimit(this.options.loginPhoneSourceLimit, 10),
        seconds: 900
      },
      { key: `login-phone:${phone}`, limit: positiveLimit(this.options.loginPhoneLimit, 50), seconds: 900 }
    ]);
    // New site starts empty: every stored password met the current minimum when it was set.
    if (password.length < ACCOUNT_RULES.passwordMin)
      throw new AccountError('INVALID_CREDENTIALS', '手机号或密码不正确', 401);
    const account = await this.db.account.findUnique({ where: { phone } });
    const valid = await verifySecret(password, account?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!account || !valid) throw new AccountError('INVALID_CREDENTIALS', '手机号或密码不正确', 401);
    if (!(await lotteryAccountActive(this.db, account.id)))
      throw new AccountError('FORBIDDEN', '账号已停用', 403);
    const token = opaqueToken();
    return this.transaction(async (tx) => {
      await lock(tx, `phone:${phone}`);
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${account.id} FOR NO KEY UPDATE`;
      const current = await tx.account.findUnique({ where: { id: account.id } });
      if (!current || current.passwordVersion !== account.passwordVersion)
        throw new AccountError('INVALID_CREDENTIALS', '手机号或密码不正确', 401);
      if (!(await lotteryAccountActive(tx, current.id)))
        throw new AccountError('FORBIDDEN', '账号已停用', 403);
      const now = this.now(),
        expiresAt = new Date(now.getTime() + ACCOUNT_RULES.sessionDays * DAY);
      await tx.accountSession.create({
        data: { tokenHash: tokenDigest(token), accountId: current.id, createdAt: now, expiresAt }
      });
      if (!(await lotteryAccountActive(tx, current.id)) || this.now() >= expiresAt)
        throw new AccountError('FORBIDDEN', '账号当前无法登录', 403);
      return { token, expiresAt, snapshot: this.snapshot(current, expiresAt) };
    });
  }
  async logout(token?: string | null) {
    if (token)
      await this.db.accountSession.updateMany({
        where: { tokenHash: tokenDigest(token), revokedAt: null },
        data: { revokedAt: this.now() }
      });
    return { loggedOut: true as const };
  }
  async invitation(token: unknown) {
    const invitation = await this.db.invitation.findUnique({
      where: { tokenHash: tokenDigest(tokenInput(token)) }
    });
    checkInvitation(invitation, this.now());
    return { membership: invitation.membership, expiresAt: invitation.expiresAt.toISOString() };
  }
  async sendCode(body: Body) {
    const phone = this.phone(body.phone);
    if (body.purpose !== 'REGISTER' && body.purpose !== 'RESET_PASSWORD') invalid('purpose', '验证用途无效');
    const purpose: VerificationPurpose = body.purpose;
    const invitationHash = purpose === 'REGISTER' ? tokenDigest(tokenInput(body.invitationToken)) : null;
    if (!this.options.sms.available) throw new AccountError('SMS_UNAVAILABLE', '短信服务尚未配置', 503);
    const startedAt = performance.now();
    const code = verificationCode(),
      codeHash = await hashSecret(code);
    const reservation = await this.transaction(async (tx) => {
      await lock(tx, `phone:${phone}`);
      if (invitationHash) await lock(tx, `invitation:${invitationHash}`);
      const now = this.now();
      const invitation = invitationHash
        ? await tx.invitation.findUnique({ where: { tokenHash: invitationHash } })
        : null;
      if (purpose === 'REGISTER') checkInvitation(invitation, now);
      const sends = await tx.verificationCode.findMany({
        where: { phone, createdAt: { gt: new Date(now.getTime() - DAY) } },
        orderBy: { createdAt: 'desc' }
      });
      let availableAt = 0;
      if (sends[0]) availableAt = sends[0].createdAt.getTime() + 60_000;
      const hourly = sends.filter((item) => item.createdAt.getTime() > now.getTime() - 3_600_000);
      if (hourly.length >= 5)
        availableAt = Math.max(availableAt, hourly[hourly.length - 5]!.createdAt.getTime() + 3_600_000);
      if (sends.length >= 10)
        availableAt = Math.max(availableAt, sends[sends.length - 10]!.createdAt.getTime() + DAY);
      if (availableAt > now.getTime())
        throw new AccountError(
          'RATE_LIMITED',
          '验证码发送过于频繁，请稍后再试',
          429,
          undefined,
          Math.ceil((availableAt - now.getTime()) / 1000)
        );
      let reservedAt = this.now();
      let dayStart = new Date(
        Math.floor((reservedAt.getTime() + BEIJING_OFFSET_MS) / DAY) * DAY - BEIJING_OFFSET_MS
      );
      await lock(tx, `sms-day:${dayStart.toISOString()}`);
      reservedAt = this.now();
      const currentDay = new Date(
        Math.floor((reservedAt.getTime() + BEIJING_OFFSET_MS) / DAY) * DAY - BEIJING_OFFSET_MS
      );
      if (currentDay.getTime() !== dayStart.getTime()) {
        // Midnight while waiting: reserve against the new day under its own lock.
        dayStart = currentDay;
        await lock(tx, `sms-day:${dayStart.toISOString()}`);
        reservedAt = this.now();
        if (reservedAt.getTime() < dayStart.getTime() || reservedAt.getTime() >= dayStart.getTime() + DAY)
          throw new AccountError('SMS_UNAVAILABLE', '短信服务暂时不可用，请稍后再试', 503);
      }
      if (purpose === 'REGISTER') checkInvitation(invitation, reservedAt);
      const dailyCount = await tx.verificationCode.count({
        where: { createdAt: { gte: dayStart, lt: new Date(dayStart.getTime() + DAY) } }
      });
      if (dailyCount >= positiveLimit(this.options.smsDailyLimit, 200))
        throw new AccountError('SMS_UNAVAILABLE', '短信服务暂时不可用，请稍后再试', 503);
      const registered =
        purpose !== 'RESET_PASSWORD' || Boolean(await tx.account.findUnique({ where: { phone } }));
      // Invalidate across purposes, and retain reservations even when provider delivery fails.
      await tx.verificationCode.updateMany({
        where: { phone, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now }
      });
      return tx.verificationCode.create({
        data: {
          phone,
          purpose,
          invitationId: invitation?.id,
          codeHash,
          createdAt: reservedAt,
          expiresAt: registered ? new Date(reservedAt.getTime() + 300_000) : reservedAt,
          ...(registered ? {} : { invalidatedAt: reservedAt })
        }
      });
    });
    // User-selected simple synchronous policy: a modest common one-second floor.
    // Slow or failed provider calls can still differ; no constant-time claim or asynchronous queue.
    const equalize = () =>
      purpose === 'RESET_PASSWORD'
        ? (this.options.smsResponseDelay ?? delay)(Math.max(0, 1000 - (performance.now() - startedAt)))
        : Promise.resolve();
    if (reservation.invalidatedAt) {
      await equalize();
      return {
        expiresAt: new Date(reservation.createdAt.getTime() + 300_000).toISOString(),
        resendAvailableAt: new Date(reservation.createdAt.getTime() + 60_000).toISOString()
      };
    }
    try {
      await this.options.sms.send({ phone, code, purpose });
      await this.db.verificationCode.update({
        where: { id: reservation.id },
        data: { deliveredAt: this.now() }
      });
    } catch {
      await this.db.verificationCode.update({
        where: { id: reservation.id },
        data: { invalidatedAt: this.now() }
      });
      await equalize();
      throw new AccountError('SMS_UNAVAILABLE', '短信发送失败，请稍后再试', 503);
    }
    await equalize();
    return {
      expiresAt: reservation.expiresAt.toISOString(),
      resendAvailableAt: new Date(reservation.createdAt.getTime() + 60_000).toISOString()
    };
  }
  async checkCode(
    tx: Tx,
    phone: string,
    purpose: VerificationPurpose,
    code: string,
    invitationId: string | null
  ) {
    const record = await tx.verificationCode.findFirst({
      where: { phone },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    });
    if (
      !record ||
      record.purpose !== purpose ||
      record.invitationId !== invitationId ||
      record.consumedAt ||
      record.invalidatedAt ||
      !record.deliveredAt
    )
      return new AccountError('CODE_INVALID', '验证码无效，请重新获取', 400, { code: '验证码无效' });
    if (record.attempts >= 5)
      return new AccountError('CODE_EXHAUSTED', '验证码错误次数已达上限，请重新获取', 400, {
        code: '验证码已失效'
      });
    if (record.expiresAt <= this.now())
      return new AccountError('CODE_EXPIRED', '验证码已过期，请重新获取', 400, { code: '验证码已过期' });
    if (!(await verifySecret(code, record.codeHash))) {
      await tx.verificationCode.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
      return new AccountError(
        record.attempts + 1 >= 5 ? 'CODE_EXHAUSTED' : 'CODE_INVALID',
        record.attempts + 1 >= 5 ? '验证码错误次数已达上限，请重新获取' : '验证码不正确',
        400,
        { code: '验证码不正确或已失效' }
      );
    }
    return record;
  }
  async register(body: Body) {
    const displayName = validateGameNickname(body.displayName);
    const { gameRegion, gameServer } = validateGameServer(body.gameRegion, body.gameServer);
    const phone = this.phone(body.phone),
      tokenHash = tokenDigest(tokenInput(body.invitationToken));
    const code = codeInput(body.code),
      passwordHash = await hashSecret(validatePassword(body.password, body.confirmPassword));
    const result = await this.transaction(async (tx) => {
      await lock(tx, `phone:${phone}`);
      await lock(tx, `invitation:${tokenHash}`);
      await lock(tx, `game-name:${tokenDigest(JSON.stringify([gameServer, displayName]))}`);
      const invitation = await tx.invitation.findUnique({ where: { tokenHash } });
      checkInvitation(invitation, this.now());
      const verification = await this.checkCode(tx, phone, 'REGISTER', code, invitation.id);
      // Return, rather than throw, to COMMIT invalid-code attempt counters.
      if (verification instanceof AccountError) return verification;
      if (await tx.account.findUnique({ where: { phone } }))
        return new AccountError('PHONE_ALREADY_REGISTERED', '此手机号已注册，请登录', 409, {
          phone: '此手机号已注册'
        });
      if (await tx.account.findFirst({ where: { gameServer, displayName } })) return gameNicknameTaken();
      const now = this.now();
      if (verification.expiresAt <= now)
        return new AccountError('CODE_EXPIRED', '验证码已过期，请重新获取', 400, { code: '验证码已过期' });
      // Verification and uniqueness checks may await; recheck expiry using trusted time
      // while still holding the same invitation lock used by revoke/remove/sendCode.
      checkInvitation(invitation, now);
      const account = await tx.account.create({
        data: {
          phone,
          passwordHash,
          displayName,
          gameRegion,
          gameServer,
          membership: invitation.membership,
          adminRole: 'NONE',
          createdAt: now
        }
      });
      if (invitation.usageMode !== 'MULTIPLE') {
        const consumed = await tx.invitation.updateMany({
          where: {
            id: invitation.id,
            usageMode: 'SINGLE',
            usedAt: null,
            revokedAt: null,
            removedAt: null,
            expiresAt: { gt: now }
          },
          data: { usedAt: now, usedById: account.id }
        });
        if (consumed.count !== 1) throw new AccountError('CONFLICT', '邀请状态已变化', 409);
      }
      await tx.verificationCode.update({ where: { id: verification.id }, data: { consumedAt: now } });
      return { registered: true as const, requiresLogin: true as const };
    }).catch((error: unknown) => {
      if (isGameNicknameConstraint(error)) throw gameNicknameTaken();
      throw error;
    });
    return unwrap(result);
  }
  async resetPassword(body: Body) {
    const phone = this.phone(body.phone),
      code = codeInput(body.code);
    const passwordHash = await hashSecret(validatePassword(body.password, body.confirmPassword));
    const result = await this.transaction(async (tx) => {
      await lock(tx, `phone:${phone}`);
      const verification = await this.checkCode(tx, phone, 'RESET_PASSWORD', code, null);
      if (verification instanceof AccountError) return verification;
      const account = await tx.account.findUnique({ where: { phone } });
      // Do not claim reset succeeded for a missing account, and don't consume its code.
      if (!account) return new AccountError('INVALID_CREDENTIALS', '无法重置此账号的密码', 400);
      const now = this.now();
      if (verification.expiresAt <= now)
        return new AccountError('CODE_EXPIRED', '验证码已过期，请重新获取', 400, { code: '验证码已过期' });
      await tx.account.update({
        where: { id: account.id },
        data: { passwordHash, passwordVersion: { increment: 1 } }
      });
      await tx.accountSession.updateMany({
        where: { accountId: account.id, revokedAt: null },
        data: { revokedAt: now }
      });
      await tx.verificationCode.update({ where: { id: verification.id }, data: { consumedAt: now } });
      return { reset: true as const, requiresLogin: true as const };
    });
    return unwrap(result);
  }
  async changePassword(body: Body, token?: string | null) {
    const session = await this.requireAccount(this.db, token);
    const currentPassword = textInput(body.currentPassword, 'currentPassword', 30);
    const passwordHash = await hashSecret(validatePassword(body.password, body.confirmPassword));
    await this.rate(`password-change:${session.accountId}`, 10, 900);
    return this.transaction(async (tx) => {
      await lock(tx, `phone:${session.account.phone}`);
      // Match the account/session lock order used by other credential-sensitive operations.
      // Logout can finish while we wait for the account; authorize only after both waits.
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${session.accountId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${session.id} FOR UPDATE`;
      const current = await this.requireAccount(tx, token);
      if (current.id !== session.id || current.accountId !== session.accountId)
        throw new AccountError('UNAUTHENTICATED', '登录身份已变化，请重新登录', 401);
      if (!(await verifySecret(currentPassword, current.account.passwordHash)))
        throw new AccountError('INVALID_CREDENTIALS', '当前密码不正确', 400, {
          currentPassword: '当前密码不正确'
        });
      await tx.account.update({
        where: { id: current.accountId },
        data: { passwordHash, passwordVersion: { increment: 1 } }
      });
      await tx.accountSession.updateMany({
        where: { accountId: current.accountId, revokedAt: null },
        data: { revokedAt: this.now() }
      });
      // The held session was revoked by this operation, so requireAccount would reject
      // our own successful write. Locks keep its identity/expiry and account fields stable;
      // recheck active status and time after the last write (which may wait on other sessions).
      if (!(await lotteryAccountActive(tx, current.accountId)) || current.expiresAt <= this.now())
        throw new AccountError('UNAUTHENTICATED', '登录状态已变化，请重新登录', 401);
      return { changed: true as const, requiresLogin: true as const };
    });
  }
  private async freshAdministrator(
    tx: Tx | PrismaClient,
    token: string | null | undefined,
    expected: Awaited<ReturnType<AccountService['requireAccount']>>
  ) {
    const fresh = await this.requireAccount(tx, token, true);
    if (
      fresh.expiresAt <= this.now() ||
      fresh.id !== expected.id ||
      fresh.accountId !== expected.accountId ||
      fresh.account.membership !== expected.account.membership ||
      fresh.account.adminRole !== expected.account.adminRole
    ) {
      throw new AccountError('UNAUTHENTICATED', '登录身份已变化，请重新登录', 401);
    }
    return fresh;
  }
  private async lockedAdministrator(tx: Tx, token?: string | null) {
    const actor = await this.requireAccount(tx, token, true);
    await lock(tx, 'phone:' + actor.account.phone);
    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${actor.accountId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${actor.id} FOR UPDATE`;
    return this.freshAdministrator(tx, token, actor);
  }
  async createInvitation(body: Body, token?: string | null) {
    const membership = membershipInput(body.membership);
    const usageMode = body.usageMode === undefined ? 'SINGLE' : body.usageMode;
    if (usageMode !== 'SINGLE' && usageMode !== 'MULTIPLE') invalid('usageMode', '请选择单次或多次');
    const raw = textInput(body.expiresAt, 'expiresAt', 40),
      expiresAt = new Date(raw);
    if (
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(raw) ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.toISOString().slice(0, 19) !== raw.slice(0, 19) ||
      expiresAt <= this.now()
    )
      invalid('expiresAt', '请选择未来的有效UTC时间');
    const inviteToken = opaqueToken();
    return this.transaction(async (tx) => {
      const actor = await this.lockedAdministrator(tx, token);
      if (expiresAt <= this.now()) invalid('expiresAt', '请选择未来的有效UTC时间');
      const cipher = this.options.invitationCipher;
      if (!cipher) throw invitationLinkUnavailable();
      const id = randomUUID(),
        tokenHash = tokenDigest(inviteToken);
      const tokenCiphertext = cipher.seal(inviteToken, id, tokenHash);
      const invitation = await tx.invitation.create({
        data: {
          id,
          tokenHash,
          tokenCiphertext,
          membership,
          usageMode,
          expiresAt,
          createdById: actor.accountId,
          createdAt: this.now()
        },
        include: creator
      });
      await tx.accountAudit.create({
        data: {
          action: 'INVITATION_CREATED',
          actorId: actor.accountId,
          invitationId: invitation.id,
          createdAt: this.now()
        }
      });
      await this.freshAdministrator(tx, token, actor);
      return {
        invitation: invitationSummary(invitation, this.now(), !!this.options.invitationCipher),
        invitePath: `/invite/${inviteToken}`
      };
    });
  }
  async invitationLink(id: string, token?: string | null) {
    return this.transaction(async (tx) => {
      const actor = await this.lockedAdministrator(tx, token);
      const found = await tx.invitation.findUnique({ where: { id } });
      if (!found) throw new AccountError('NOT_FOUND', '邀请不存在', 404);
      await lock(tx, `invitation:${found.tokenHash}`);
      const invitation = await tx.invitation.findUniqueOrThrow({ where: { id } });
      checkInvitation(invitation, this.now());
      const cipher = this.options.invitationCipher;
      if (!cipher) throw invitationLinkUnavailable();
      const raw = cipher.open(invitation.tokenCiphertext, invitation.id, invitation.tokenHash);
      await this.freshAdministrator(tx, token, actor);
      checkInvitation(invitation, this.now());
      return { invitePath: `/invite/${raw}` };
    });
  }
  async revokeInvitation(id: string, body: Body, token?: string | null) {
    const reason = reasonInput(body.reason);
    return this.transaction(async (tx) => {
      const actor = await this.lockedAdministrator(tx, token);
      let invitation = await tx.invitation.findUnique({ where: { id }, include: creator });
      if (!invitation) throw new AccountError('NOT_FOUND', '邀请不存在', 404);
      await lock(tx, `invitation:${invitation.tokenHash}`);
      invitation = await tx.invitation.findUniqueOrThrow({ where: { id }, include: creator });
      if (invitation.removedAt) throw new AccountError('NOT_FOUND', '邀请不存在', 404);
      if (invitation.revokedAt) {
        await this.freshAdministrator(tx, token, actor);
        return { invitation: invitationSummary(invitation, this.now(), !!this.options.invitationCipher) };
      }
      checkInvitation(invitation, this.now());
      const updated = await tx.invitation.update({
        where: { id },
        data: { revokedAt: this.now() },
        include: creator
      });
      await tx.accountAudit.create({
        data: {
          action: 'INVITATION_REVOKED',
          actorId: actor.accountId,
          invitationId: id,
          reason,
          createdAt: this.now()
        }
      });
      await this.freshAdministrator(tx, token, actor);
      return { invitation: invitationSummary(updated, this.now(), !!this.options.invitationCipher) };
    });
  }
  async removeInvitation(id: string, body: Body, token?: string | null) {
    const reason = reasonInput(body.reason);
    return this.transaction(async (tx) => {
      const actor = await this.lockedAdministrator(tx, token);
      const found = await tx.invitation.findUnique({ where: { id } });
      if (!found) throw new AccountError('NOT_FOUND', '邀请不存在', 404);
      // Same lock as registration and revocation: removal never undoes a completed registration.
      await lock(tx, `invitation:${found.tokenHash}`);
      const invitation = await tx.invitation.findUniqueOrThrow({ where: { id } });
      if (invitation.removedAt) {
        await this.freshAdministrator(tx, token, actor);
        return { removed: true as const };
      }
      const now = this.now();
      await tx.invitation.update({ where: { id }, data: { removedAt: now } });
      await tx.verificationCode.updateMany({
        where: { invitationId: id, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now }
      });
      await tx.accountAudit.create({
        data: {
          action: 'INVITATION_REMOVED',
          actorId: actor.accountId,
          invitationId: id,
          reason,
          createdAt: now
        }
      });
      await this.freshAdministrator(tx, token, actor);
      return { removed: true as const };
    });
  }
  async changeMembership(id: string, body: Body, token?: string | null) {
    const membership = membershipInput(body.membership),
      expectedMembership = membershipInput(body.expectedMembership, 'expectedMembership'),
      reason = reasonInput(body.reason);
    return this.transaction(async (tx) => {
      let actor = await this.requireAccount(tx, token, true);
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${id} OR "id"=${actor.accountId} ORDER BY "id" FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${actor.id} FOR UPDATE`;
      actor = await this.requireAccount(tx, token, true);
      const target = await tx.account.findUnique({ where: { id } });
      if (!target) throw new AccountError('NOT_FOUND', '账号不存在', 404);
      if (!canChangeAccountMembership(actor.account, target)) {
        throw new AccountError('FORBIDDEN', '不能调整本人或超级管理员的参与身份', 403);
      }
      const updated = await tx.account.updateMany({
        where: { id, membership: expectedMembership },
        data: { membership }
      });
      if (updated.count !== 1) {
        if (!(await tx.account.findUnique({ where: { id } })))
          throw new AccountError('NOT_FOUND', '账号不存在', 404);
        throw new AccountError('CONFLICT', '身份已被其他操作修改，请刷新后确认', 409);
      }
      const account = await tx.account.findUniqueOrThrow({ where: { id } });
      await tx.accountAudit.create({
        data: {
          action: 'MEMBERSHIP_CHANGED',
          actorId: actor.accountId,
          targetAccountId: id,
          beforeMembership: expectedMembership,
          afterMembership: membership,
          reason,
          createdAt: this.now()
        }
      });
      await this.requireAccount(tx, token, true);
      return { account: accountSummary(account) };
    });
  }
  async list(kind: 'invitations' | 'accounts' | 'audit', url: URL, token?: string | null) {
    const actor = await this.requireAccount(this.db, token, true);
    if (kind === 'audit') {
      const result = await this.auditPage(url);
      await this.freshAdministrator(this.db, token, actor);
      return result;
    }
    const { limit, cursor, query } = parsePage(url);
    // Targeted identity maintenance, never a directory or phone-number lookup.
    if (kind === 'accounts' && !query) {
      await this.freshAdministrator(this.db, token, actor);
      return { items: [], nextCursor: null };
    }
    const paging = {
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }]
    };
    const items =
      kind === 'invitations'
        ? (
            await this.db.invitation.findMany({ ...paging, where: { removedAt: null }, include: creator })
          ).map((item) => invitationSummary(item, this.now(), !!this.options.invitationCipher))
        : (
            await this.db.account.findMany({
              ...paging,
              where: { displayName: { contains: query.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' } }
            })
          ).map(accountSummary);
    await this.freshAdministrator(this.db, token, actor);
    return { items: items.slice(0, limit), nextCursor: items.length > limit ? items[limit - 1]!.id : null };
  }
  private async auditPage(url: URL) {
    const number = (field: string, fallback: string, max: number) => {
      const raw = url.searchParams.get(field) ?? fallback;
      if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) {
        invalid(field, '分页参数无效');
      }
      return Number(raw);
    };
    const requestedPage = number('page', '1', 1000000),
      pageSize = number('pageSize', '10', 100);
    const scope = url.searchParams.get('scope') ?? 'membership';
    if (scope !== 'membership' && scope !== 'invitation') invalid('scope', '操作记录范围无效');
    const where =
      scope === 'membership'
        ? { action: 'MEMBERSHIP_CHANGED' }
        : { action: { in: ['INVITATION_CREATED', 'INVITATION_REVOKED', 'INVITATION_REMOVED'] } };
    // A consistent count and slice; changing concurrent data cannot split this response's snapshot.
    return this.db.$transaction(
      async (tx) => {
        const total = await tx.accountAudit.count({ where });
        const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
        const rows = await tx.accountAudit.findMany({
          where,
          take: pageSize,
          skip: (page - 1) * pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: { actor: true }
        });
        const items = rows.map((item) => ({
          id: item.id,
          action: item.action,
          actor: accountSummary(item.actor),
          targetAccountId: item.targetAccountId,
          invitationId: item.invitationId,
          beforeMembership: item.beforeMembership,
          afterMembership: item.afterMembership,
          reason: item.reason,
          createdAt: item.createdAt.toISOString()
        }));
        return { items, page, pageSize, total };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
  }
}
