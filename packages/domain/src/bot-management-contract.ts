import { appendQqSignupInstruction, trimQqNoticeLeadingLines } from './qq-signup-code.js';
import { botTeamValues } from './bot-team-values.js';
import { AccountError } from './account-contract.js';
export const BOT_NOTICE_KINDS = ['PUBLISHED', 'CHANGED', 'CANCELLED', 'REMINDER_2H', 'REMINDER_1H'] as const;
export const BOT_REPLY_KINDS = [
  'BINDING',
  'SIGNUP_SUCCESS',
  'SIGNUP_FAILURE',
  'INVALID',
  'WEBSITE_ONLY',
  'SOURCE_REJECTED',
  'UNSUPPORTED'
] as const;
export const BOT_TEMPLATE_KINDS = [...BOT_NOTICE_KINDS, ...BOT_REPLY_KINDS] as const;
export type BotNoticeKind = (typeof BOT_NOTICE_KINDS)[number];
export type BotTemplateKind = (typeof BOT_TEMPLATE_KINDS)[number];
export type BotTemplateSelection = BotTemplateKind | `reminder:${string}`;
export interface BotReminder {
  id: string;
  minutes: number;
  enabled: boolean;
  template: string;
}
export const BOT_REMINDER_LIMITS = { min: 1, max: 10080, count: 8 } as const;
export const BOT_LABELS: Record<BotTemplateKind | 'REMINDER', string> = {
  REMINDER: '提前提醒',
  PUBLISHED: '活动发布',
  CHANGED: '活动修改',
  CANCELLED: '活动取消',
  REMINDER_2H: '提前两小时提醒',
  REMINDER_1H: '提前一小时提醒',
  BINDING: '绑定回复',
  SIGNUP_SUCCESS: '报名成功',
  SIGNUP_FAILURE: '报名失败',
  INVALID: '格式错误',
  WEBSITE_ONLY: '仅网站办理',
  SOURCE_REJECTED: '来源校验失败',
  UNSUPPORTED: '不支持的操作'
};
export const BOT_PARAMETER_RULES = {
  proactivePerMinute: {
    label: '主动消息／分钟',
    min: 1,
    max: 10,
    description: '活动通知与测试消息共用，按发送尝试计数。'
  },
  proactivePerDay: {
    label: '主动消息／滚动24小时',
    min: 1,
    max: 100,
    description: '仅主动方向；不会挤占用户回复的每日预算。'
  },
  passivePerUserMinute: {
    label: '每位用户回复／分钟',
    min: 1,
    max: 10,
    description: '操作前预留回复额度；触顶时不先执行报名。'
  },
  groupPerMinute: {
    label: '全群消息／分钟',
    min: 1,
    max: 10,
    description: '两方向合计保护，仍可能限制回复。'
  },
  pollSeconds: {
    label: '轮询间隔（秒）',
    min: 10,
    max: 3600,
    description: '每轮最多领取三条；有效期不会因调大间隔而延长。'
  }
} as const;
export type BotParameters = { [K in keyof typeof BOT_PARAMETER_RULES]: number };
export interface BotManagementConfig {
  reminders?: BotReminder[];
  proactivePaused: boolean;
  notifications: Record<BotNoticeKind, boolean>;
  parameters: BotParameters;
  templates: Record<BotTemplateKind, string>;
}
export const BOT_NOTICE_VARIABLES = {
  event: '消息类别',
  title: '活动标题',
  time: '活动时间',
  location: '活动地点',
  duty: '副本名称',
  capacity: '人数信息',
  registrations: '报名情况',
  arrangement: '活动安排',
  participationRequirements: '参与要求',
  team: '队伍构成',
  vacancies: '空缺席位'
} as const;
export const BOT_REPLY_VARIABLES = { result: '操作结果' } as const;
export function botDefaults(): BotManagementConfig {
  const template =
    '{消息类别}\n{活动标题}\n{活动时间}\n{活动地点}\n{副本名称}\n{人数信息}\n{报名情况}\n{活动安排}\n{参与要求}';
  return {
    proactivePaused: false,
    notifications: { PUBLISHED: true, CHANGED: true, CANCELLED: true, REMINDER_2H: true, REMINDER_1H: true },
    parameters: {
      proactivePerMinute: 3,
      proactivePerDay: 100,
      passivePerUserMinute: 3,
      groupPerMinute: 10,
      pollSeconds: 10
    },
    templates: {
      PUBLISHED: template,
      CHANGED: template,
      CANCELLED: template,
      REMINDER_2H: template,
      REMINDER_1H: template,
      BINDING: '{操作结果}',
      SIGNUP_SUCCESS: '{操作结果}',
      SIGNUP_FAILURE: '{操作结果}',
      INVALID: '{操作结果}',
      WEBSITE_ONLY: '{操作结果}',
      SOURCE_REJECTED: '{操作结果}',
      UNSUPPORTED: '{操作结果}'
    }
  };
}
function invalid(message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400);
}
function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    return invalid('机器人配置字段无效');
  return v as Record<string, unknown>;
}
export function botTemplateVariables(kind: BotTemplateKind): Record<string, string> {
  return BOT_NOTICE_KINDS.includes(kind as BotNoticeKind) ? BOT_NOTICE_VARIABLES : BOT_REPLY_VARIABLES;
}
function validateBotTemplateText(v: unknown, label: string, notice: boolean): asserts v is string {
  if (
    typeof v !== 'string' ||
    !v.trim() ||
    v.length > 300 ||
    /[<>@]/.test(v) ||
    /\p{C}/u.test(v.replaceAll('\n', '')) ||
    /https?:\/\//i.test(v)
  )
    invalid(label + '模板含不允许的内容');
  const variables: Record<string, string> = notice ? BOT_NOTICE_VARIABLES : BOT_REPLY_VARIABLES;
  const canonical = (name: string) =>
    Object.hasOwn(variables, name) ? variables[name]! : Object.values(variables).includes(name) ? name : null;
  const names = Array.from((v as string).matchAll(/\{([^{}]*)\}/g), (x) => x[1]!);
  if (/[{}]/.test((v as string).replace(/\{[^{}]*\}/g, '')) || names.some((x) => canonical(x) === null))
    invalid('模板字段无效');
  const normalized = names.map(canonical);
  if (new Set(normalized).size !== normalized.length) invalid('模板字段不可重复');
  if (!notice && !normalized.includes('操作结果')) invalid('操作回复必须保留操作结果');
}
export function validateBotConfig(input: unknown): BotManagementConfig {
  const hasReminders = !!input && typeof input === 'object' && Object.hasOwn(input, 'reminders');
  const c = object(input, [
    'proactivePaused',
    'notifications',
    'parameters',
    'templates',
    ...(hasReminders ? ['reminders'] : [])
  ]);
  if (typeof c.proactivePaused !== 'boolean') invalid('暂停设置无效');
  const n = object(c.notifications, BOT_NOTICE_KINDS),
    params = object(c.parameters, Object.keys(BOT_PARAMETER_RULES)),
    t = object(c.templates, BOT_TEMPLATE_KINDS);
  for (const k of BOT_NOTICE_KINDS) if (typeof n[k] !== 'boolean') invalid('通知开关无效');
  for (const [k, r] of Object.entries(BOT_PARAMETER_RULES)) {
    const v = params[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < r.min || v > r.max)
      invalid(r.label + '超出安全范围');
  }
  const entries: Array<[string, unknown, boolean]> = BOT_TEMPLATE_KINDS.map((k) => [
    BOT_LABELS[k],
    t[k],
    BOT_NOTICE_KINDS.includes(k as (typeof BOT_NOTICE_KINDS)[number])
  ]);
  if (hasReminders) {
    if (!Array.isArray(c.reminders) || c.reminders.length > BOT_REMINDER_LIMITS.count)
      invalid('提前提醒最多8条');
    const ids = new Set(),
      minutes = new Set();
    for (const value of c.reminders) {
      const row = object(value, ['id', 'minutes', 'enabled', 'template']);
      if (typeof row.id !== 'string' || !/^[-A-Za-z0-9]{1,64}$/.test(row.id) || ids.has(row.id))
        invalid('提醒标识无效或重复');
      if (
        typeof row.minutes !== 'number' ||
        !Number.isSafeInteger(row.minutes) ||
        row.minutes < BOT_REMINDER_LIMITS.min ||
        row.minutes > BOT_REMINDER_LIMITS.max ||
        minutes.has(row.minutes)
      )
        invalid('提前时长须为1至10080分钟且不可重复');
      if (typeof row.enabled !== 'boolean') invalid('提醒开关无效');
      ids.add(row.id);
      minutes.add(row.minutes);
      entries.push(['提前提醒', row.template, true]);
    }
  }
  for (const [label, v, notice] of entries) validateBotTemplateText(v, label, notice);
  if (new TextEncoder().encode(JSON.stringify(c)).byteLength > 6500) invalid('配置内容过长，请缩短模板');
  return JSON.parse(JSON.stringify(c)) as BotManagementConfig;
}
export function botCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(botCanonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + botCanonical(v))
      .join(',') +
    '}'
  );
}
export function botPlain(value: string, limit = 600, multiline = false): string {
  return value
    .slice(0, limit)
    .replace(/\r\n?/g, '\n')
    .replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ')
    .replaceAll('<', '＜')
    .replaceAll('>', '＞')
    .replaceAll('@', '＠');
}
function substituteBotTemplate(
  template: string,
  aliases: Record<string, string>,
  values: Record<string, string>
): string {
  const result = template.replace(/\{([^{}]*)\}/g, (_, key: string) => {
    const english = Object.keys(aliases).find((k) => aliases[k] === key) ?? key;
    return botPlain(
      Object.hasOwn(values, english)
        ? values[english]!
        : Object.hasOwn(aliases, english) && Object.hasOwn(values, aliases[english]!)
          ? values[aliases[english]!]!
          : '',
      english === 'team' || english === 'vacancies' ? 8000 : 600,
      english === 'arrangement' || english === 'participationRequirements' || english === 'vacancies'
    );
  });
  if (Array.from(result).length > 1800) invalid('消息正文超过1800字，请缩短模板');
  return result;
}
export function renderBotTemplate(
  config: BotManagementConfig,
  kind: BotTemplateKind,
  values: Record<string, string>
): string {
  const valid = validateBotConfig(config);
  const reply = BOT_REPLY_KINDS.includes(kind as (typeof BOT_REPLY_KINDS)[number]);
  const text = substituteBotTemplate(
    reply ? '{操作结果}' : valid.templates[kind],
    botTemplateVariables(kind),
    values
  );
  return reply ? text : trimQqNoticeLeadingLines(text);
}

// Preserve user literals and body spacing; omit blank lines before the notice begins.
export function renderBotNotice(
  config: BotManagementConfig,
  kind: BotNoticeKind,
  values: Record<string, string>,
  _offline = false
): string {
  return renderBotTemplate(config, kind, values);
}
export function botPreviewValues(kind: BotTemplateKind): Record<string, string> {
  return {
    event: BOT_LABELS[kind],
    title: '周末副本活动',
    time: '2030/06/01 20:00 — 2030/06/01 22:00',
    location: '海雾村',
    duty: '黄金谷',
    capacity: '4',
    registrations: '2/4',
    arrangement: '先讲解机制\n再练习通关',
    participationRequirements: '熟悉基础循环\n准备食物与装备',
    ...botTeamValues({
      scene: 'GAME',
      composition: 'LIGHT',
      seats: [
        { position: 0, groupKey: null, kind: 'ANY', registration: null },
        { position: 1, groupKey: null, kind: 'JOB', job: '白魔法师', registration: { status: 'ACTIVE' } },
        { position: 2, groupKey: null, kind: 'JOB', job: '武僧', registration: null },
        { position: 3, groupKey: null, kind: 'ROLE', role: 'DAMAGE', registration: { status: 'ACTIVE' } }
      ]
    }),
    result:
      kind === 'SIGNUP_FAILURE'
        ? '报名失败：活动已截止（示例）'
        : kind === 'BINDING'
          ? '请返回网站完成本人绑定确认（示例）'
          : '操作结果（示例）'
  };
}
export function previewBotTemplate(config: unknown, kind: unknown) {
  const c = validateBotConfig(config);
  if (typeof kind !== 'string') invalid('请选择模板');
  const append = (text: string, cancelled = false) =>
    appendQqSignupInstruction(text, '7K4M2Q9R', 'GAME', 'LIGHT', cancelled);
  if (kind.startsWith('reminder:')) {
    const reminder = botReminders(c).find((x) => x.id === kind.slice(9));
    if (!reminder) invalid('请选择提醒模板');
    return {
      text: append(renderBotReminder(c, reminder, botPreviewValues('REMINDER_2H'))),
      simulation: true as const
    };
  }
  if (!BOT_TEMPLATE_KINDS.includes(kind as BotTemplateKind)) invalid('请选择模板');
  const text = renderBotTemplate(c, kind as BotTemplateKind, botPreviewValues(kind as BotTemplateKind));
  return {
    text: BOT_NOTICE_KINDS.includes(kind as BotNoticeKind) ? append(text, kind === 'CANCELLED') : text,
    simulation: true as const
  };
}
// Display old saved aliases in Chinese without changing persisted history until explicit save.
export function botConfigForEditing<T extends BotManagementConfig>(config: T): T {
  const c = JSON.parse(JSON.stringify(config)) as T;
  c.reminders = botReminders(c);
  const normalize = (value: string, aliases: Record<string, string>) =>
    value.replace(/\{([^{}]*)\}/g, (all, key: string) =>
      Object.hasOwn(aliases, key) ? '{' + aliases[key] + '}' : all
    );
  for (const kind of BOT_TEMPLATE_KINDS)
    c.templates[kind] = normalize(c.templates[kind], botTemplateVariables(kind));
  for (const reminder of c.reminders) reminder.template = normalize(reminder.template, BOT_NOTICE_VARIABLES);
  return c;
}
export interface BotManagementSnapshot {
  draft: BotManagementConfig;
  draftRevision: number;
  publishedVersion: number;
  publishedConfig: BotManagementConfig | null;
  publicationStatus: 'UNPUBLISHED' | 'PENDING' | 'APPLIED' | 'FAILED' | 'STALE';
  publishedAt: string | null;
  observedAt: string | null;
  applyError: string | null;
  scope: { appId: string; botId: string; groupOpenId: string } | null;
  telemetry: Record<string, unknown> | null;
  sendRecords: Array<{ id: string; direction: string; outcome: string; observedAt: string; eventAt: string }>;
  counts: Record<string, number>;
  audits: Array<{
    id: string;
    action: string;
    actorId: string;
    before: unknown;
    after: unknown;
    createdAt: string;
  }>;
  deliveries: Array<{
    id: string;
    kind: string;
    status: string;
    resultCode: string | null;
    createdAt: string;
  }>;
  tests: Array<{ id: string; status: string; createdAt: string }>;
}

export type BotManagementSettings = Pick<
  BotManagementSnapshot,
  | 'draft'
  | 'draftRevision'
  | 'publishedVersion'
  | 'publishedConfig'
  | 'publicationStatus'
  | 'applyError'
  | 'scope'
> & { buttonProbe?: { available: boolean; used: boolean; expiresAt: string } };

export type BotEditingConfig = Omit<BotManagementConfig, 'parameters'> & {
  parameters: { [K in keyof BotParameters]: number | null };
};
export function botEditorStatus(
  form: BotEditingConfig,
  published: BotManagementConfig | null,
  status: BotManagementSettings['publicationStatus'],
  dirty = false,
  stale = false
) {
  if (stale) return 'CHANGED' as const;
  if (
    dirty ||
    (status === 'APPLIED' &&
      (!published ||
        botCanonical(botConfigForEditing(form as BotManagementConfig)) !==
          botCanonical(botConfigForEditing(published))))
  )
    return 'UNSAVED' as const;
  return status;
}

export function botReminders(config: BotManagementConfig): BotReminder[] {
  return config.reminders
    ? JSON.parse(JSON.stringify(config.reminders))
    : [
        {
          id: 'legacy-120',
          minutes: 120,
          enabled: config.notifications.REMINDER_2H,
          template: config.templates.REMINDER_2H
        },
        {
          id: 'legacy-60',
          minutes: 60,
          enabled: config.notifications.REMINDER_1H,
          template: config.templates.REMINDER_1H
        }
      ];
}
export function botReminderLabel(minutes: number) {
  return '提前' + minutes + '分钟提醒';
}
export function renderBotReminder(
  config: BotManagementConfig,
  reminder: BotReminder,
  values: Record<string, string>
) {
  validateBotConfig(config);
  validateBotTemplateText(reminder.template, '提前提醒', true);
  return trimQqNoticeLeadingLines(
    substituteBotTemplate(reminder.template, BOT_NOTICE_VARIABLES, {
      ...values,
      event: botReminderLabel(reminder.minutes)
    })
  );
}

export interface BotTestStatus {
  id: string;
  status: string;
  resultCode: string | null;
  createdAt: string;
  sentAt: string | null;
  simulation: boolean;
}
export function botTestMessage(config: unknown, kind: unknown): string {
  const text = '【测试消息】\n' + previewBotTemplate(config, kind).text + '\n此消息不能用于报名。';
  if (Array.from(text).length > 1800) invalid('测试消息超过1800字，请缩短模板');
  return text;
}
