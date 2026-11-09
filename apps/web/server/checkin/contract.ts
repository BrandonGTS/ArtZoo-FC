import { AccountError, BEIJING_OFFSET_MS } from '@artzoo/domain';
export interface CheckinSummary {
  month: string;
  today: string;
  checkedInToday: boolean;
  count: number;
  days: string[];
  serverNow: string;
}
export function beijingDay(now: Date): string {
  return new Date(now.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}
export function checkinMonth(value: unknown, now: Date): string {
  if (value === undefined || value === null) return beijingDay(now).slice(0, 7);
  if (typeof value !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value))
    throw new AccountError('VALIDATION_ERROR', '月份无效', 400);
  return value;
}
