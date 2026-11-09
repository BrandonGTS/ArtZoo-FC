/** Fixed-team CD resets at Tuesday 16:00 Beijing time (UTC+08:00). */
export const TEAM_CYCLE_TIME_ZONE = 'Asia/Shanghai';

export interface TeamCycleWindow {
  startsAt: Date;
  endsAt: Date;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// 1970-01-06 was a Tuesday. UTC arithmetic avoids the host time zone and locale.
const RESET_ANCHOR_MS = Date.UTC(1970, 0, 6, 8);

function validDateTime(value: Date, name: string): number {
  if (!(value instanceof Date)) throw new TypeError(`${name} must be a Date`);
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp)) throw new RangeError(`${name} must be a valid Date`);
  return timestamp;
}

/** Return the complete [Tuesday 16:00, next Tuesday 16:00) CD window. */
export function teamCycleWindow(now: Date, shift = 0): TeamCycleWindow {
  const nowMs = validDateTime(now, 'now');
  if (!Number.isSafeInteger(shift)) throw new RangeError('shift must be a safe integer');

  const cycle = Math.floor((nowMs - RESET_ANCHOR_MS) / WEEK_MS);
  const startsAt = new Date(RESET_ANCHOR_MS + (cycle + shift) * WEEK_MS);
  const endsAt = new Date(startsAt.getTime() + WEEK_MS);
  validDateTime(startsAt, 'cycle startsAt');
  validDateTime(endsAt, 'cycle endsAt');
  return { startsAt, endsAt };
}

/** Assign a session by its start instant; the session end is not clipped. */
export function teamSessionInCycle(startsAt: Date, window: TeamCycleWindow): boolean {
  const sessionMs = validDateTime(startsAt, 'startsAt');
  const windowStartMs = validDateTime(window.startsAt, 'window.startsAt');
  const windowEndMs = validDateTime(window.endsAt, 'window.endsAt');
  if (windowStartMs >= windowEndMs) throw new RangeError('cycle window must have a positive duration');
  return sessionMs >= windowStartMs && sessionMs < windowEndMs;
}
