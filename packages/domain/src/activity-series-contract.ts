import { BEIJING_OFFSET_MS } from './beijing-time.js';
import { invalid } from './account-contract.js';

export type ActivityScene = 'GAME' | 'OFFLINE';
export type ActivityMode = 'SINGLE' | 'SERIES';
export interface OfflineActivityInput {
  location: string;
  meetingInstructions: string;
  registrationClosesAt: string;
  capacity: number | null;
}
export type SeriesEnd = { kind: 'COUNT'; count: number } | { kind: 'DATE'; date: string };
export interface ActivitySeriesInput {
  weekdays: number[];
  durationMinutes: number;
  end: SeriesEnd;
}
export interface ActivitySeriesSummary {
  id: string;
  state: 'RECRUITING' | 'FORMED' | 'CANCELLED';
  formedAt: string | null;
  periodNumber: number;
  totalPeriods: number;
  periods: {
    id: string;
    revision: number;
    number: number;
    startsAt: string;
    endsAt: string;
    cancelledAt: string | null;
  }[];
}
export const SERIES_LIMITS = { minPeriods: 2, maxPeriods: 10 } as const;
const exact = (value: Record<string, unknown>, keys: string[], field: string) => {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid(field, '包含不允许提交的字段');
};
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, '内容格式无效');
  return value as Record<string, unknown>;
}
export function validateSeriesInput(value: unknown): ActivitySeriesInput {
  const input = object(value, 'series');
  exact(input, ['weekdays', 'durationMinutes', 'end'], 'series');
  if (
    !Array.isArray(input.weekdays) ||
    !input.weekdays.length ||
    input.weekdays.length > 7 ||
    input.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) ||
    new Set(input.weekdays).size !== input.weekdays.length
  )
    invalid('weekdays', '请选择每周重复的日期');
  if (
    !Number.isSafeInteger(input.durationMinutes) ||
    Number(input.durationMinutes) < 1 ||
    Number(input.durationMinutes) > 2147483647
  )
    invalid('durationMinutes', '每期时长须为正整数分钟');
  const end = object(input.end, 'seriesEnd');
  if (end.kind === 'COUNT') {
    exact(end, ['kind', 'count'], 'seriesEnd');
    if (!Number.isInteger(end.count) || Number(end.count) < 2 || Number(end.count) > 10)
      invalid('seriesEnd', '总期数须为2至10期');
  } else if (end.kind === 'DATE') {
    exact(end, ['kind', 'date'], 'seriesEnd');
    if (
      typeof end.date !== 'string' ||
      !/^\d{4}-\d\d-\d\d$/.test(end.date) ||
      !Number.isFinite(Date.parse(end.date + 'T00:00:00Z')) ||
      new Date(end.date + 'T00:00:00Z').toISOString().slice(0, 10) !== end.date
    )
      invalid('seriesEnd', '结束日期无效');
  } else invalid('seriesEnd', '请选择总期数或结束日期');
  return {
    weekdays: [...(input.weekdays as number[])].sort((a, b) => a - b),
    durationMinutes: Number(input.durationMinutes),
    end: end as unknown as SeriesEnd
  };
}
// All dates advance in a UTC surrogate for Beijing local time; the host timezone never participates.
export function generateSeriesPeriods(
  firstStartsAt: Date,
  input: ActivitySeriesInput
): { startsAt: Date; endsAt: Date }[] {
  const local = new Date(firstStartsAt.getTime() + BEIJING_OFFSET_MS);
  if (!input.weekdays.includes(local.getUTCDay() || 7)) invalid('weekdays', '首期日期须包含在重复日期中');
  const periods: { startsAt: Date; endsAt: Date }[] = [];
  for (let day = new Date(local); ; day = new Date(day.getTime() + 86400000)) {
    const date = day.toISOString().slice(0, 10);
    if (input.end.kind === 'DATE' && date > input.end.date) break;
    if (!input.weekdays.includes(day.getUTCDay() || 7)) continue;
    const startsAt = new Date(day.getTime() - BEIJING_OFFSET_MS),
      endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60000);
    if (!Number.isFinite(endsAt.getTime()) || endsAt.getUTCFullYear() > 9999)
      invalid('durationMinutes', '每期结束时间超出有效范围');
    periods.push({ startsAt, endsAt });
    if (periods.length > 10) invalid('seriesEnd', '结束条件生成的总期数须为2至10期');
    if (input.end.kind === 'COUNT' && periods.length === input.end.count) break;
  }
  if (periods.length < 2) invalid('seriesEnd', '结束条件生成的总期数须为2至10期');
  return periods;
}
