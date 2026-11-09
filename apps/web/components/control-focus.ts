// Document-level listeners also receive events from AntD portals under body.
const attribute = 'data-artzoo-control-focus';
const shells = '.ant-input-affix-wrapper, .ant-input-number, .ant-picker, .ant-select, .ant-mentions';
const fields =
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]), textarea, select';

export function installControlFocus(doc: Document): () => void {
  // A picker can remain visually active while focus moves into its portal.
  // Keep shadow suppression independent from the currently focused shell.
  doc.documentElement.setAttribute('data-artzoo-control-focus-ready', '');
  let modality: 'keyboard' | 'pointer' = 'keyboard';
  let marked: Element | null = null;
  const element = (target: EventTarget | null): Element | null =>
    target && 'nodeType' in target && target.nodeType === 1 ? (target as Element) : null;
  const control = (target: EventTarget | null) => {
    const node = element(target);
    return node?.closest(shells) ?? (node?.matches(fields) ? node : null);
  };
  const paint = (target: EventTarget | null) => {
    const next = control(target);
    if (marked !== next) marked?.removeAttribute(attribute);
    marked = next;
    marked?.setAttribute(attribute, modality);
  };
  const pointer = () => {
    modality = 'pointer';
    paint(doc.activeElement);
  };
  const key = (event: KeyboardEvent) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    // Typing/copying in a clicked field is still pointer-origin focus. Tab and
    // composite-widget navigation explicitly request a keyboard focus cue.
    const composite = element(event.target)?.closest(
      '.ant-select, .ant-picker, .ant-select-dropdown, .ant-cascader-dropdown, .ant-picker-dropdown'
    );
    if (
      event.key === 'Tab' ||
      (composite &&
        [
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'Home',
          'End',
          'PageUp',
          'PageDown',
          'Enter',
          ' '
        ].includes(event.key))
    ) {
      modality = 'keyboard';
      paint(doc.activeElement);
    }
  };
  const focus = (event: FocusEvent) => paint(event.target);
  const blur = () => {
    marked?.removeAttribute(attribute);
    marked = null;
  };
  doc.addEventListener('pointerdown', pointer, true);
  doc.addEventListener('keydown', key, true);
  doc.addEventListener('focusin', focus, true);
  doc.addEventListener('focusout', blur, true);
  paint(doc.activeElement);
  return () => {
    doc.removeEventListener('pointerdown', pointer, true);
    doc.removeEventListener('keydown', key, true);
    doc.removeEventListener('focusin', focus, true);
    doc.removeEventListener('focusout', blur, true);
    blur();
    doc.documentElement.removeAttribute('data-artzoo-control-focus-ready');
  };
}
