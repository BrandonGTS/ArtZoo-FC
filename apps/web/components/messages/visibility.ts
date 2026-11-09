/** Observe only a mounted card in the current document. No batch read or offscreen fallback. */
export function observeMessageVisibility(card: HTMLElement, onSeen: () => Promise<void>) {
  let active = true,
    visible = false,
    sent = false;
  const read = () => {
    if (!active || sent || !visible || document.visibilityState !== 'visible') return;
    sent = true;
    void onSeen().catch(() => {
      sent = false;
    });
  };
  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      visible = !!entry?.isIntersecting && entry.intersectionRatio > 0;
      read();
    },
    { threshold: [0, 0.01] }
  );
  const reveal = () => {
    const rect = card.getBoundingClientRect();
    visible =
      rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    read();
  };
  observer.observe(card);
  document.addEventListener('visibilitychange', reveal);
  return () => {
    active = false;
    observer.disconnect();
    document.removeEventListener('visibilitychange', reveal);
  };
}
