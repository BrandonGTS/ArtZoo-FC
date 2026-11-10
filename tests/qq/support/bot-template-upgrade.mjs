// Maintenance-only helper: no publication, audit, activation or schedule writes.
import { createHash } from 'node:crypto';
import {
  botCanonical,
  validateBotConfig,
  BOT_NOTICE_KINDS
} from '../../../packages/domain/src/bot-management-contract.ts';
import { lockQqReminderPlanning } from '../../../packages/db/src/qq-official-notifications.ts';
const hash = (v) =>
  createHash('sha256')
    .update(botCanonical(JSON.parse(JSON.stringify(v))))
    .digest('hex');
const fail = (code, target = '') => {
  const e = new Error(code + (target ? ': ' + target : ''));
  e.code = code;
  throw e;
};
const scopeKeys = ['appId', 'botId', 'groupOpenId'];
function scopeKey(s) {
  if (!s || Object.keys(s).length !== 3 || scopeKeys.some((k) => typeof s[k] !== 'string' || !s[k]))
    fail('INVALID_PRECISE_SCOPE');
  return scopeKeys.map((k) => s[k]).join('\0');
}
const scopeOf = (r) => Object.fromEntries(scopeKeys.map((k) => [k, r[k]]));
export function upgradeTemplateText(text, target = 'template') {
  if (typeof text !== 'string') fail('INVALID_TEMPLATE', target);
  let result = text;
  for (const [en, cn] of [
    ['arrangement', '活动安排'],
    ['participationRequirements', '参与要求']
  ]) {
    if (new RegExp('\\{(?:' + en + '|' + cn + ')\\}').test(text)) continue;
    // An existing literal heading requires human review; never guess its intended body.
    if (new RegExp('(?:^|\\n)\\s*(?:' + en + '|' + cn + ')(?:\\s*[:：]|\\s*(?:\\n|$))', 'i').test(text))
      fail('TEMPLATE_TITLE_CONFLICT', target + '.' + en);
    result += '\n' + cn + '：{' + cn + '}';
  }
  if (result.length > 300) fail('TEMPLATE_LENGTH_LIMIT', target);
  return result;
}
export function planBotTemplateUpgrade(source) {
  try {
    validateBotConfig(source);
  } catch {
    fail('SOURCE_CONFIG_INVALID');
  }
  const config = structuredClone(source),
    changes = [];
  for (const kind of BOT_NOTICE_KINDS) {
    const value = upgradeTemplateText(config.templates[kind], 'templates.' + kind);
    if (value !== config.templates[kind]) {
      changes.push('templates.' + kind);
      config.templates[kind] = value;
    }
  }
  for (const row of config.reminders ?? []) {
    const value = upgradeTemplateText(row.template, 'reminders.' + row.id);
    if (value !== row.template) {
      changes.push('reminders.' + row.id);
      row.template = value;
    }
  }
  if (new TextEncoder().encode(JSON.stringify(config)).byteLength > 6500) fail('CONFIG_LENGTH_LIMIT');
  try {
    validateBotConfig(config);
  } catch {
    fail('UPGRADED_CONFIG_INVALID');
  }
  return { config, changes, sourceDigest: hash(source), targetDigest: hash(config) };
}
export function planPendingReminderTemplateUpgrade(rows, preciseScopes) {
  if (!Array.isArray(preciseScopes) || !preciseScopes.length) fail('INVALID_PRECISE_SCOPE');
  const scopes = new Set(preciseScopes.map(scopeKey));
  if (scopes.size !== preciseScopes.length) fail('DUPLICATE_SCOPE');
  const plans = [];
  for (const row of rows) {
    if (
      !scopes.has(scopeKey(scopeOf(row))) ||
      row.status !== 'PENDING' ||
      row.attempts !== 0 ||
      row.renderedContent !== null ||
      !['REMINDER', 'REMINDER_2H', 'REMINDER_1H'].includes(row.kind) ||
      !row.payload?.reminder
    )
      continue;
    const after = structuredClone(row.payload),
      template = upgradeTemplateText(after.reminder.template, 'pending-reminder');
    if (template === after.reminder.template) continue;
    after.reminder.template = template;
    if (plans.some((p) => p.id === row.id)) fail('DUPLICATE_DELIVERY');
    plans.push({ id: row.id, scope: scopeOf(row), before: structuredClone(row), afterPayload: after });
  }
  return plans;
}
export async function applyPendingReminderTemplateUpgrade(
  tx,
  { expectedVersion, expectedDigest, preciseScopes, plans }
) {
  if (
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 ||
    !/^[a-f0-9]{64}$/.test(expectedDigest ?? '')
  )
    fail('INVALID_PUBLICATION_GUARD');
  if (!Array.isArray(plans)) fail('INVALID_PLAN');
  const scopes = new Set(preciseScopes.map(scopeKey));
  if (!scopes.size || scopes.size !== preciseScopes.length) fail('INVALID_PRECISE_SCOPE');
  await tx.$queryRawUnsafe(
    'SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text',
    'bot-management:write'
  );
  await lockQqReminderPlanning(tx);
  const state = await tx.botManagementState.findUnique({ where: { id: 'qq-official' } });
  const publication = await tx.botManagementPublication.findUnique({ where: { version: expectedVersion } });
  if (
    !state ||
    state.publishedVersion !== expectedVersion ||
    !publication ||
    publication.digest !== expectedDigest ||
    hash(publication.config) !== expectedDigest
  )
    fail('PUBLICATION_CHANGED');
  // Deliberately narrow: only the exact publication scope, not inferred managed groups.
  if (
    scopes.size !== 1 ||
    !scopes.has(scopeKey(publication.scope)) ||
    scopeKey(state.scope) !== scopeKey(publication.scope)
  )
    fail('PUBLICATION_SCOPE_MISMATCH');
  let updated = 0,
    unchanged = 0;
  const ids = new Set();
  for (const plan of plans) {
    if (ids.has(plan.id) || !scopes.has(scopeKey(plan.scope)) || plan.id !== plan.before.id)
      fail('INVALID_PLAN');
    ids.add(plan.id);
    const rebuilt = planPendingReminderTemplateUpgrade([plan.before], preciseScopes);
    if (rebuilt.length !== 1 || hash(rebuilt[0]) !== hash(plan)) fail('INVALID_PLAN');
    await tx.$queryRawUnsafe('SELECT "id" FROM "QqOfficialDelivery" WHERE "id"=$1 FOR UPDATE', plan.id);
    const current = await tx.qqOfficialDelivery.findUnique({ where: { id: plan.id } });
    if (!current) fail('DELIVERY_CHANGED');
    if (hash(current) === hash({ ...plan.before, payload: plan.afterPayload })) {
      unchanged++;
      continue;
    }
    if (hash(current) !== hash(plan.before)) fail('DELIVERY_CHANGED');
    const count = await tx.$executeRawUnsafe(
      'UPDATE "QqOfficialDelivery" SET "payload"=$1::jsonb WHERE "id"=$2 AND "appId"=$3 AND "botId"=$4 AND "groupOpenId"=$5 AND "status"=$6 AND "attempts"=0 AND "renderedContent" IS NULL AND "payload"=$7::jsonb',
      JSON.stringify(plan.afterPayload),
      plan.id,
      plan.scope.appId,
      plan.scope.botId,
      plan.scope.groupOpenId,
      'PENDING',
      JSON.stringify(plan.before.payload)
    );
    if (count !== 1) fail('DELIVERY_CAS_FAILED');
    updated++;
  }
  return { updated, unchanged };
}
