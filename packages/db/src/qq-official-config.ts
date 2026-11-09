export type QqScope = { appId: string; botId: string; groupOpenId: string };
export type QqTarget = QqScope & {
  enabled: boolean;
  testGroupOnly: boolean;
  enabledAt: Date;
  deliveryMode: 'SIMULATION' | 'LIVE';
  managed?: boolean;
  generation?: number;
};
export type QqOfficialPlanningConfig = {
  mode: 'disabled' | 'simulation' | 'live';
  target: QqTarget | null;
  passiveEnabled?: boolean;
  proactiveEnabled?: boolean;
  managedGroups?: boolean;
  buttonProbeUntil?: Date;
  signupButtons?: boolean;
};
export type QqOfficialConfig = QqOfficialPlanningConfig & { bridgeSecret: string | null };
const id = (value: string | undefined) => !!value && /^[A-Za-z0-9_=-]{1,160}$/.test(value);
/** Internal planner capability: exact approved target and gates only; never reads a transport secret. */
export function loadQqOfficialPlanningConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): QqOfficialPlanningConfig {
  const disabled: QqOfficialPlanningConfig = { mode: 'disabled', target: null };
  const mode = env.ARTZOO_QQ_MODE;
  if (mode !== 'simulation' && mode !== 'live') return disabled;
  if (mode === 'simulation' && env.ARTZOO_DEPLOYMENT_ENV !== 'local' && env.NODE_ENV !== 'test')
    return disabled;
  if (mode === 'live' && env.ARTZOO_QQ_LIVE_SEND_ENABLED !== '1') return disabled;
  if (env.ARTZOO_QQ_TARGET_KIND !== 'TEST' || env.ARTZOO_QQ_TEST_GROUP_APPROVED !== '1') return disabled;
  const { ARTZOO_QQ_APP_ID: appId, ARTZOO_QQ_BOT_ID: botId, ARTZOO_QQ_GROUP_OPENID: groupOpenId } = env;
  if (!id(appId) || !id(botId) || !id(groupOpenId)) return disabled;
  if (mode === 'simulation' && ![appId, botId, groupOpenId].every((value) => value!.startsWith('mock_')))
    return disabled;
  if (mode === 'live' && [appId, botId, groupOpenId].some((value) => value!.startsWith('mock_')))
    return disabled;
  const since = env.ARTZOO_QQ_ENABLED_AT;
  if (!since || !/(Z|[+-]\d{2}:\d{2})$/.test(since)) return disabled;
  const enabledAt = new Date(since);
  if (!Number.isFinite(enabledAt.getTime())) return disabled;
  const probe = env.ARTZOO_QQ_BUTTON_PROBE_UNTIL;
  const until = probe && /(Z|[+-]\d{2}:\d{2})$/.test(probe) ? new Date(probe) : null;
  return {
    mode,
    ...(env.ARTZOO_QQ_SIGNUP_BUTTONS_ENABLED === '1' ? { signupButtons: true } : {}),
    ...(until && Number.isFinite(until.getTime()) ? { buttonProbeUntil: until } : {}),
    ...(env.ARTZOO_QQ_MANAGED_GROUPS_ENABLED === '1' ? { managedGroups: true } : {}),
    passiveEnabled: mode === 'simulation' || env.ARTZOO_QQ_PASSIVE_ENABLED === '1',
    proactiveEnabled: mode === 'simulation' || env.ARTZOO_QQ_PROACTIVE_ENABLED === '1',
    target: {
      appId: appId!,
      botId: botId!,
      groupOpenId: groupOpenId!,
      enabled: true,
      testGroupOnly: true,
      enabledAt,
      deliveryMode: mode === 'live' ? 'LIVE' : 'SIMULATION'
    }
  };
}
/** HTTP/binding capability remains closed without a valid shared transport secret. */
export function loadQqOfficialConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): QqOfficialConfig {
  const disabled: QqOfficialConfig = { mode: 'disabled', target: null, bridgeSecret: null };
  const planning = loadQqOfficialPlanningConfig(env);
  if (!planning.target) return disabled;
  const secret = env.ARTZOO_QQ_BRIDGE_SECRET;
  if (!secret || secret.length < 32 || secret.length > 256 || /[\r\n]/.test(secret)) return disabled;
  return { ...planning, bridgeSecret: secret };
}
export function sameQqScope(a: QqScope, b: QqScope): boolean {
  return a.appId === b.appId && a.botId === b.botId && a.groupOpenId === b.groupOpenId;
}

/** Live directions require separate explicit approval. Synthetic simulation retains its existing behavior. */
export function qqPassiveEnabled(config: QqOfficialPlanningConfig): boolean {
  return config.mode === 'simulation' || (config.mode === 'live' && config.passiveEnabled === true);
}
export function qqProactiveEnabled(config: QqOfficialPlanningConfig): boolean {
  return config.mode === 'simulation' || (config.mode === 'live' && config.proactiveEnabled === true);
}
