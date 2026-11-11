import { splitActivityDescription } from '../../lib/activity-description';
import {
  BOT_LABELS,
  botTeamValues,
  renderBotReminder,
  renderBotNotice,
  renderBotTemplate,
  type BotTemplateKind,
  type BotManagementConfig
} from '@artzoo/domain';
import {
  currentBotPublication,
  botDispatchAllowed,
  botRuntimeReady,
  loadQqActivitySnapshot,
  type QqActivitySnapshot
} from '@artzoo/db';
import { AccountError } from '@artzoo/domain';
import {
  beginQqDeliveryWithActivityLock,
  claimQqDelivery,
  completeQqDelivery,
  sameQqScope,
  qqPassiveEnabled,
  qqProactiveEnabled,
  type Prisma,
  type QqOfficialConfig,
  type QqScope,
  type QqDeliveryOutcome,
  type QqDelivery
} from '@artzoo/db';
import { AccountService, lock } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import { QqBindingService } from './binding';
import { QqOfficialSignupService } from './signup';
import { parseQqSignupTarget, parseQqSignupLocator } from './signup-parser';
import { ensureQqSignupCode, signupRuntimeReady } from './signup-code';
import { appendQqSignupInstruction, normalizeQqSignupCode } from '@artzoo/domain';

const deny = (message: string): never => {
  throw new AccountError('FORBIDDEN', message, 403);
};
const text = (body: Record<string, unknown>, key: string, max = 256): string => {
  const value = body[key];
  if (typeof value !== 'string' || !value || value.length > max || /[\r\n\0]/.test(value))
    throw new AccountError('VALIDATION_ERROR', 'Bridge请求字段无效', 400);
  return value;
};
export class QqBridgeService {
  constructor(
    readonly auth: AccountService,
    readonly config: QqOfficialConfig
  ) {}
  scope(body: Record<string, unknown>, requireMode = true, allowDisabled = false): QqScope {
    const target = this.config.target;
    if (
      !target ||
      (!allowDisabled && !target.enabled) ||
      this.config.mode === 'disabled' ||
      target.enabledAt > this.auth.now()
    )
      return deny('QQ集成未启用');
    const scope = {
      appId: text(body, 'app_id', 160),
      botId: text(body, 'bot_id', 160),
      groupOpenId: text(body, 'group_openid', 160)
    };
    if (
      !sameQqScope(scope, target) ||
      (requireMode && body.simulation !== (this.config.mode === 'simulation'))
    )
      return deny('QQ群目标或运行模式不匹配');
    return scope;
  }
  async consumeNonce(nonce: string, expiresAt: Date) {
    await this.auth.transaction(async (tx) => {
      const nonceHash = tokenDigest(nonce);
      await lock(tx, `qq-nonce:${nonceHash}`);
      if (await tx.qqOfficialNonce.findUnique({ where: { nonceHash } })) return deny('Bridge请求已使用');
      await tx.qqOfficialNonce.deleteMany({
        where: { expiresAt: { lt: new Date(this.auth.now().getTime() - 86400000) } }
      });
      await tx.qqOfficialNonce.create({ data: { nonceHash, expiresAt, createdAt: this.auth.now() } });
    });
  }
  async command(body: Record<string, unknown>) {
    if (!qqPassiveEnabled(this.config)) return deny('QQ被动回复未启用');
    const scope = this.scope(body),
      memberOpenId = text(body, 'sender_openid', 160);
    if (this.config.mode === 'simulation' && !memberOpenId.startsWith('mock_'))
      return deny('模拟模式仅接受模拟身份');
    const event = text(body, 'event_id'),
      idx = text(body, 'message_idx'),
      timestamp = text(body, 'event_timestamp', 64);
    const when = new Date(timestamp),
      now = this.auth.now();
    if (
      !/(Z|[+-]\d{2}:\d{2})$/.test(timestamp) ||
      !Number.isFinite(when.getTime()) ||
      when < this.config.target!.enabledAt ||
      when.getTime() > now.getTime() + 60000 ||
      now.getTime() - when.getTime() > 5 * 60000
    )
      return deny('消息已过期，请重新操作');
    const raw = text(body, 'content', 600),
      fingerprint = tokenDigest(
        JSON.stringify([
          memberOpenId,
          raw,
          body.ref_idx ?? null,
          timestamp,
          ...(body.activity_code === undefined ? [] : [{ activityCode: body.activity_code }])
        ])
      );
    const eventKey = tokenDigest(JSON.stringify([event, idx]));
    await this.auth.rate(`qq-inbound:${tokenDigest(JSON.stringify([scope, memberOpenId]))}`, 30, 60);
    return this.auth.transaction(async (tx) => {
      await lock(tx, `qq-inbound:${tokenDigest(JSON.stringify([scope, eventKey]))}`);
      const prior = await tx.qqOfficialInbound.findFirst({ where: { ...scope, eventKey } });
      if (prior) {
        if (prior.fingerprint !== fingerprint) return deny('消息标识已被使用');
        return prior.result as { message: string };
      }
      let content = raw.trim();
      for (const prefix of [
        `<@${scope.botId}>`,
        `<@!${scope.botId}>`,
        `<qqbot-at-user id="${scope.botId}" />`
      ]) {
        if (content.startsWith(prefix)) {
          content = content.slice(prefix.length).trim();
          break;
        }
      }
      let message: string;
      try {
        const binding = new QqBindingService(this.auth, this.config);
        const candidate = /^绑定\s+([A-Za-z0-9_-]{12,64})$/.exec(content);
        if (candidate) message = await binding.bindKey(scope, memberOpenId, candidate[1]!);
        else if (/^报名(?:\s|$)/.test(content)) {
          const target = { activityCode: parseQqSignupLocator(content) };
          const refIdx =
            body.ref_idx === undefined ? undefined : text(body, 'ref_idx', target.activityCode ? 4096 : 200);
          if (
            (body.activity_code !== undefined &&
              (!target.activityCode || normalizeQqSignupCode(body.activity_code) !== target.activityCode)) ||
            (target.activityCode && normalizeQqSignupCode(body.activity_code) !== target.activityCode)
          ) {
            throw new AccountError('VALIDATION_ERROR', '报名编号与命令不一致', 400);
          }
          if (
            refIdx &&
            (await tx.botManagementTest.findUnique({
              where: { receiptDigest: tokenDigest(JSON.stringify([scope, refIdx])) }
            }))
          )
            throw new AccountError('VALIDATION_ERROR', '测试消息不能用于报名', 400);
          const signup = new QqOfficialSignupService(this.auth, this.config);
          if (target.activityCode) {
            const result = await signup.registerCode(
              scope,
              memberOpenId,
              target.activityCode,
              content,
              refIdx
            );
            if (result.replayed) throw new AccountError('CONFLICT', '你已报名该活动，无需重复报名', 409);
            const formatter = new Intl.DateTimeFormat('zh-CN', {
              timeZone: 'Asia/Shanghai',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false
            });
            const command = parseQqSignupTarget(content).command;
            const seat =
              command.kind === 'GAME'
                ? `${command.group ? command.group + '队 ' : ''}${command.label} ${command.job}`
                : '线下活动';
            message = `报名成功：${result.activity.title}｜${formatter.format(new Date(result.activity.startsAt))}｜${seat}｜编号 ${target.activityCode}`;
          } else {
            const mapped =
              refIdx &&
              (await this.auth.db.qqOfficialMessage.findFirst({
                where: { ...scope, refIdx, simulated: this.config.mode === 'simulation' }
              }));
            if (!mapped)
              message =
                '未识别到活动引用，请复制本群活动通知中的编号，发送“报名 编号 席位 职业”；也可前往网站报名';
            else {
              const result = await signup.registerReply(scope, memberOpenId, refIdx!, content);
              if (result.replayed) throw new AccountError('CONFLICT', '你已报名该活动，无需重复报名', 409);
              message =
                content === '报名'
                  ? '报名成功，请到网站查看报名结果'
                  : `报名成功：${content.slice(2).trim()}`;
            }
          }
        } else message = '仅支持回复活动消息报名；退出、换位置或换职业请到网站操作';
      } catch (error) {
        if (!(error instanceof AccountError)) throw error;
        message = error.message;
      }
      const policy = await currentBotPublication(tx, scope);
      if (policy) {
        const kind: BotTemplateKind = /^绑定\s/.test(content)
          ? 'BINDING'
          : /^报名/.test(content)
            ? message.startsWith('报名成功')
              ? 'SIGNUP_SUCCESS'
              : 'SIGNUP_FAILURE'
            : 'UNSUPPORTED';
        message = renderBotTemplate(policy.config, kind, { result: message });
      }
      const result = { message };
      await tx.qqOfficialInbound.create({
        data: { ...scope, eventKey, fingerprint, result, createdAt: now }
      });
      return result;
    });
  }
  async claim(body: Record<string, unknown>) {
    this.scope(body);
    if (!qqProactiveEnabled(this.config)) return { delivery: null };
    return this.auth.transaction(async (tx) => {
      await lock(tx, 'bot-management:write');
      if (!(await botRuntimeReady(tx, this.config.target!, this.auth.now()))) return { delivery: null };
      if (
        this.config.mode === 'live' &&
        !signupRuntimeReady(
          await tx.botManagementObservation.findUnique({ where: { id: 'qq-official' } }),
          this.auth.now()
        )
      )
        return { delivery: null };
      const claim = await claimQqDelivery(tx, this.config.target!, this.auth.now());
      if (!claim) return { delivery: null };
      const planned = await tx.qqOfficialDelivery.findUniqueOrThrow({ where: { id: claim.delivery.id } });
      if (
        !(await botDispatchAllowed(
          tx,
          this.config.target!,
          claim.delivery.kind,
          this.auth.now(),
          planned.planningEpoch
        ))
      ) {
        await tx.qqOfficialDelivery.update({
          where: { id: planned.id },
          data: { status: 'CANCELLED', resultCode: 'MANAGEMENT_EPOCH', leaseOwner: null, leaseUntil: null }
        });
        return { delivery: null };
      }
      const policy = await currentBotPublication(tx, this.config.target!);
      const saved = await tx.qqOfficialDelivery.findUniqueOrThrow({ where: { id: claim.delivery.id } });
      let content: string,
        signupCode = saved.signupCode,
        signupButton = saved.signupButton;
      try {
        if (saved.renderedContent !== null) content = saved.renderedContent;
        else {
          const activity = await loadQqActivitySnapshot(tx, claim.delivery.activityId);
          const code = await ensureQqSignupCode(
            tx,
            this.config.target!,
            claim.delivery.activityId,
            this.auth.now()
          );
          const composition =
            activity?.dutySnapshot && typeof activity.dutySnapshot === 'object'
              ? (activity.dutySnapshot as Record<string, unknown>).partyComposition
              : undefined;
          content = appendQqSignupInstruction(
            this.render(claim.delivery, policy?.config, activity),
            code,
            activity?.scene ?? claim.delivery.payload.scene,
            composition,
            claim.delivery.kind === 'CANCELLED'
          );
          signupCode = code;
          signupButton =
            this.config.signupButtons === true &&
            claim.delivery.kind !== 'CANCELLED' &&
            (activity?.scene === 'OFFLINE' || ['LIGHT', 'FULL', 'ALLIANCE'].includes(String(composition)));
        }
        if (!content.trim()) throw new AccountError('VALIDATION_ERROR', '消息正文为空', 400);
      } catch (error) {
        if (!(error instanceof AccountError) || error.code !== 'VALIDATION_ERROR') throw error;
        await tx.qqOfficialDelivery.update({
          where: { id: saved.id },
          data: { status: 'FAILED', resultCode: 'TEMPLATE_INVALID', leaseOwner: null, leaseUntil: null }
        });
        return { delivery: null };
      }
      if (saved.renderedContent === null)
        await tx.qqOfficialDelivery.update({
          where: { id: saved.id },
          data: {
            renderedContent: content,
            managementVersion: policy?.version ?? 0,
            signupCode,
            signupButton
          }
        });
      return {
        delivery: {
          delivery_id: claim.delivery.id,
          claim_token: claim.claimToken,
          idempotency_key: claim.delivery.eventKey,
          content,
          msg_seq: claim.delivery.fence,
          simulation: claim.delivery.deliveryMode !== 'LIVE',
          ...(signupCode ? { signup_code: signupCode, signup_button: signupButton } : {})
        }
      };
    });
  }
  private async identity(tx: Prisma.TransactionClient, body: Record<string, unknown>, scope: QqScope) {
    const id = text(body, 'delivery_id', 64),
      claimToken = text(body, 'claim_token', 128);
    const row = await tx.qqOfficialDelivery.findFirst({ where: { id, ...scope } });
    if (!row || row.deliveryMode !== this.config.target!.deliveryMode) return null;
    return {
      row,
      identity: { id, fence: row.fence, claimToken },
      matches: row.leaseOwner === tokenDigest(claimToken)
    };
  }
  async begin(body: Record<string, unknown>) {
    const scope = this.scope(body, false);
    if (!qqProactiveEnabled(this.config))
      return { dispatch: false, simulation: this.config.mode === 'simulation' };
    if (body.simulation !== undefined && body.simulation !== (this.config.mode === 'simulation'))
      return deny('投递运行模式不匹配');
    const scopeKey = tokenDigest(JSON.stringify([scope.appId, scope.botId]));
    await this.auth.rate(`qq-send-bot:${scopeKey}`, 20, 60);
    await this.auth.rate(`qq-send-group:${scopeKey}:${tokenDigest(scope.groupOpenId)}`, 10, 60);
    await this.auth.rate(`qq-send-day:${scopeKey}:${tokenDigest(scope.groupOpenId)}`, 500, 86400);
    return this.auth.transaction(async (tx) => {
      await lock(tx, 'bot-management:write');
      const found = await this.identity(tx, body, scope);
      if (!found?.matches) return { dispatch: false, simulation: this.config.mode === 'simulation' };
      if (
        found.row.signupCode &&
        this.config.mode === 'live' &&
        !signupRuntimeReady(
          await tx.botManagementObservation.findUnique({ where: { id: 'qq-official' } }),
          this.auth.now()
        )
      )
        return { dispatch: false, simulation: false };
      if (
        !(await botDispatchAllowed(
          tx,
          scope,
          found.row.kind as import('@artzoo/domain').BotNoticeKind,
          this.auth.now(),
          (found.row as typeof found.row & { planningEpoch: number | null }).planningEpoch
        ))
      )
        return { dispatch: false, simulation: this.config.mode === 'simulation' };
      const dispatch = await beginQqDeliveryWithActivityLock(tx, found.identity, this.config.target!, () =>
        this.auth.now()
      );
      return { dispatch: !!dispatch, simulation: this.config.mode === 'simulation' };
    });
  }
  async ack(body: Record<string, unknown>) {
    const scope = this.scope(body, false, true);
    if (body.simulation !== undefined && body.simulation !== (this.config.mode === 'simulation'))
      return deny('投递运行模式不匹配');
    const outcome = text(body, 'outcome', 32);
    return this.auth.transaction(async (tx) => {
      await lock(tx, 'bot-management:write');
      const found = await this.identity(tx, body, scope);
      if (!found) return { accepted: false, terminal: true };
      if (!found.matches) {
        const duplicate =
          (found.row.status === 'SIMULATED' && outcome === 'simulated') ||
          (found.row.status === 'SENT' &&
            outcome === 'sent' &&
            found.row.providerMessageId === body.message_id);
        return { accepted: duplicate, terminal: true };
      }
      let receipt: { messageId: string; refIdx: string } | null = null;
      let result: QqDeliveryOutcome;
      if (outcome === 'simulated' && this.config.mode === 'simulation') result = { kind: 'SIMULATED' };
      else if (outcome === 'sent' && this.config.mode === 'live') {
        const messageId = text(body, 'message_id'),
          refIdx = text(body, 'ref_idx', 200);
        if (messageId === refIdx || /\s/.test(refIdx)) result = { kind: 'UNKNOWN' };
        else {
          result = { kind: 'SENT', providerMessageId: messageId };
          receipt = { messageId, refIdx };
        }
      } else if (outcome === 'permission_denied') result = { kind: 'DENIED' };
      else if (outcome === 'unknown') result = { kind: 'UNKNOWN' };
      // After begin, do not trust generic failure as positive evidence that no request reached QQ.
      else result = { kind: 'UNKNOWN' };
      const accepted = await completeQqDelivery(tx, found.identity, result, this.auth.now());
      if (accepted && receipt) {
        await tx.qqOfficialMessage.create({
          data: {
            ...scope,
            deliveryId: found.row.id,
            activityId: found.row.activityId,
            refIdx: receipt.refIdx,
            simulated: false,
            createdAt: this.auth.now()
          }
        });
        if (found.row.signupCode)
          await tx.qqOfficialSignupCode.updateMany({
            where: {
              ...scope,
              activityId: found.row.activityId,
              code: found.row.signupCode,
              activatedAt: null
            },
            data: { activatedAt: this.auth.now() }
          });
      }
      return { accepted, terminal: !accepted };
    });
  }
  private renderLegacy(row: QqDelivery): string {
    const label: Record<string, string> = {
      PUBLISHED: '活动发布',
      CHANGED: '活动修改',
      CANCELLED: '活动取消',
      REMINDER_2H: '活动将在2小时后开始',
      REMINDER_1H: '活动将在1小时后开始'
    };
    const time = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(row.payload.startsAt));
    const plain = (value: string) =>
      value
        .slice(0, 160)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replaceAll('<', '＜')
        .replaceAll('>', '＞')
        .replaceAll('@', '＠');
    const details = [label[row.kind], plain(row.payload.activityTitle), `开始：${time}（北京时间）`];
    if (row.payload.location) details.push(`地点：${plain(row.payload.location)}`);
    if (row.kind !== 'CANCELLED')
      details.push(
        row.payload.scene === 'OFFLINE'
          ? '回复本条消息发送“报名”'
          : '回复本条消息发送“报名 席位 职业”；24人活动需填写队伍，例如“报名 A队 H1 白魔”'
      );
    return details.join('\n');
  }
  private render(
    row: QqDelivery,
    config?: BotManagementConfig,
    activity?: QqActivitySnapshot | null
  ): string {
    if (!config) return this.renderLegacy(row);
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const time =
      formatter.format(new Date(row.payload.startsAt)) +
      ' — ' +
      formatter.format(new Date(row.payload.endsAt));
    const duty =
      activity?.dutySnapshot &&
      typeof activity.dutySnapshot === 'object' &&
      !Array.isArray(activity.dutySnapshot)
        ? (activity.dutySnapshot as Record<string, unknown>).name
        : null;
    const capacity = activity?.capacityUnlimited
      ? '不限'
      : activity?._count
        ? String(activity._count.seats)
        : '';
    const registrations = activity?._count
      ? String(activity._count.registrations) + (capacity ? '/' + capacity : '')
      : '';
    const parts = splitActivityDescription(activity?.description ?? '');
    const values = {
      arrangement: parts.arrangement,
      participationRequirements: parts.requirements ?? '',
      event: BOT_LABELS[row.kind],
      title: row.payload.activityTitle,
      time,
      location: row.payload.location ?? '',
      duty: typeof duty === 'string' ? duty : '',
      capacity,
      registrations,
      ...botTeamValues({
        scene: activity?.scene ?? row.payload.scene,
        composition:
          activity?.dutySnapshot && typeof activity.dutySnapshot === 'object'
            ? (activity.dutySnapshot as Record<string, unknown>).partyComposition
            : undefined,
        seats: activity?.seats ?? []
      })
    };
    if (row.payload.reminder) return renderBotReminder(config, row.payload.reminder, values);
    if (row.kind === 'REMINDER') throw new AccountError('VALIDATION_ERROR', '提醒模板缺失', 400);
    return renderBotNotice(config, row.kind, values);
  }
}
