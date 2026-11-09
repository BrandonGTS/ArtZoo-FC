import { randomBytes } from 'node:crypto';
import { QQ_SIGNUP_CODE_ALPHABET, normalizeQqSignupCode, AccountError } from '@artzoo/domain';
import type { Prisma } from '@artzoo/db';
import type { QqSignupScope } from './signup';

export async function ensureQqSignupCode(
  tx: Prisma.TransactionClient,
  scope: QqSignupScope,
  activityId: string,
  now: Date
): Promise<string> {
  const where = {
    appId_botId_groupOpenId_activityId: {
      appId: scope.appId,
      botId: scope.botId,
      groupOpenId: scope.groupOpenId,
      activityId
    }
  };
  const prior = await tx.qqOfficialSignupCode.findUnique({ where });
  if (prior) return prior.code;
  // ON CONFLICT leaves the transaction usable for both concurrent allocation and random collisions.
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = [...randomBytes(8)].map((n) => QQ_SIGNUP_CODE_ALPHABET[n & 31]).join('');
    const inserted = await tx.$queryRaw<Array<{ code: string }>>`
      INSERT INTO "QqOfficialSignupCode" ("code","appId","botId","groupOpenId","activityId","createdAt")
      VALUES (${code},${scope.appId},${scope.botId},${scope.groupOpenId},${activityId},${now})
      ON CONFLICT DO NOTHING RETURNING "code"`;
    if (inserted[0]) return inserted[0].code;
    const concurrent = await tx.qqOfficialSignupCode.findUnique({ where });
    if (concurrent) return concurrent.code;
  }
  throw new AccountError('CONFLICT', '暂时无法分配活动编号，请稍后重试', 409);
}

export async function resolveQqSignupCode(
  tx: Prisma.TransactionClient,
  scope: QqSignupScope,
  value: string,
  simulated = false
): Promise<string> {
  const code = normalizeQqSignupCode(value);
  if (!code) throw new AccountError('VALIDATION_ERROR', '活动编号无效，请复制本群活动通知中的编号', 400);
  const row = await tx.qqOfficialSignupCode.findFirst({ where: { ...scope, code } });
  // Allocation is not activation: require a confirmed activity notice in exactly this scope.
  const sent =
    row?.activatedAt &&
    (await tx.qqOfficialMessage.findFirst({
      where: {
        ...scope,
        activityId: row.activityId,
        simulated
      },
      select: { activityId: true }
    }));
  if (!sent) throw new AccountError('NOT_FOUND', '未找到本群已发送的活动编号，请检查编号或前往网站', 404);
  return sent.activityId;
}

/** A confirmed current plugin must understand the code before a LIVE notice is leased. */
export const QQ_SIGNUP_PLUGIN_VERSION = '0.3.6';
export function signupRuntimeReady(
  seen: { telemetry: unknown; observedAt: Date; applyError: string | null } | null,
  now: Date
): boolean {
  if (!seen || seen.applyError || !seen.telemetry || typeof seen.telemetry !== 'object') return false;
  const t = seen.telemetry as Record<string, unknown>,
    age = now.getTime() - seen.observedAt.getTime();
  return (
    t.plugin_version === QQ_SIGNUP_PLUGIN_VERSION &&
    t.ready === true &&
    t.proactive_paused === false &&
    age >= 0 &&
    age <= 120000
  );
}
