'use client';
type CheckinUpdate = { owner: string; month: string };
const eventName = 'artzoo:checkin-updated';
const channelName = 'artzoo-checkin';
function valid(value: unknown): value is CheckinUpdate {
  if (!value || typeof value !== 'object') return false;
  const update = value as Partial<CheckinUpdate>;
  return typeof update.owner === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(update.month ?? '');
}
export function checkinChanged(owner: string, month: string) {
  const update = { owner, month };
  window.dispatchEvent(new CustomEvent(eventName, { detail: update }));
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new BroadcastChannel(channelName);
      channel.postMessage(update);
      channel.close();
    } catch {
      /* Same-tab update already delivered. */
    }
  }
}
export function subscribeCheckinChanges(owner: string, refresh: (month: string) => void) {
  const receive = (update: unknown) => {
    if (valid(update) && update.owner === owner) refresh(update.month);
  };
  const listener = (event: Event) => receive((event as CustomEvent<unknown>).detail);
  window.addEventListener(eventName, listener);
  let channel: BroadcastChannel | null = null;
  try {
    channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(channelName) : null;
  } catch {
    /* Focus refresh remains available. */
  }
  if (channel) channel.onmessage = (event) => receive(event.data);
  return () => {
    window.removeEventListener(eventName, listener);
    channel?.close();
  };
}
