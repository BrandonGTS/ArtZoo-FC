import type { QqOfficialConfig } from '@artzoo/db';
export const BUTTON_PROBE_KIND = 'BUTTON_PREFILL_PROBE';
export const BUTTON_PROBE_PLUGIN = '0.3.6';
export const BUTTON_PROBE_TEXT =
  '【按钮预填测试，不会报名】\n点击“填写报名（测试）”仅把示例指令放入输入框。\n请勿发送，检查后清空即可。\n示例指令：报名 测试编号 MT 骑士。\n“测试编号”不可用于任何活动报名。';
export function buttonProbeOpen(config: QqOfficialConfig, now: Date): boolean {
  const until = config.buttonProbeUntil?.getTime(),
    left = until === undefined ? 0 : until - now.getTime();
  return config.mode === 'live' && Number.isFinite(left) && left > 0 && left <= 30 * 60_000;
}
