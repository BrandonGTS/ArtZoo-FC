'use client';
import { useEffect } from 'react';

/** Portal/generated controls obey the same policy; values and business suggestions stay intact. */
export function BrowserInputPolicy() {
  useEffect(() => {
    const credentials = new Set(['username', 'current-password', 'new-password']);
    function applyField(field: HTMLInputElement | HTMLTextAreaElement) {
      if (
        field instanceof HTMLInputElement &&
        [
          'password',
          'hidden',
          'file',
          'checkbox',
          'radio',
          'submit',
          'button',
          'reset',
          'image',
          'range',
          'color'
        ].includes(field.type)
      )
        return;
      if (credentials.has(field.getAttribute('autocomplete') ?? '')) return;
      if (field.getAttribute('autocomplete') !== 'off') field.setAttribute('autocomplete', 'off');
    }
    function apply(root: ParentNode) {
      if (root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement) applyField(root);
      for (const field of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'))
        applyField(field);
    }
    apply(document);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          const field = record.target;
          if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) applyField(field);
        } else {
          for (const node of record.addedNodes) {
            if (node instanceof Element) apply(node);
          }
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['autocomplete', 'type']
    });
    return () => observer.disconnect();
  }, []);
  return null;
}
