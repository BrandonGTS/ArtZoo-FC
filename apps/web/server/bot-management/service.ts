import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  AccountError,
  BOT_REPLY_KINDS,
  botConfigForEditing,
  botDefaults,
  botTestMessage,
  botCanonical,
  validateBotConfig,
  previewBotTemplate,
  type BotManagementSnapshot,
  type BotManagementConfig
} from '@artzoo/domain';
import {
  BOT_MANAGEMENT_ID,
  configuredQqGroups,
  requireCurrentQqGroup,
  resolveQqGroup,
  qqGroupRegistry,
  lockQqReminderPlanning,
  reconcileQqReminderPlans,
  botScopeMatches,
  currentBotPublication,
  qqProactiveEnabled,
  Prisma,
  type PrismaClient,
  type QqOfficialConfig
} from '@artzoo/db';
import { AccountService, lock } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import { BUTTON_PROBE_KIND, BUTTON_PROBE_PLUGIN, BUTTON_PROBE_TEXT, buttonProbeOpen } from './button-probe';
type Tx = Prisma.TransactionClient;
type Actor = Awaited<ReturnType<AccountService['requireAccount']>>;
function invalid(message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400);
}
function conflict(): never {
  throw new AccountError('CONFLICT', '配置已变化，请重新读取后操作', 409);
}
function unavailable(message: string): never {
  throw new AccountError('SERVICE_UNAVAILABLE', message, 503);
}
const rev = (v: unknown) => {
  if (!Number.isSafeInteger(v) || Number(v) < 0 || Number(v) >= 2147483646) invalid('版本无效');
  return Number(v);
};
function fields(b: Record<string, unknown>, names: string[]) {
  if (Object.keys(b).some((k) => !names.includes(k))) invalid('提交字段无效');
}
const json = (x: unknown) => x as Prisma.InputJsonValue;
const digest = (c: BotManagementConfig) => createHash('sha256').update(botCanonical(c)).digest('hex');
const scopeOf = (c: QqOfficialConfig) =>
  c.target ? { appId: c.target.appId, botId: c.target.botId, groupOpenId: c.target.groupOpenId } : null;
export function preserveFixedBotTemplates(
  candidate: BotManagementConfig,
  stored: BotManagementConfig
): BotManagementConfig {
  const next = botConfigForEditing(candidate),
    prior = botConfigForEditing(stored);
  for (const kind of BOT_REPLY_KINDS)
    if (next.templates[kind] !== prior.templates[kind]) invalid('该消息类别使用固定内容，不支持修改模板');
  return {
    ...candidate,
    templates: {
      ...candidate.templates,
      ...Object.fromEntries(BOT_REPLY_KINDS.map((kind) => [kind, stored.templates[kind]]))
    }
  };
}
export class BotManagementService {
  constructor(
    readonly auth: AccountService,
    readonly config: QqOfficialConfig
  ) {}
  async requireSuper(tx: Tx | PrismaClient, token?: string | null, expected?: Actor) {
    const a = await this.auth.requireAccount(tx, token, true);
    if (a.expiresAt <= this.auth.now()) throw new AccountError('UNAUTHENTICATED', '登录已过期', 401);
    if (a.account.adminRole !== 'SUPER_ADMIN')
      throw new AccountError('FORBIDDEN', '仅超级管理员可以管理机器人', 403);
    if (
      expected &&
      (a.id !== expected.id ||
        a.accountId !== expected.accountId ||
        a.account.membership !== expected.account.membership ||
        a.account.adminRoleRevision !== expected.account.adminRoleRevision)
    )
      throw new AccountError('UNAUTHENTICATED', '登录身份已变化', 401);
    return a;
  }
  async snapshot(token?: string | null): Promise<BotManagementSnapshot> {
    const actor = await this.requireSuper(this.auth.db, token),
      scope = scopeOf(this.config),
      now = this.auth.now();
    const data = await this.auth.db.$transaction(
      async (tx) => {
        const state = await tx.botManagementState.findUnique({ where: { id: BOT_MANAGEMENT_ID } }),
          pub = state?.publishedVersion
            ? await tx.botManagementPublication.findUnique({ where: { version: state.publishedVersion } })
            : null;
        const seen = await tx.botManagementObservation.findUnique({ where: { id: BOT_MANAGEMENT_ID } });
        const audits = await tx.botManagementAudit.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 20,
          select: { id: true, actorId: true, action: true, before: true, after: true, createdAt: true }
        });
        const deliveries = scope
          ? await tx.qqOfficialDelivery.findMany({
              where: scope,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 20,
              select: { id: true, kind: true, status: true, resultCode: true, createdAt: true }
            })
          : [];
        const grouped = scope
          ? await tx.qqOfficialDelivery.groupBy({ by: ['status'], where: scope, _count: { _all: true } })
          : [];
        const sendRecords = await tx.botManagementSendRecord.findMany({
          orderBy: [{ eventAt: 'desc' }, { id: 'desc' }],
          take: 20
        });
        const tests = await tx.botManagementTest.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 20,
          select: { id: true, status: true, createdAt: true }
        });
        const fresh = !!seen && now.getTime() - seen.observedAt.getTime() <= 120000,
          matching =
            !!pub &&
            !!scope &&
            botScopeMatches(pub.scope, scope) &&
            seen?.reportedVersion === pub.version &&
            seen.reportedDigest === pub.digest;
        const publicationStatus = !pub
          ? 'UNPUBLISHED'
          : !seen
            ? 'PENDING'
            : !fresh
              ? 'STALE'
              : seen?.applyError
                ? 'FAILED'
                : matching
                  ? 'APPLIED'
                  : 'PENDING';
        return {
          draft: state ? validateBotConfig(state.draft) : botDefaults(),
          draftRevision: state?.draftRevision ?? 0,
          publishedVersion: pub?.version ?? 0,
          publishedConfig: pub ? validateBotConfig(pub.config) : null,
          publicationStatus,
          publishedAt: pub?.createdAt.toISOString() ?? null,
          observedAt: seen?.observedAt.toISOString() ?? null,
          applyError: fresh ? (seen?.applyError ?? null) : null,
          scope,
          telemetry: fresh ? ((seen?.telemetry as Record<string, unknown>) ?? null) : null,
          sendRecords: sendRecords.map((r) => ({
            ...r,
            eventAt: r.eventAt.toISOString(),
            observedAt: r.observedAt.toISOString()
          })),
          counts: Object.fromEntries(grouped.map((r) => [r.status, r._count._all])),
          audits: audits.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
          deliveries: deliveries.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
          tests: tests.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
        } as BotManagementSnapshot;
      },
      { isolationLevel: 'RepeatableRead' }
    );
    await this.requireSuper(this.auth.db, token, actor);
    return data;
  }
  async settings(token?: string | null) {
    const actor = await this.requireSuper(this.auth.db, token),
      scope = scopeOf(this.config),
      now = this.auth.now();
    const result = await this.auth.db.$transaction(
      async (tx) => {
        const state = await tx.botManagementState.findUnique({ where: { id: BOT_MANAGEMENT_ID } }),
          pub = state?.publishedVersion
            ? await tx.botManagementPublication.findUnique({ where: { version: state.publishedVersion } })
            : null;
        const seen = await tx.botManagementObservation.findUnique({
          where: { id: BOT_MANAGEMENT_ID },
          select: { reportedVersion: true, reportedDigest: true, applyError: true, observedAt: true }
        });
        const fresh = !!seen && now.getTime() - seen.observedAt.getTime() <= 120000,
          matching =
            !!pub &&
            !!scope &&
            botScopeMatches(pub.scope, scope) &&
            seen?.reportedVersion === pub.version &&
            seen.reportedDigest === pub.digest;
        const publicationStatus = !pub
          ? 'UNPUBLISHED'
          : !seen
            ? 'PENDING'
            : !fresh
              ? 'STALE'
              : seen.applyError
                ? 'FAILED'
                : matching
                  ? 'APPLIED'
                  : 'PENDING';
        const probeUsed =
          this.config.buttonProbeUntil && scope
            ? !!(await tx.botManagementTest.findFirst({
                where: { scope: { equals: json(scope) }, content: BUTTON_PROBE_TEXT },
                select: { id: true }
              }))
            : false;
        return {
          draft: state ? validateBotConfig(state.draft) : botDefaults(),
          draftRevision: state?.draftRevision ?? 0,
          publishedVersion: pub?.version ?? 0,
          publishedConfig: pub ? validateBotConfig(pub.config) : null,
          publicationStatus,
          applyError: fresh ? (seen?.applyError ?? null) : null,
          scope,
          ...(this.config.buttonProbeUntil
            ? {
                buttonProbe: {
                  available: buttonProbeOpen(this.config, now) && !probeUsed,
                  used: probeUsed,
                  expiresAt: this.config.buttonProbeUntil.toISOString()
                }
              }
            : {})
        };
      },
      { isolationLevel: 'RepeatableRead' }
    );
    await this.requireSuper(this.auth.db, token, actor);
    return result;
  }
  async testStatus(id: string | null, token?: string | null) {
    const actor = await this.requireSuper(this.auth.db, token);
    if (id && !/^[a-f0-9-]{36}$/.test(id)) invalid('测试记录无效');
    const row = await this.auth.db.botManagementTest.findFirst({
      where: { actorId: actor.accountId, ...(id ? { id } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    });
    await this.requireSuper(this.auth.db, token, actor);
    if (!row) return null;
    const now = this.auth.now(),
      status =
        row.status === 'PENDING' && row.expiresAt <= now
          ? 'EXPIRED'
          : ['CLAIMED', 'DISPATCHING'].includes(row.status) && row.leaseUntil && row.leaseUntil <= now
            ? 'UNKNOWN'
            : row.status;
    return {
      id: row.id,
      status,
      resultCode: row.resultCode,
      createdAt: row.createdAt.toISOString(),
      sentAt: row.sentAt?.toISOString() ?? null,
      groupOpenId: (row.scope as Record<string, string>).groupOpenId,
      simulation: this.config.mode === 'simulation'
    };
  }
  async preview(body: Record<string, unknown>, token?: string | null) {
    const actor = await this.requireSuper(this.auth.db, token);
    fields(body, ['config', 'kind']);
    const result = previewBotTemplate(body.config, body.kind);
    await this.requireSuper(this.auth.db, token, actor);
    return result;
  }
  async command(
    action: 'draft' | 'publish' | 'test' | 'save',
    body: Record<string, unknown>,
    token?: string | null
  ) {
    const actor = await this.requireSuper(this.auth.db, token);
    fields(body, [
      'expectedRevision',
      'expectedVersion',
      'idempotencyKey',
      ...(action === 'draft' || action === 'save'
        ? ['config']
        : action === 'test'
          ? ['targetGroupOpenId', 'config', 'kind']
          : [])
    ]);
    const expected = rev(body.expectedRevision),
      expectedVersion = rev(body.expectedVersion),
      key = body.idempotencyKey;
    if (typeof key !== 'string' || !/^[-_A-Za-z0-9]{16,128}$/.test(key)) invalid('提交标识无效');
    let draft = action === 'draft' || action === 'save' ? validateBotConfig(body.config) : null;
    const fingerprint = tokenDigest(botCanonical({ action, body }));
    await this.auth.rate('bot-management:' + actor.accountId, 60, 900);
    return this.auth.transaction(async (tx) => {
      await lock(tx, 'bot-management:write');
      await lock(tx, 'phone:' + actor.account.phone);
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${actor.accountId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${actor.id} FOR UPDATE`;
      await this.requireSuper(tx, token, actor);
      await lockQqReminderPlanning(tx);
      const old = await tx.botManagementAudit.findUnique({
        where: { actorId_idempotencyKey: { actorId: actor.accountId, idempotencyKey: key } }
      });
      if (old) {
        if (old.fingerprint !== fingerprint) conflict();
        return { ...(old.result as Record<string, unknown>), replayed: true };
      }
      let state = await tx.botManagementState.findUnique({ where: { id: BOT_MANAGEMENT_ID } });
      if ((state?.draftRevision ?? 0) !== expected || (state?.publishedVersion ?? 0) !== expectedVersion)
        conflict();
      if (draft)
        draft = preserveFixedBotTemplates(draft, state ? validateBotConfig(state.draft) : botDefaults());
      const scope = scopeOf(this.config),
        before = {
          draftRevision: state?.draftRevision ?? 0,
          publishedVersion: state?.publishedVersion ?? 0,
          config: state?.draft ?? null
        };
      let result: Record<string, unknown>;
      if (action === 'save') {
        const value = {
          scope: scope ? json(scope) : Prisma.JsonNull,
          draft: json(draft),
          draftRevision: expected + 1,
          updatedAt: this.auth.now()
        };
        state = await tx.botManagementState.upsert({
          where: { id: BOT_MANAGEMENT_ID },
          create: { id: BOT_MANAGEMENT_ID, ...value },
          update: value
        });
      }
      if (action === 'draft') {
        const value = {
          scope: scope ? json(scope) : Prisma.JsonNull,
          draft: json(draft),
          draftRevision: expected + 1,
          updatedAt: this.auth.now()
        };
        state = await tx.botManagementState.upsert({
          where: { id: BOT_MANAGEMENT_ID },
          create: { id: BOT_MANAGEMENT_ID, ...value },
          update: value
        });
        result = { draftRevision: state.draftRevision, publishedVersion: state.publishedVersion };
      } else {
        if (!scope || !state || !botScopeMatches(state.scope, scope))
          unavailable('目标群尚未配置或已变化，请先重新保存草稿');
        if (action === 'publish' || action === 'save') {
          const config = validateBotConfig(state.draft),
            previous = await currentBotPublication(tx, scope),
            version = state.publishedVersion + 1;
          if (previous && digest(config) === previous.digest) {
            result = {
              draftRevision: state.draftRevision,
              publishedVersion: previous.version,
              unchanged: true
            };
          } else {
            const effectivePrevious = previous?.config ?? botDefaults();
            const gateChanged =
              effectivePrevious.proactivePaused !== config.proactivePaused ||
              botCanonical(effectivePrevious.notifications) !== botCanonical(config.notifications);
            const notificationEpoch = (previous?.notificationEpoch ?? 0) + (gateChanged ? 1 : 0);
            await tx.botManagementPublication.create({
              data: {
                version,
                notificationEpoch,
                digest: digest(config),
                config: json(config),
                scope: json(scope),
                actorId: actor.accountId,
                createdAt: this.auth.now()
              }
            });
            state = await tx.botManagementState.update({
              where: { id: BOT_MANAGEMENT_ID },
              data: { publishedVersion: version, updatedAt: this.auth.now() }
            });
            const disabled = Object.entries(config.notifications)
              .filter(([, on]) => !on)
              .map(([k]) => k);
            // Never revive a paused/disabled queue. Already-dispatching sends cannot be retracted.
            await tx.qqOfficialDelivery.updateMany({
              where: {
                appId: scope.appId,
                botId: scope.botId,
                status: { in: ['PENDING', 'CLAIMED'] },
                ...(gateChanged ? {} : { kind: { in: disabled } })
              },
              data: {
                status: 'CANCELLED',
                resultCode: 'MANAGEMENT_PUBLISHED',
                leaseOwner: null,
                leaseUntil: null,
                updatedAt: this.auth.now()
              }
            });
            await tx.botManagementTest.updateMany({
              where: { status: 'PENDING' },
              data: { status: 'CANCELLED', resultCode: 'CONFIG_REPLACED' }
            });
            if (this.config.target && qqProactiveEnabled(this.config))
              for (const target of await configuredQqGroups(tx, this.config))
                await reconcileQqReminderPlans(
                  tx,
                  target,
                  config,
                  this.auth.now(),
                  notificationEpoch,
                  effectivePrevious
                );
            result = { draftRevision: state.draftRevision, publishedVersion: version };
          }
        } else {
          if (!qqProactiveEnabled(this.config)) unavailable('网站主动发送尚未启用');
          const testTarget =
            typeof body.targetGroupOpenId === 'string'
              ? await resolveQqGroup(tx, this.config, body.targetGroupOpenId)
              : null;
          if (!testTarget) invalid('测试目标群未绑定或已停用');
          const testScope = {
            appId: testTarget!.appId,
            botId: testTarget!.botId,
            groupOpenId: testTarget!.groupOpenId
          };
          if (
            this.config.managedGroups &&
            !(await requireCurrentQqGroup(tx, this.config, testTarget!, this.auth.now()))
          )
            unavailable('机器人尚未采用目标群配置');
          const pub = await currentBotPublication(tx, scope),
            seen = await tx.botManagementObservation.findUnique({ where: { id: BOT_MANAGEMENT_ID } });
          if (
            !pub ||
            pub.config.proactivePaused ||
            !seen ||
            seen.applyError ||
            seen.reportedVersion !== pub.version ||
            seen.reportedDigest !== pub.digest ||
            this.auth.now().getTime() - seen.observedAt.getTime() > 120000 ||
            (seen.telemetry as Record<string, unknown>).ready !== true ||
            (seen.telemetry as Record<string, unknown>).proactive_paused === true
          )
            unavailable('机器人尚未采用当前配置或主动发送已暂停');
          const probe = body.kind === BUTTON_PROBE_KIND;
          if (probe && (!botScopeMatches(testScope, scope) || body.config !== undefined))
            invalid('按钮测试只能使用当前主绑定群与固定测试内容');
          if (
            probe &&
            (!buttonProbeOpen(this.config, this.auth.now()) ||
              (seen.telemetry as Record<string, unknown>).plugin_version !== BUTTON_PROBE_PLUGIN)
          )
            unavailable('按钮测试未开启、已到期或机器人尚未采用测试补丁');
          const existingProbe = probe
            ? await tx.botManagementTest.findFirst({
                where: { scope: { equals: json(scope) }, content: BUTTON_PROBE_TEXT }
              })
            : null;
          if (existingProbe && existingProbe.actorId !== actor.accountId) conflict();
          if (!existingProbe) await this.auth.rate('bot-test:' + actor.accountId, 1, 60);
          const row =
            existingProbe ??
            (await tx.botManagementTest.create({
              data: {
                version: pub.version,
                scope: json(testScope),
                content: probe
                  ? BUTTON_PROBE_TEXT
                  : botTestMessage(body.config ?? pub.config, body.kind ?? 'PUBLISHED'),
                actorId: actor.accountId,
                expiresAt: new Date(
                  probe
                    ? Math.min(this.auth.now().getTime() + 60000, this.config.buttonProbeUntil!.getTime())
                    : this.auth.now().getTime() + 60000
                ),
                createdAt: this.auth.now()
              }
            }));
          result = {
            draftRevision: state.draftRevision,
            publishedVersion: state.publishedVersion,
            testId: row.id
          };
        }
      }
      await tx.botManagementAudit.create({
        data: {
          actorId: actor.accountId,
          idempotencyKey: key,
          fingerprint,
          action,
          before: json(before),
          after: json({
            draftRevision: state!.draftRevision,
            publishedVersion: state!.publishedVersion,
            config: state!.draft
          }),
          result: json(result),
          createdAt: this.auth.now()
        }
      });
      await this.requireSuper(tx, token, actor);
      return { ...result, replayed: false };
    });
  }
}
export function validateBotTelemetry(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('状态报告无效');
  const t = value as Record<string, unknown>;
  const keys = [
    'ready',
    'plugin_version',
    'proactive_paused',
    'passive_paused',
    'minute_proactive',
    'minute_group',
    'rolling_proactive',
    'reply_outcomes',
    'recent'
  ];
  if (Object.keys(t).length !== keys.length || Object.keys(t).some((k) => !keys.includes(k)))
    invalid('状态报告字段无效');
  for (const k of ['ready', 'proactive_paused', 'passive_paused'])
    if (typeof t[k] !== 'boolean') invalid('状态报告无效');
  if (
    typeof t.plugin_version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(t.plugin_version) ||
    t.plugin_version.length > 24
  )
    invalid('插件版本无效');
  for (const k of ['minute_proactive', 'minute_group', 'rolling_proactive'])
    if (!Number.isSafeInteger(t[k]) || Number(t[k]) < 0 || Number(t[k]) > 10000000) invalid('计数无效');
  const outcomes = t.reply_outcomes;
  if (
    !outcomes ||
    typeof outcomes !== 'object' ||
    Array.isArray(outcomes) ||
    Object.keys(outcomes).sort().join(',') !== 'permission_denied,sent,simulated,unknown'
  )
    invalid('回执计数无效');
  if (Object.values(outcomes).some((v) => !Number.isSafeInteger(v) || Number(v) < 0 || Number(v) > 10000000))
    invalid('回执计数无效');
  if (!Array.isArray(t.recent) || t.recent.length > 10) invalid('发送记录无效');
  for (const r of t.recent) {
    if (!r || typeof r !== 'object' || Object.keys(r).sort().join(',') !== 'direction,eventKey,outcome,time')
      invalid('发送记录无效');
    if (
      !/^[a-f0-9]{64}$/.test(r.eventKey) ||
      !['proactive', 'passive'].includes(r.direction) ||
      !['sent', 'unknown', 'permission_denied', 'simulated', 'started', 'SAFE_PRE_SEND'].includes(
        r.outcome
      ) ||
      typeof r.time !== 'string' ||
      r.time.length > 40 ||
      !Number.isFinite(new Date(r.time).getTime())
    )
      invalid('发送记录无效');
  }
  return t;
}
export class BotManagementBridge {
  constructor(
    readonly auth: AccountService,
    readonly config: QqOfficialConfig
  ) {}
  async sync(body: Record<string, unknown>) {
    fields(body, [
      'app_id',
      'bot_id',
      'group_openid',
      'simulation',
      'protocol',
      'applied_version',
      'applied_digest',
      'apply_error',
      'telemetry',
      ...(body.protocol === 2 ? ['applied_group_revision', 'applied_group_digest'] : [])
    ]);
    if (body.protocol !== (this.config.managedGroups ? 2 : 1)) invalid('配置协议无效');
    const groupRevision = body.protocol === 2 ? rev(body.applied_group_revision) : null,
      groupDigest = body.protocol === 2 ? body.applied_group_digest : null;
    if (
      body.protocol === 2 &&
      !(groupRevision === 0 && groupDigest === null) &&
      !(typeof groupDigest === 'string' && /^[a-f0-9]{64}$/.test(groupDigest))
    )
      invalid('群配置摘要无效');
    const version = rev(body.applied_version),
      hash = body.applied_digest;
    if (!(hash === null && version === 0) && !(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)))
      invalid('配置摘要无效');
    if (![null, 'INVALID_CONFIG', 'APPLY_FAILED'].includes(body.apply_error as null)) invalid('应用结果无效');
    const telemetry = validateBotTelemetry(body.telemetry),
      scope = scopeOf(this.config)!;
    return this.auth.transaction(async (tx) => {
      await lock(tx, 'bot-management:write');
      const pub = await currentBotPublication(tx, scope);
      if (version > (pub?.version ?? 0)) invalid('采用版本超出已发布版本');
      for (const row of telemetry.recent as Array<{
        eventKey: string;
        direction: string;
        outcome: string;
        time: string;
      }>) {
        const eventAt = new Date(row.time);
        if (eventAt.getTime() > this.auth.now().getTime() + 60000) invalid('记录时间无效');
        const old = await tx.botManagementSendRecord.findUnique({ where: { id: row.eventKey } });
        if (old && old.direction !== row.direction) invalid('记录方向无效');
        if (!old)
          await tx.botManagementSendRecord.create({
            data: {
              id: row.eventKey,
              direction: row.direction,
              outcome: row.outcome,
              eventAt,
              observedAt: this.auth.now()
            }
          });
        else if (!['unknown', 'permission_denied', 'sent', 'simulated'].includes(old.outcome))
          await tx.botManagementSendRecord.update({
            where: { id: row.eventKey },
            data: { outcome: row.outcome, observedAt: this.auth.now() }
          });
      }
      await tx.botManagementObservation.upsert({
        where: { id: BOT_MANAGEMENT_ID },
        create: {
          id: BOT_MANAGEMENT_ID,
          reportedVersion: version,
          reportedDigest: hash as string | null,
          applyError: body.apply_error as string | null,
          ...(body.protocol === 2 ? { groupRevision, groupDigest: groupDigest as string | null } : {}),
          telemetry: json(telemetry),
          observedAt: this.auth.now()
        },
        update: {
          reportedVersion: version,
          reportedDigest: hash as string | null,
          applyError: body.apply_error as string | null,
          ...(body.protocol === 2 ? { groupRevision, groupDigest: groupDigest as string | null } : {}),
          telemetry: json(telemetry),
          observedAt: this.auth.now()
        }
      });
      const registry = body.protocol === 2 ? await qqGroupRegistry(tx, this.config) : null;
      let groups: Record<string, unknown> | null = null;
      if (registry) {
        if ((groupRevision ?? 0) > registry.revision) invalid('群采用版本超出已发布版本');
        const value = {
          ...registry,
          issuedAt: this.auth.now().toISOString(),
          expiresAt: new Date(this.auth.now().getTime() + 120000).toISOString()
        };
        groups = {
          ...value,
          signature: createHmac('sha256', this.config.bridgeSecret!)
            .update('ArtZoo-Qq-Groups\n' + botCanonical(value))
            .digest('hex')
        };
      }
      return {
        protocol: body.protocol,
        scope: { app_id: scope.appId, bot_id: scope.botId, group_openid: scope.groupOpenId },
        publication:
          pub && (version !== pub.version || hash !== pub.digest || body.apply_error !== null)
            ? { version: pub.version, digest: pub.digest, config: pub.config }
            : null,
        ...(groups ? { groups } : {})
      };
    });
  }
  async test(action: 'test-claim' | 'test-begin' | 'test-ack', body: Record<string, unknown>) {
    fields(body, [
      'app_id',
      'bot_id',
      'group_openid',
      'simulation',
      ...(action === 'test-claim'
        ? ['applied_version', 'applied_digest']
        : action === 'test-begin'
          ? ['delivery_id', 'claim_token']
          : ['delivery_id', 'claim_token', 'outcome', 'message_id', 'ref_idx'])
    ]);
    if (body.simulation !== (this.config.mode === 'simulation')) invalid('测试运行模式不匹配');
    const scope = scopeOf(this.config)!;
    return this.auth.transaction(async (tx) => {
      await lock(tx, 'bot-management:write');
      const now = this.auth.now();
      await tx.botManagementTest.updateMany({
        where: { status: 'PENDING', expiresAt: { lte: now } },
        data: { status: 'EXPIRED' }
      });
      await tx.botManagementTest.updateMany({
        where: { status: { in: ['CLAIMED', 'DISPATCHING'] }, leaseUntil: { lte: now } },
        data: { status: 'UNKNOWN', resultCode: 'LEASE_EXPIRED' }
      });
      const pub = await currentBotPublication(tx, scope),
        seen = await tx.botManagementObservation.findUnique({ where: { id: BOT_MANAGEMENT_ID } });
      const groupReady =
        !this.config.managedGroups ||
        (await requireCurrentQqGroup(tx, this.config, this.config.target!, this.auth.now()));
      const live =
        groupReady &&
        qqProactiveEnabled(this.config) &&
        !!pub &&
        !pub.config.proactivePaused &&
        !!seen &&
        (seen.telemetry as Record<string, unknown>).ready === true &&
        !seen.applyError &&
        seen.reportedVersion === pub.version &&
        seen.reportedDigest === pub.digest &&
        now.getTime() - seen.observedAt.getTime() <= 120000;
      if (action === 'test-claim') {
        if (!live || body.applied_version !== pub!.version || body.applied_digest !== pub!.digest)
          return { delivery: null };
        const probeReady =
          buttonProbeOpen(this.config, now) &&
          (seen!.telemetry as Record<string, unknown>).plugin_version === BUTTON_PROBE_PLUGIN;
        const row = await tx.botManagementTest.findFirst({
          where: {
            status: 'PENDING',
            version: pub!.version,
            scope: { equals: json(scope) },
            expiresAt: { gt: now },
            ...(probeReady ? {} : { NOT: { content: BUTTON_PROBE_TEXT } })
          },
          orderBy: { createdAt: 'asc' }
        });
        if (!row || !botScopeMatches(row.scope, scope)) return { delivery: null };
        const token = randomBytes(32).toString('hex');
        await tx.botManagementTest.update({
          where: { id: row.id },
          data: {
            status: 'CLAIMED',
            leaseOwner: tokenDigest(token),
            leaseUntil: new Date(now.getTime() + 30000)
          }
        });
        return {
          delivery: {
            delivery_id: 'bot-test-' + row.id,
            idempotency_key: 'bot-test-' + row.id,
            claim_token: token,
            content: row.content,
            msg_seq: 1,
            simulation: this.config.mode === 'simulation',
            ...(row.content === BUTTON_PROBE_TEXT ? { button_probe: true } : {})
          }
        };
      }
      const id = typeof body.delivery_id === 'string' ? body.delivery_id.replace(/^bot-test-/, '') : '';
      if (
        !/^[a-f0-9-]{36}$/.test(id) ||
        typeof body.claim_token !== 'string' ||
        body.claim_token.length > 128
      )
        invalid('测试回执无效');
      const row = await tx.botManagementTest.findUnique({ where: { id } });
      if (row && botScopeMatches(row.scope, scope) && action === 'test-ack' && row.status === 'SENT')
        return {
          accepted:
            body.outcome === 'sent' &&
            row.providerMessageId === body.message_id &&
            row.refIdx === body.ref_idx,
          terminal: true
        };
      if (row && botScopeMatches(row.scope, scope) && action === 'test-ack' && row.status === 'SIMULATED')
        return { accepted: body.outcome === 'simulated', terminal: true };
      if (
        !row ||
        !botScopeMatches(row.scope, scope) ||
        row.leaseOwner !== tokenDigest(body.claim_token as string)
      )
        return action === 'test-begin'
          ? { dispatch: false, simulation: this.config.mode === 'simulation' }
          : { accepted: false, terminal: true };
      if (action === 'test-begin') {
        const beginNow = this.auth.now();
        if (
          row.content === BUTTON_PROBE_TEXT &&
          (!buttonProbeOpen(this.config, beginNow) ||
            (seen?.telemetry as Record<string, unknown>)?.plugin_version !== BUTTON_PROBE_PLUGIN)
        )
          return { dispatch: false, simulation: this.config.mode === 'simulation' };
        if (
          !live ||
          row.version !== pub!.version ||
          row.status !== 'CLAIMED' ||
          row.expiresAt <= beginNow ||
          !row.leaseUntil ||
          row.leaseUntil <= beginNow
        )
          return { dispatch: false, simulation: this.config.mode === 'simulation' };
        await tx.botManagementTest.update({
          where: { id },
          data: { status: 'DISPATCHING', leaseUntil: new Date(beginNow.getTime() + 30000) }
        });
        return { dispatch: true, simulation: this.config.mode === 'simulation' };
      }
      if (row.status === 'SENT')
        return {
          accepted:
            body.outcome === 'sent' &&
            row.providerMessageId === body.message_id &&
            row.refIdx === body.ref_idx,
          terminal: true
        };
      if (row.status === 'SIMULATED') return { accepted: body.outcome === 'simulated', terminal: true };
      if (row.status !== 'DISPATCHING') return { accepted: false, terminal: true };
      if (!row.leaseUntil || row.leaseUntil <= this.auth.now()) {
        await tx.botManagementTest.update({
          where: { id },
          data: { status: 'UNKNOWN', resultCode: 'LEASE_EXPIRED', leaseOwner: null, leaseUntil: null }
        });
        return { accepted: true, terminal: true };
      }
      const validReceipt =
        typeof body.message_id === 'string' &&
        body.message_id.length > 0 &&
        body.message_id.length <= 256 &&
        !/[\s\u0000-\u001f]/.test(body.message_id) &&
        typeof body.ref_idx === 'string' &&
        body.ref_idx.length > 0 &&
        body.ref_idx.length <= 200 &&
        !/[\s\u0000-\u001f]/.test(body.ref_idx) &&
        body.ref_idx !== body.message_id;
      const status =
        body.outcome === 'sent' && validReceipt && this.config.mode === 'live'
          ? 'SENT'
          : body.outcome === 'simulated' && this.config.mode === 'simulation'
            ? 'SIMULATED'
            : body.outcome === 'permission_denied'
              ? 'DENIED'
              : 'UNKNOWN';
      await tx.botManagementTest.update({
        where: { id },
        data: {
          status,
          resultCode: status,
          leaseOwner: null,
          leaseUntil: null,
          ...(status === 'SENT'
            ? {
                providerMessageId: body.message_id as string,
                refIdx: body.ref_idx as string,
                receiptDigest: tokenDigest(JSON.stringify([scope, body.ref_idx])),
                sentAt: this.auth.now()
              }
            : {})
        }
      });
      return { accepted: true, terminal: false };
    });
  }
}
