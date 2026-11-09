import { createHash } from 'node:crypto';
import { botCanonical } from '@artzoo/domain';
import type { Prisma } from './generated/prisma/client.js';
import type { QqOfficialPlanningConfig, QqTarget, QqScope } from './qq-official-config.js';
export const BOT_GROUP_LIMIT = 20;
export async function configuredQqGroups(
  tx: Prisma.TransactionClient,
  config: QqOfficialPlanningConfig,
  includeDisabled = false
) {
  const main = config.target;
  if (!main) return [];
  const rows = config.managedGroups
    ? await tx.botGroup.findMany({
        where: { appId: main.appId, botId: main.botId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      })
    : [];
  const groups = rows.map((row) => ({
    ...main,
    id: row.id,
    label: row.label,
    groupOpenId: row.groupOpenId,
    enabled: row.enabled,
    enabledAt: row.enabledAt ?? new Date(8640000000000000),
    testGroupOnly: row.legacy,
    managed: true,
    generation: row.generation
  }));
  if (!rows.some((row) => row.groupOpenId === main.groupOpenId))
    groups.unshift({ id: 'legacy', label: 'ArtZoo 公会网站测试群', ...main, managed: false, generation: 0 });
  return includeDisabled ? groups : groups.filter((g) => g.enabled);
}
export async function resolveQqGroup(
  tx: Prisma.TransactionClient,
  config: QqOfficialPlanningConfig,
  groupOpenId: string,
  includeDisabled = false
) {
  return (
    (await configuredQqGroups(tx, config, includeDisabled)).find((g) => g.groupOpenId === groupOpenId) ?? null
  );
}
export async function requireCurrentQqGroup(
  tx: Prisma.TransactionClient,
  config: QqOfficialPlanningConfig,
  target: QqTarget,
  now: Date
) {
  const current = await resolveQqGroup(tx, config, target.groupOpenId);
  return (
    (await qqGroupsAdopted(tx, config, now)) &&
    !!current &&
    current.enabledAt <= now &&
    (current.generation ?? 0) === (target.generation ?? 0) &&
    current.enabledAt.getTime() === target.enabledAt.getTime()
  );
}
export async function ensureLegacyQqGroup(
  tx: Prisma.TransactionClient,
  config: QqOfficialPlanningConfig,
  now: Date
) {
  const target = config.target;
  if (!target || !config.managedGroups) return;
  const existing = await tx.botGroup.findUnique({
    where: {
      appId_botId_groupOpenId: { appId: target.appId, botId: target.botId, groupOpenId: target.groupOpenId }
    }
  });
  if (existing) return;
  await tx.botGroup.create({
    data: {
      appId: target.appId,
      botId: target.botId,
      groupOpenId: target.groupOpenId,
      label: 'ArtZoo 公会网站测试群',
      enabled: target.enabled,
      enabledAt: target.enabledAt,
      generation: 0,
      boundAt: now,
      legacy: true
    }
  });
  await tx.botGroupState.upsert({
    where: { id: 'qq-official' },
    create: { id: 'qq-official', revision: 1 },
    update: { revision: { increment: 1 } }
  });
}
export async function qqGroupRegistry(tx: Prisma.TransactionClient, config: QqOfficialPlanningConfig) {
  const groups = (await configuredQqGroups(tx, config, true)).map((g) => ({
    groupOpenId: g.groupOpenId,
    label: g.label,
    enabled: g.enabled,
    enabledAt: g.enabled ? g.enabledAt.toISOString() : null,
    generation: g.generation
  }));
  const revision = (await tx.botGroupState.findUnique({ where: { id: 'qq-official' } }))?.revision ?? 0;
  const value = { appId: config.target!.appId, botId: config.target!.botId, revision, groups };
  return { ...value, digest: createHash('sha256').update(botCanonical(value)).digest('hex') };
}
export async function qqPolicyScopeAllowed(tx: Prisma.TransactionClient, control: unknown, scope: QqScope) {
  if (!control || typeof control !== 'object') return false;
  const value = control as Record<string, unknown>;
  if (value.appId !== scope.appId || value.botId !== scope.botId) return false;
  if (value.groupOpenId === scope.groupOpenId) return true;
  return !!(await tx.botGroup.findUnique({
    where: {
      appId_botId_groupOpenId: { appId: scope.appId, botId: scope.botId, groupOpenId: scope.groupOpenId }
    }
  }));
}

export async function qqGroupsAdopted(
  tx: Prisma.TransactionClient,
  config: QqOfficialPlanningConfig,
  now: Date
) {
  if (!config.managedGroups) return true;
  const registry = await qqGroupRegistry(tx, config),
    seen = await tx.botManagementObservation.findUnique({ where: { id: 'qq-official' } });
  return (
    !!seen &&
    seen.groupRevision === registry.revision &&
    seen.groupDigest === registry.digest &&
    !seen.applyError &&
    now.getTime() - seen.observedAt.getTime() <= 120000
  );
}
export async function lockCurrentQqGroup(
  tx: Prisma.TransactionClient,
  config: QqOfficialPlanningConfig,
  now: Date
) {
  if (!config.managedGroups || !config.target) return true;
  const t = config.target;
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "BotGroup" WHERE "appId"=$1 AND "botId"=$2 AND "groupOpenId"=$3 FOR SHARE',
    t.appId,
    t.botId,
    t.groupOpenId
  );
  return requireCurrentQqGroup(tx, config, t, now);
}
