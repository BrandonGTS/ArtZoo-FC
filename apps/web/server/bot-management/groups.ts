import { randomBytes, createHash, createHmac } from 'node:crypto';
import { AccountError, botCanonical } from '@artzoo/domain';
import {
  ensureLegacyQqGroup,
  configuredQqGroups,
  qqGroupRegistry,
  lockQqReminderPlanning,
  BOT_GROUP_LIMIT,
  type QqOfficialConfig,
  type QqScope,
  type Prisma
} from '@artzoo/db';
import { lotteryAccountActive } from '@artzoo/db/lottery-eligibility';
import { AccountService, lock } from '../auth/service';
import { tokenDigest, opaqueToken } from '../auth/crypto';
import { BotManagementService } from './service';
type Tx = Prisma.TransactionClient;
const bad = (message: string): never => {
  throw new AccountError('FORBIDDEN', message, 403);
};
const invalid = (message: string): never => {
  throw new AccountError('VALIDATION_ERROR', message, 400);
};
const field = (b: Record<string, unknown>, k: string, max = 128) => {
  const v = b[k];
  if (typeof v !== 'string' || !v || v.length > max || (k === 'content' ? /[\r\n\0]/ : /\s/).test(v))
    throw new AccountError('VALIDATION_ERROR', '群绑定信息无效', 400, { [k]: 'INVALID_FORMAT_OR_LENGTH' });
  return v;
};
const code = () => randomBytes(12).toString('base64url');
const scopeOf = (c: QqOfficialConfig) => c.target!;
export class BotGroupService {
  readonly owner: BotManagementService;
  constructor(
    readonly auth: AccountService,
    readonly config: QqOfficialConfig
  ) {
    this.owner = new BotManagementService(auth, config);
  }
  enabled() {
    if (!this.config.managedGroups || !this.config.target || this.config.mode === 'disabled')
      bad('网站群绑定尚未启用');
  }
  async list(token?: string | null) {
    const actor = await this.owner.requireSuper(this.auth.db, token);
    if (!this.config.target) return { available: false, revision: 0, groups: [], adopted: false };
    const values = await this.auth.db.$transaction(async (tx) => {
      const registry = await qqGroupRegistry(tx, this.config),
        seen = await tx.botManagementObservation.findUnique({
          where: { id: 'qq-official' },
          select: { groupRevision: true, groupDigest: true, observedAt: true }
        });
      return {
        available: this.config.managedGroups === true,
        revision: registry.revision,
        groups: (await configuredQqGroups(tx, this.config, true)).map((g) => ({
          id: g.id,
          label: g.label,
          groupOpenId: g.groupOpenId,
          enabled: g.enabled,
          generation: g.generation,
          enabledAt: g.enabled ? g.enabledAt.toISOString() : null
        })),
        adopted:
          !!seen &&
          seen.groupRevision === registry.revision &&
          seen.groupDigest === registry.digest &&
          this.auth.now().getTime() - seen.observedAt.getTime() < 120000
      };
    });
    await this.owner.requireSuper(this.auth.db, token, actor);
    return values;
  }
  private async actor(tx: Tx, token?: string | null) {
    const actor = await this.owner.requireSuper(tx, token);
    await lock(tx, 'phone:' + actor.account.phone);
    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${actor.accountId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${actor.id} FOR UPDATE`;
    return this.owner.requireSuper(tx, token, actor);
  }
  private async challenge(tx: Tx, b: Record<string, unknown>, token?: string | null) {
    const actor = await this.actor(tx, token),
      id = field(b, 'challengeId');
    await lock(tx, 'bot-group-challenge:' + id);
    const row = await tx.botGroupChallenge.findUnique({ where: { id } });
    if (
      !row ||
      row.accountId !== actor.accountId ||
      row.sessionId !== actor.id ||
      row.browserProofHash !== tokenDigest(field(b, 'browserProof')) ||
      row.invalidatedAt ||
      row.expiresAt <= this.auth.now()
    )
      bad('群绑定请求已失效，请重新发起');
    return { actor, row: row! };
  }
  async command(
    action: 'initiate' | 'select' | 'progress' | 'confirm' | 'toggle',
    b: Record<string, unknown>,
    token?: string | null
  ) {
    this.enabled();
    const actor = await this.owner.requireSuper(this.auth.db, token);
    await this.auth.rate('bot-groups:' + actor.accountId, 30, 900);
    return this.auth.transaction(async (tx) => {
      await lock(tx, 'bot-management:write');
      if (action === 'initiate') {
        const fresh = await this.actor(tx, token);
        if (
          typeof b.label !== 'string' ||
          !b.label.trim() ||
          b.label.trim().length > 60 ||
          /[\p{C}<>@]/u.test(b.label)
        )
          invalid('请填写60字以内的群名称');
        const now = this.auth.now(),
          publicCode = code(),
          browserProof = opaqueToken();
        await tx.botGroupChallenge.updateMany({
          where: { accountId: fresh.accountId, consumedAt: null, invalidatedAt: null },
          data: { invalidatedAt: now }
        });
        const row = await tx.botGroupChallenge.create({
          data: {
            accountId: fresh.accountId,
            sessionId: fresh.id,
            label: (b.label as string).trim(),
            publicCodeHash: tokenDigest(publicCode),
            browserProofHash: tokenDigest(browserProof),
            expiresAt: new Date(now.getTime() + 300000)
          }
        });
        return { challengeId: row.id, publicCode, browserProof, expiresAt: row.expiresAt.toISOString() };
      }
      if (action === 'toggle') {
        const fresh = await this.actor(tx, token);
        if (b.confirmed !== true || typeof b.enabled !== 'boolean' || !Number.isSafeInteger(b.generation))
          invalid('请确认目标群及启停操作');
        const key = field(b, 'idempotencyKey');
        if (!/^[-A-Za-z0-9_]{16,128}$/.test(key)) invalid('操作标识无效');
        const fingerprint = tokenDigest(botCanonical(b)),
          old = await tx.botManagementAudit.findUnique({
            where: { actorId_idempotencyKey: { actorId: fresh.accountId, idempotencyKey: key } }
          });
        if (old) {
          if (old.fingerprint !== fingerprint) invalid('操作标识已使用');
          return old.result as Record<string, unknown>;
        }
        await lockQqReminderPlanning(tx);
        await ensureLegacyQqGroup(tx, this.config, this.auth.now());
        const row = await tx.botGroup.findUnique({ where: { id: field(b, 'groupId') } });
        const main = scopeOf(this.config);
        if (!row || row.appId !== main.appId || row.botId !== main.botId || row.generation !== b.generation)
          invalid('群配置已变化，请刷新后操作');
        const updated = await tx.botGroup.update({
          where: { id: row!.id },
          data: {
            enabled: b.enabled as boolean,
            enabledAt: b.enabled ? this.auth.now() : row!.enabledAt,
            generation: { increment: 1 },
            updatedAt: this.auth.now()
          }
        });
        await tx.botGroupState.upsert({
          where: { id: 'qq-official' },
          create: { id: 'qq-official', revision: 1 },
          update: { revision: { increment: 1 } }
        });
        const scope = { appId: row!.appId, botId: row!.botId, groupOpenId: row!.groupOpenId };
        await tx.qqOfficialDelivery.updateMany({
          where: { ...scope, status: { in: ['PENDING', 'CLAIMED'] } },
          data: { status: 'CANCELLED', resultCode: 'GROUP_CHANGED', leaseOwner: null, leaseUntil: null }
        });
        await tx.botManagementTest.updateMany({
          where: { scope: { equals: scope }, status: { in: ['PENDING', 'CLAIMED'] } },
          data: { status: 'CANCELLED', resultCode: 'GROUP_CHANGED', leaseOwner: null, leaseUntil: null }
        });
        const result = { groupId: row!.id, enabled: updated.enabled, generation: updated.generation };
        await tx.botManagementAudit.create({
          data: {
            actorId: fresh.accountId,
            idempotencyKey: key,
            fingerprint,
            action: 'group-toggle',
            before: { groupId: row!.id, enabled: row!.enabled, generation: row!.generation },
            after: result,
            result
          }
        });
        await this.owner.requireSuper(tx, token, fresh);
        return result;
      }
      const { actor: fresh, row } = await this.challenge(tx, b, token);
      if (row.consumedAt) {
        if (action === 'confirm') return { bound: true, enabled: false };
        bad('群绑定请求已使用');
      }
      if (action === 'select') {
        if (b.ownReplyConfirmed !== true) invalid('请核对机器人回复本人消息的校验码');
        if (row.selectedCandidateId) invalid('已选定群，请继续确认');
        const candidate = await tx.botGroupCandidate.findFirst({
          where: { challengeId: row.id, receiptCodeHash: tokenDigest(field(b, 'receiptCode')) }
        });
        if (!candidate) bad('本人消息校验码无效');
        const proof = opaqueToken();
        await tx.botGroupCandidate.update({
          where: { id: candidate!.id },
          data: { finalProofHash: tokenDigest(proof) }
        });
        await tx.botGroupChallenge.update({
          where: { id: row.id },
          data: { selectedCandidateId: candidate!.id }
        });
        return {
          proof,
          groupLabel: row.label,
          identityLabel: tokenDigest(JSON.stringify([candidate!.groupOpenId, candidate!.memberOpenId])).slice(
            0,
            8
          )
        };
      }
      const candidate = row.selectedCandidateId
        ? await tx.botGroupCandidate.findUnique({ where: { id: row.selectedCandidateId } })
        : null;
      if (action === 'progress') return { proven: !!candidate?.provenAt, label: row.label };
      if (b.confirmed !== true || !candidate?.provenAt) bad('请先用本人QQ群身份完成确认');
      await lockQqReminderPlanning(tx);
      const locked = await this.challenge(tx, b, token);
      if (
        locked.row.consumedAt ||
        locked.row.selectedCandidateId !== candidate!.id ||
        locked.row.expiresAt <= this.auth.now()
      )
        bad('群绑定请求已失效');
      const checked = await tx.botGroupCandidate.findUnique({ where: { id: candidate!.id } });
      if (!checked?.provenAt) bad('群证明已失效');
      await ensureLegacyQqGroup(tx, this.config, this.auth.now());
      const main = scopeOf(this.config);
      if (candidate!.appId !== main.appId || candidate!.botId !== main.botId) bad('机器人身份已变化');
      const scope = { appId: main.appId, botId: main.botId, groupOpenId: candidate!.groupOpenId };
      if (await tx.botGroup.findUnique({ where: { appId_botId_groupOpenId: scope } }))
        invalid('此群已绑定，请使用群列表启停');
      if ((await tx.botGroup.count({ where: { appId: main.appId, botId: main.botId } })) >= BOT_GROUP_LIMIT)
        invalid('最多绑定20个群');
      const group = await tx.botGroup.create({
        data: {
          ...scope,
          label: row.label,
          enabled: false,
          boundAt: this.auth.now(),
          createdById: fresh.accountId
        }
      });
      await tx.botGroupState.upsert({
        where: { id: 'qq-official' },
        create: { id: 'qq-official', revision: 1 },
        update: { revision: { increment: 1 } }
      });
      await tx.botGroupChallenge.update({ where: { id: row.id }, data: { consumedAt: this.auth.now() } });
      await this.owner.requireSuper(tx, token, fresh);
      if (row.expiresAt <= this.auth.now()) bad('群绑定请求已过期');
      return { bound: true, groupId: group.id, enabled: false };
    });
  }
  async proof(b: Record<string, unknown>) {
    this.enabled();
    const main = scopeOf(this.config),
      scope: QqScope = {
        appId: field(b, 'app_id', 160),
        botId: field(b, 'bot_id', 160),
        groupOpenId: field(b, 'group_openid', 160)
      };
    if (
      scope.appId !== main.appId ||
      scope.botId !== main.botId ||
      b.simulation !== (this.config.mode === 'simulation')
    )
      bad('机器人身份不匹配');
    if (!/^[A-Za-z0-9_=-]{1,160}$/.test(scope.groupOpenId)) bad('群标识无效');
    const member = field(b, 'sender_openid', 160);
    if (!/^[A-Za-z0-9_=-]{1,160}$/.test(member)) bad('群身份无效');
    const event = field(b, 'event_id', 256),
      idx = field(b, 'message_idx', 256),
      stamp = new Date(field(b, 'event_timestamp', 64)),
      content = field(b, 'content', 200);
    if (!Number.isFinite(stamp.getTime()) || Math.abs(this.auth.now().getTime() - stamp.getTime()) > 60000)
      bad('群绑定消息已过期');
    if (
      this.config.mode === 'simulation' &&
      ![scope.appId, scope.botId, scope.groupOpenId, member].every((v) => v.startsWith('mock_'))
    )
      bad('模拟身份不匹配');
    const match = /^(绑定群|确认群)\s+([A-Za-z0-9_-]{12,128})$/.exec(content);
    if (!match) bad('仅接受精确群绑定命令');
    await this.auth.rate('bot-group-proof:' + tokenDigest(JSON.stringify([scope, member])), 10, 60);
    return this.auth.transaction(async (tx) => {
      await lock(tx, 'bot-management:write');
      if (Math.abs(this.auth.now().getTime() - stamp.getTime()) > 60000) bad('群绑定消息已过期');
      const eventKey = tokenDigest(JSON.stringify([event, idx])),
        fingerprint = tokenDigest(JSON.stringify([scope, member, content]));
      const duplicate = await tx.qqOfficialInbound.findFirst({ where: { ...scope, eventKey } });
      if (duplicate) {
        if (duplicate.fingerprint !== fingerprint) bad('消息标识已使用');
        return duplicate.result as Record<string, unknown>;
      }
      const candidate =
        match![1] === '确认群'
          ? await tx.botGroupCandidate.findUnique({ where: { finalProofHash: tokenDigest(match![2]!) } })
          : null;
      const hint = candidate
        ? await tx.botGroupChallenge.findUnique({ where: { id: candidate.challengeId } })
        : await tx.botGroupChallenge.findUnique({ where: { publicCodeHash: tokenDigest(match![2]!) } });
      if (!hint) bad('群绑定请求无效');
      await lock(tx, 'bot-group-challenge:' + hint!.id);
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${hint!.accountId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${hint!.sessionId} FOR UPDATE`;
      const owner = await tx.account.findUnique({
          where: { id: hint!.accountId },
          select: { adminRole: true }
        }),
        session = await tx.accountSession.findUnique({
          where: { id: hint!.sessionId },
          select: { accountId: true, expiresAt: true }
        }),
        request = await tx.botGroupChallenge.findUniqueOrThrow({ where: { id: hint!.id } });
      if (
        owner?.adminRole !== 'SUPER_ADMIN' ||
        !session ||
        session.accountId !== hint!.accountId ||
        session.expiresAt <= this.auth.now() ||
        !(await lotteryAccountActive(tx, hint!.accountId)) ||
        request.expiresAt <= this.auth.now() ||
        request.invalidatedAt ||
        request.consumedAt
      )
        bad('群绑定请求已失效');
      let message: string;
      if (match![1] === '绑定群') {
        if (
          request.selectedCandidateId ||
          (await tx.botGroupCandidate.count({ where: { challengeId: request.id } })) >= 16
        )
          bad('群绑定请求已选定或失效');
        if (
          await tx.botGroupCandidate.findFirst({
            where: { challengeId: request.id, ...scope, memberOpenId: member }
          })
        )
          bad('此身份已提交，请回网站核对本人回复');
        const receipt = code();
        await tx.botGroupCandidate.create({
          data: {
            challengeId: request.id,
            ...scope,
            memberOpenId: member,
            receiptCodeHash: tokenDigest(receipt)
          }
        });
        message = '仅将回复本人这条消息的校验码填回网站：' + receipt;
      } else {
        if (
          !candidate ||
          request.selectedCandidateId !== candidate.id ||
          candidate.appId !== scope.appId ||
          candidate.botId !== scope.botId ||
          candidate.groupOpenId !== scope.groupOpenId ||
          candidate.memberOpenId !== member ||
          candidate.provenAt
        )
          bad('群或本人身份不匹配');
        await tx.botGroupCandidate.update({
          where: { id: candidate!.id },
          data: { provenAt: this.auth.now(), finalProofHash: null }
        });
        message = '群身份已核验，请返回网站最后确认；新群默认停用';
      }
      const permit = {
        scope,
        eventId: event,
        messageDigest: createHash('sha256').update(message).digest('hex'),
        expiresAt: new Date(this.auth.now().getTime() + 30000).toISOString()
      };
      const result = {
        challengeAccepted: true,
        message,
        control: {
          ...permit,
          signature: createHmac('sha256', this.config.bridgeSecret!)
            .update('ArtZoo-Qq-Control\n' + botCanonical(permit))
            .digest('hex')
        }
      };
      await tx.qqOfficialInbound.create({
        data: { ...scope, eventKey, fingerprint, result, createdAt: this.auth.now() }
      });
      return result;
    });
  }
}
