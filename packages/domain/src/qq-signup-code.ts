import { qqPresetSeatLabels } from './qq-seat-labels.js';
import { AccountError } from './account-contract.js';

// Public activity locator, never an authorization credential. No fuzzy correction.
export const QQ_SIGNUP_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export function normalizeQqSignupCode(value: unknown): string | null {
  return typeof value === 'string' && /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/i.test(value)
    ? value.toUpperCase()
    : null;
}
export function appendQqSignupInstruction(
  text: string,
  code: string,
  scene: string,
  composition?: unknown,
  cancelled = false
): string {
  const normalized = normalizeQqSignupCode(code);
  if (!normalized) throw new AccountError('VALIDATION_ERROR', '活动报名编号无效', 400);
  const tank = qqPresetSeatLabels(composition as 'LIGHT' | 'FULL' | 'ALLIANCE')[0];
  const command =
    scene === 'OFFLINE'
      ? `报名 ${normalized}`
      : composition === 'ALLIANCE'
        ? `报名 ${normalized} A队 ${tank} 骑士`
        : composition === 'FULL' || composition === 'LIGHT'
          ? `报名 ${normalized} ${tank} 骑士`
          : null;
  const footer = cancelled
    ? `活动编号：${normalized}（已取消）`
    : command
      ? `活动编号：${normalized}\n报名示例：＠机器人 ${command}`
      : `活动编号：${normalized}\n此活动请前往网站报名。`;
  const result = trimQqNoticeLeadingLines(text + '\n\n' + footer);
  if (Array.from(result).length > 1800) {
    throw new AccountError('VALIDATION_ERROR', '消息含报名指令超过1800字，请缩短模板', 400);
  }
  return result;
}

/** Remove blank lines before notice content, preserving all internal spacing. */
export function trimQqNoticeLeadingLines(text: string): string {
  return text.replace(/^(?:[^\S\n]*\n)+/u, '');
}
