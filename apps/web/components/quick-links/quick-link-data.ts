'use client';
import { useEffect, useState } from 'react';
export function quickLinksChanged() {
  window.dispatchEvent(new Event('artzoo:quick-links-updated'));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('artzoo-quick-links');
    channel.postMessage('updated');
    channel.close();
  }
}
export function useQuickLinkRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener('artzoo:quick-links-updated', refresh);
    const channel =
      typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('artzoo-quick-links') : null;
    if (channel)
      channel.onmessage = (event) => {
        if (event.data === 'updated') refresh();
      };
    return () => {
      window.removeEventListener('artzoo:quick-links-updated', refresh);
      channel?.close();
    };
  }, []);
  return revision;
}
