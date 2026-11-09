// Input formatting only. The server remains authoritative for eligibility and uniqueness.
export const mainlandPhoneMessage = '请输入有效的11位中国大陆手机号';
export function mainlandPhoneDigits(input: string): string | null {
  const compact = input.trim().replace(/[ -]/g, '');
  const national = compact.startsWith('+86')
    ? compact.slice(3)
    : compact.startsWith('0086')
      ? compact.slice(4)
      : compact;
  return /^1[3-9]\d{9}$/.test(national) ? national : null;
}
export function mainlandPhoneInput(input: string): string {
  // Normalize only a complete valid number; preserve incomplete/invalid input for correction.
  return mainlandPhoneDigits(input) ?? input;
}
export function mainlandPhoneE164(input: string): string {
  const digits = mainlandPhoneDigits(input);
  if (!digits) throw new Error(mainlandPhoneMessage);
  return '+86' + digits;
}
export function validateMainlandPhone(_: unknown, value: unknown): Promise<void> {
  return typeof value === 'string' && mainlandPhoneDigits(value)
    ? Promise.resolve()
    : Promise.reject(new Error(mainlandPhoneMessage));
}
