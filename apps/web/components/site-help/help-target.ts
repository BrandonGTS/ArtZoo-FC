/** Presentation only: never click, read form values, or request application data. */
export function visibleHelpTarget(
  selector: string,
  root: Document | HTMLElement = document
): HTMLElement | null {
  try {
    for (const item of root.querySelectorAll<HTMLElement>(selector)) {
      if (!item.isConnected || item.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
      let hidden = false;
      for (let ancestor: HTMLElement | null = item; ancestor; ancestor = ancestor.parentElement) {
        const style = (
          root.nodeType === 9 ? (root as Document) : root.ownerDocument
        )?.defaultView?.getComputedStyle(ancestor);
        if (
          style?.display === 'none' ||
          style?.visibility === 'hidden' ||
          style?.visibility === 'collapse' ||
          style?.opacity === '0'
        ) {
          hidden = true;
          break;
        }
      }
      const rect = item.getBoundingClientRect();
      if (hidden || rect.width <= 0 || rect.height <= 0) continue;
      return item;
    }
  } catch {
    /* Unavailable targets remain uncompleted; the tour offers retry or exit. */
  }
  return null;
}
