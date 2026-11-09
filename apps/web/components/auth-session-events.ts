const eventId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const AUTH_EVENT_KEY = 'artzoo-auth-change';
export function readAuthEvent(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const value = window.localStorage.getItem(AUTH_EVENT_KEY);
    return value && eventId.test(value) ? value : null;
  } catch {
    return null;
  }
}
/** Opaque event IDs only. No account/session data is persisted or sent across tabs. */
export function createAuthEventCursor(initial: string | null, changed: () => void) {
  let seen = initial;
  return {
    receive(value: unknown) {
      if (typeof value !== 'string' || !eventId.test(value) || value === seen) return false;
      seen = value;
      changed();
      return true;
    },
    remember(value: string) {
      if (eventId.test(value)) seen = value;
    }
  };
}
