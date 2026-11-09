import { qqPolicyScopeAllowed, qqGroupRegistry } from './qq-groups.js';
import { validateBotConfig, type BotManagementConfig, type BotNoticeKind } from '@artzoo/domain';
import type { Prisma } from './generated/prisma/client.js';
import type { QqScope } from './qq-official-config.js';
export const BOT_MANAGEMENT_ID = 'qq-official';
export function botScopeMatches(value: unknown, scope: QqScope): boolean {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return s.appId === scope.appId && s.botId === scope.botId && s.groupOpenId === scope.groupOpenId;
}
export async function currentBotPublication(tx: Prisma.TransactionClient, scope: QqScope) {
  const state = await tx.botManagementState.findUnique({ where: { id: BOT_MANAGEMENT_ID } });
  if (!state?.publishedVersion) return null;
  if (!(await qqPolicyScopeAllowed(tx, state.scope, scope)))
    throw new Error('Bot configuration scope mismatch');
  const pub = await tx.botManagementPublication.findUniqueOrThrow({
    where: { version: state.publishedVersion }
  });
  if (!(await qqPolicyScopeAllowed(tx, pub.scope, scope))) throw new Error('Bot publication scope mismatch');
  return { ...pub, config: validateBotConfig(pub.config) };
}
export function botNoticeAllowed(config: BotManagementConfig, kind: BotNoticeKind | 'REMINDER') {
  return !config.proactivePaused && (kind === 'REMINDER' ? true : config.notifications[kind] === true);
}
export async function botRuntimeReady(tx: Prisma.TransactionClient, scope: QqScope, now: Date) {
  const pub = await currentBotPublication(tx, scope);
  if (!pub) return true;
  if (pub.config.proactivePaused) return false;
  const seen = await tx.botManagementObservation.findUnique({ where: { id: BOT_MANAGEMENT_ID } });
  const groups = await tx.botGroupState.findUnique({ where: { id: 'qq-official' } });
  if (groups) {
    const registry = await qqGroupRegistry(tx, {
      mode: 'live',
      target: {
        ...scope,
        groupOpenId: (pub.scope as Record<string, string>).groupOpenId!,
        enabled: true,
        testGroupOnly: true,
        enabledAt: new Date(0),
        deliveryMode: 'LIVE'
      },
      managedGroups: true
    });
    if (seen?.groupRevision !== registry.revision || seen?.groupDigest !== registry.digest) return false;
  }
  return (
    !!seen &&
    !seen.applyError &&
    seen.reportedVersion === pub.version &&
    seen.reportedDigest === pub.digest &&
    (seen.telemetry as Record<string, unknown>).ready === true &&
    now.getTime() - seen.observedAt.getTime() <= 120000
  );
}
export async function botDispatchAllowed(
  tx: Prisma.TransactionClient,
  scope: QqScope,
  kind: BotNoticeKind | 'REMINDER',
  now: Date,
  planningEpoch?: number | null
) {
  const pub = await currentBotPublication(tx, scope);
  return (
    (!pub ||
      (botNoticeAllowed(pub.config, kind) &&
        (planningEpoch === undefined || (planningEpoch ?? 0) === pub.notificationEpoch))) &&
    (await botRuntimeReady(tx, scope, now))
  );
}
