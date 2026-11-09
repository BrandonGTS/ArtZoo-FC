import { Node, Extension, type JSONContent } from '@tiptap/react';
import { Plugin } from '@tiptap/pm/state';
import { history, undo, redo } from '@tiptap/pm/history';
import { stickerParts, stickerToken, stickers } from './sticker-codec';

/** Shared allowlisted inline image atom for text and rich-text composers. */
export const StickerNode = Node.create({
  name: 'sticker',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => ({ id: { default: null } }),
  // Pasted/dropped HTML cannot create a sticker. Only our allowlisted command can.
  parseHTML: () => [],
  renderHTML({ node }) {
    const sticker = stickers.find((item) => item.id === node.attrs.id);
    return sticker
      ? [
          'img',
          {
            src: sticker.url,
            alt: '[' + sticker.label + ']',
            title: sticker.label,
            width: sticker.width,
            height: sticker.height,
            class: 'inline-sticker-image',
            contenteditable: 'false',
            draggable: 'false'
          }
        ]
      : ['span', {}, '[表情]'];
  }
});

/** This is a text document with one allowed inline atom, never arbitrary rich HTML. */
export function inlineDocument(value: string): JSONContent {
  return {
    type: 'doc',
    content: value
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => ({
        type: 'paragraph',
        content: stickerParts(line).map((part) =>
          typeof part === 'string'
            ? { type: 'text', text: part }
            : { type: 'sticker', attrs: { id: part.id } }
        )
      }))
  };
}
/** Paste is inline even across newlines, so surrounding caret text stays on its original lines. */
export function inlinePaste(value: string): JSONContent[] {
  const paragraphs = inlineDocument(value).content ?? [],
    nodes: JSONContent[] = [];
  for (const [index, paragraph] of paragraphs.entries()) {
    if (index) nodes.push({ type: 'hardBreak' });
    nodes.push(...(paragraph.content ?? []));
  }
  return nodes;
}
export function inlineText(document: JSONContent): string {
  function text(node: JSONContent): string {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'sticker') return stickerToken(String(node.attrs?.id ?? '')) ?? '';
    return (node.content ?? []).map(text).join('');
  }
  return (document.content ?? []).map(text).join('\n');
}
export function withinInlineLimit(next: string, previous: string, limit: number) {
  return next.length <= limit || next.length < previous.length;
}
/** A delayed parent echo is not a new owner/reset command during native IME composition. */
export function queueInlineExternal(
  value: string,
  lastEmitted: string,
  pending: string | null
): string | null {
  return value !== lastEmitted || pending !== null ? value : null;
}
export function inlineCompositionResult(
  current: string,
  previous: string,
  external: string | null,
  limit: number
) {
  if (external !== null) return { value: external, kind: 'external' as const };
  if (!withinInlineLimit(current, previous, limit)) return { value: previous, kind: 'restore' as const };
  return { value: current, kind: 'accept' as const };
}
export function inlineExtensions(options: { limit(): number; composing(): boolean; rejected(): void }) {
  return [
    Node.create({ name: 'doc', topNode: true, content: 'paragraph+' }),
    Node.create({
      name: 'paragraph',
      group: 'block',
      content: 'inline*',
      parseHTML: () => [{ tag: 'p' }],
      renderHTML: () => ['p', 0]
    }),
    Node.create({ name: 'text', group: 'inline' }),
    Node.create({
      name: 'hardBreak',
      group: 'inline',
      inline: true,
      selectable: false,
      parseHTML: () => [{ tag: 'br' }],
      renderHTML: () => ['br']
    }),
    StickerNode,
    Extension.create({
      name: 'inlineTextBehavior',
      addKeyboardShortcuts() {
        return {
          'Mod-z': () => undo(this.editor.state, this.editor.view.dispatch),
          'Shift-Mod-z': () => redo(this.editor.state, this.editor.view.dispatch),
          'Mod-y': () => redo(this.editor.state, this.editor.view.dispatch),
          'Shift-Enter': () => this.editor.commands.insertContent({ type: 'hardBreak' })
        };
      },
      addProseMirrorPlugins() {
        return [
          history(),
          new Plugin({
            filterTransaction(transaction, state) {
              if (!transaction.docChanged || options.composing()) return true;
              if (
                withinInlineLimit(
                  inlineText(transaction.doc.toJSON()),
                  inlineText(state.doc.toJSON()),
                  options.limit()
                )
              )
                return true;
              options.rejected();
              return false;
            }
          })
        ];
      }
    })
  ];
}
