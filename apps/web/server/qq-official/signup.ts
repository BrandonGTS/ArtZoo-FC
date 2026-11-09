import { requireCurrentQqGroup, type QqOfficialConfig } from '@artzoo/db';
import { AccountService, lock } from '../auth/service';
import { AccountError, type ActivityWriteResult } from '@artzoo/domain';
import { ActivityService } from '../activities/service';
import { tokenDigest } from '../auth/crypto';
import { resolveBoundActor, revalidateBoundActor } from './binding';
import { parseQqSignup, parseQqSignupTarget, parseQqSignupLocator, qqSignupInput } from './signup-parser';

import { resolveQqSignupCode } from './signup-code';

export interface QqSignupScope {
  appId: string;
  botId: string;
  groupOpenId: string;
}

export class QqOfficialSignupService extends ActivityService {
  constructor(
    auth: AccountService,
    readonly qqConfig?: QqOfficialConfig
  ) {
    super(auth);
  }
  async registerCode(
    scope: QqSignupScope,
    memberOpenId: string,
    code: string,
    content: string,
    refIdx?: string
  ): Promise<ActivityWriteResult> {
    if (parseQqSignupLocator(content) !== code)
      throw new AccountError('VALIDATION_ERROR', '报名编号与命令不一致', 400);
    if (
      ![scope.appId, scope.botId, scope.groupOpenId, memberOpenId].every(
        (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/\s/u.test(value)
      )
    ) {
      throw new AccountError('VALIDATION_ERROR', '报名来源无效', 400);
    }
    await this.auth.rate(
      `qq-signup:${tokenDigest(JSON.stringify([scope.appId, scope.botId, scope.groupOpenId, memberOpenId]))}`,
      120,
      900
    );
    return this.registerResolved(
      async (tx) => {
        const resolve = async () => {
          if (
            this.qqConfig?.managedGroups &&
            this.qqConfig.target &&
            !(await requireCurrentQqGroup(tx, this.qqConfig, this.qqConfig.target, this.auth.now()))
          ) {
            throw new AccountError('FORBIDDEN', '群已停用或配置已变化', 403);
          }
          const id = await resolveQqSignupCode(tx, scope, code, this.qqConfig?.mode === 'simulation');
          if (refIdx) {
            const quoted = await tx.qqOfficialMessage.findFirst({
              where: { ...scope, refIdx, simulated: this.qqConfig?.mode === 'simulation' }
            });
            if (quoted && quoted.activityId !== id)
              throw new AccountError('VALIDATION_ERROR', '活动编号与引用活动不一致，请核对后重新发送', 400);
          }
          return id;
        };
        if (this.qqConfig?.managedGroups) await lock(tx, 'bot-management:write');
        const id = await resolve(),
          actor = await resolveBoundActor(tx, scope, memberOpenId, this.auth);
        return {
          id,
          actor,
          revalidate: async () => {
            await resolve();
            await revalidateBoundActor(tx, scope, memberOpenId, this.auth, actor);
          }
        };
      },
      (row) => qqSignupInput(row, parseQqSignupTarget(content).command)
    );
  }
  async registerReply(
    scope: QqSignupScope,
    memberOpenId: string,
    refIdx: string,
    content: string
  ): Promise<ActivityWriteResult> {
    if (
      ![scope.appId, scope.botId, scope.groupOpenId, memberOpenId, refIdx].every(
        (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/\s/u.test(value)
      )
    ) {
      throw new AccountError('VALIDATION_ERROR', '请回复对应活动通知报名；其他操作请前往网站', 400);
    }
    // Run rate limiting before taking any business locks; AccountService.rate owns its transaction.
    await this.auth.rate(
      `qq-signup:${tokenDigest(JSON.stringify([scope.appId, scope.botId, scope.groupOpenId, memberOpenId]))}`,
      120,
      900
    );
    return this.registerResolved(
      async (tx) => {
        if (this.qqConfig?.managedGroups && this.qqConfig.target) {
          await lock(tx, 'bot-management:write');
          if (!(await requireCurrentQqGroup(tx, this.qqConfig, this.qqConfig.target, this.auth.now())))
            throw new AccountError('FORBIDDEN', '群已停用或配置已变化', 403);
        }
        const message = await tx.qqOfficialMessage.findFirst({
          where: {
            appId: scope.appId,
            botId: scope.botId,
            groupOpenId: scope.groupOpenId,
            refIdx
          },
          select: { activityId: true }
        });
        if (!message)
          throw new AccountError('NOT_FOUND', '未找到本群对应活动通知，请回复活动通知报名或前往网站', 404);
        const actor = await resolveBoundActor(tx, scope, memberOpenId, this.auth);
        return {
          id: message.activityId,
          actor,
          revalidate: async () => {
            if (
              this.qqConfig?.managedGroups &&
              this.qqConfig.target &&
              !(await requireCurrentQqGroup(tx, this.qqConfig, this.qqConfig.target, this.auth.now()))
            )
              throw new AccountError('FORBIDDEN', '群已停用或配置已变化', 403);
            await revalidateBoundActor(tx, scope, memberOpenId, this.auth, actor);
          }
        };
      },
      (row) => qqSignupInput(row, parseQqSignup(content))
    );
  }
}
