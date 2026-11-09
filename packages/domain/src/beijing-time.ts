/** Fixed UTC+08 civil-time conversion, independent of the host TZ and historical IANA DST. */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
export type BeijingInstant = Date | number | string;
export type BeijingPickerPrecision = 'minute' | 'second' | 'millisecond';

/** month is 1–12; seconds/milliseconds default to zero only when omitted. */
export interface BeijingCivilTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second?: number;
  readonly millisecond?: number;
}
/** weekday follows Date.getUTCDay(): Sunday=0, Saturday=6. */
export interface BeijingParts extends Required<BeijingCivilTime> {
  readonly weekday: number;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number') throw new TypeError(`${field} must be a number`);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} is outside the supported integer range`);
  }
  return value;
}
function civilMilliseconds(parts: BeijingCivilTime): number {
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) {
    throw new TypeError('civil time must be an object');
  }
  const year = integer(parts.year, 'year', 0, 9999);
  const month = integer(parts.month, 'month', 1, 12);
  const day = integer(parts.day, 'day', 1, 31);
  const hour = integer(parts.hour, 'hour', 0, 23);
  const minute = integer(parts.minute, 'minute', 0, 59);
  const second = integer(parts.second === undefined ? 0 : parts.second, 'second', 0, 59);
  const millisecond = integer(parts.millisecond === undefined ? 0 : parts.millisecond, 'millisecond', 0, 999);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]!) throw new RangeError('day does not exist in the selected month');
  // Date.UTC(year, ...) coerces years 0–99 to 1900–1999; setUTCFullYear does not.
  const surrogate = new Date(0);
  surrogate.setUTCFullYear(year, month - 1, day);
  surrogate.setUTCHours(hour, minute, second, millisecond);
  return surrogate.getTime();
}
function capturedCivil(match: RegExpMatchArray): BeijingCivilTime {
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
    millisecond: Number((match[7] ?? '').padEnd(3, '0'))
  };
}
function instantMilliseconds(value: BeijingInstant): number {
  if (value instanceof Date) {
    const timestamp = Date.prototype.getTime.call(value);
    if (!Number.isFinite(timestamp)) throw new RangeError('instant must be a valid Date');
    return timestamp;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) {
      throw new RangeError('instant must be an integer epoch millisecond within the Date range');
    }
    return value;
  }
  if (typeof value !== 'string')
    throw new TypeError('instant must be a Date, integer epoch millisecond or explicit-offset ISO string');
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!match) throw new RangeError('instant string must contain an explicit ISO offset');
  const zone = match[8]!;
  let offset = 0;
  if (zone !== 'Z') {
    const hours = integer(Number(zone.slice(1, 3)), 'offset hour', 0, 23);
    const minutes = integer(Number(zone.slice(4, 6)), 'offset minute', 0, 59);
    offset = (hours * 60 + minutes) * 60 * 1000 * (zone[0] === '-' ? -1 : 1);
  }
  return civilMilliseconds(capturedCivil(match)) - offset;
}

/** Accept an instant, never a host-local/date-only string. Returns a fresh parts object. */
export function toBeijingParts(value: BeijingInstant): BeijingParts {
  const surrogate = new Date(instantMilliseconds(value) + BEIJING_OFFSET_MS);
  const year = surrogate.getUTCFullYear();
  integer(year, 'Beijing year', 0, 9999);
  return {
    year,
    month: surrogate.getUTCMonth() + 1,
    day: surrogate.getUTCDate(),
    hour: surrogate.getUTCHours(),
    minute: surrogate.getUTCMinutes(),
    second: surrogate.getUTCSeconds(),
    millisecond: surrogate.getUTCMilliseconds(),
    weekday: surrogate.getUTCDay()
  };
}

/** Inverse of parts; does not infer weekdays, normalize overflow or mutate an input Date. */
export function fromBeijingParts(parts: BeijingCivilTime): Date {
  return new Date(civilMilliseconds(parts) - BEIJING_OFFSET_MS);
}

/** Parse a datetime-local wall-clock value as fixed +08, with optional seconds and 1–3 fraction digits. */
export function fromBeijingPicker(value: string): Date {
  if (typeof value !== 'string') throw new TypeError('picker must be a string');
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!match) throw new RangeError('picker must be an offset-free datetime-local string');
  return fromBeijingParts(capturedCivil(match));
}
const two = (value: number) => String(value).padStart(2, '0');
/** Minute/second output explicitly truncates omitted subunits, never rounds or mutates the instant. */
export function toBeijingPicker(value: BeijingInstant, precision: BeijingPickerPrecision = 'minute'): string {
  if (!['minute', 'second', 'millisecond'].includes(precision))
    throw new RangeError('unsupported picker precision');
  const parts = toBeijingParts(value);
  const date = `${String(parts.year).padStart(4, '0')}-${two(parts.month)}-${two(parts.day)}`;
  const minute = `${date}T${two(parts.hour)}:${two(parts.minute)}`;
  if (precision === 'minute') return minute;
  const second = `${minute}:${two(parts.second)}`;
  return precision === 'second' ? second : `${second}.${String(parts.millisecond).padStart(3, '0')}`;
}
/** Stable calendar keys, not localized display labels or business eligibility windows. */
export const beijingDateKey = (value: BeijingInstant): string => toBeijingPicker(value).slice(0, 10);
export const beijingMonthKey = (value: BeijingInstant): string => toBeijingPicker(value).slice(0, 7);
