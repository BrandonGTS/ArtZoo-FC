'use client';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { EditorState, Selection } from '@tiptap/pm/state';
import { theme } from 'antd';
import {
  inlineDocument,
  inlineExtensions,
  inlineText,
  inlineCompositionResult,
  inlinePaste,
  queueInlineExternal
} from './inline-document';
import { stickerToken } from './sticker-codec';
import './inline-sticker-input.css';

export interface InlineStickerInputRef {
  focus(): void;
  insertSticker(id: string): boolean;
  read(): string | null;
}
type Props = {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  maxLength: number;
  id?: string;
  placeholder?: string;
  autoFocus?: boolean;
  minRows?: number;
  maxRows?: number;
  showCount?: boolean;
  'aria-label'?: string;
  'aria-required'?: 'true' | 'false';
  'aria-describedby'?: string;
};
const InlineStickerInput = forwardRef<InlineStickerInputRef, Props>(function InlineStickerInput(
  {
    value,
    onChange,
    disabled = false,
    maxLength,
    id,
    placeholder = '',
    autoFocus = false,
    minRows = 3,
    maxRows = 10,
    showCount = false,
    ...aria
  },
  ref
) {
  const { token } = theme.useToken();
  const live = useRef({ value, onChange, disabled, maxLength });
  live.current = { value, onChange, disabled, maxLength };
  const composing = useRef(false),
    compositionStart = useRef<EditorState | null>(null),
    selection = useRef<Selection | null>(null);
  const pendingExternal = useRef<string | null>(null);
  const lastEmitted = useRef(value),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    extensions: inlineExtensions({
      limit: () => live.current.maxLength,
      composing: () => composing.current,
      rejected: () => queueMicrotask(() => setLimitHit(true))
    }),
    content: inlineDocument(value),
    editable: !disabled,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': aria['aria-label'] ?? '留言正文',
        ...(id ? { id } : {}),
        ...(aria['aria-required'] ? { 'aria-required': aria['aria-required'] } : {}),
        ...(aria['aria-describedby'] ? { 'aria-describedby': aria['aria-describedby'] } : {}),
        'data-placeholder': placeholder,
        class: 'inline-sticker-editable'
      },
      handlePaste(view, event) {
        if (live.current.disabled) return true;
        const text = event.clipboardData?.getData('text/plain') ?? '';
        // Reading text/plain deliberately ignores formatting, image URLs and HTML event handlers.
        if (text) editor?.commands.insertContent(inlinePaste(text));
        return true;
      },
      clipboardTextSerializer(slice) {
        return slice.content.textBetween(0, slice.content.size, '\n', (node) =>
          node.type.name === 'hardBreak'
            ? '\n'
            : node.type.name === 'sticker'
              ? (stickerToken(String(node.attrs.id)) ?? '')
              : ''
        );
      },
      handleDrop() {
        return true;
      },
      handleDOMEvents: {
        compositionstart(view) {
          composing.current = true;
          compositionStart.current = view.state;
          setLimitHit(false);
          return false;
        },
        compositionend() {
          if (timer.current) clearTimeout(timer.current);
          // ProseMirror first commits its native IME transaction. Never replace DOM mid-composition.
          timer.current = setTimeout(finishComposition, 0);
          return false;
        }
      }
    },
    onUpdate({ editor: current }) {
      if (composing.current) return;
      const text = inlineText(current.getJSON());
      lastEmitted.current = text;
      setLimitHit(false);
      live.current.onChange(text);
    },
    onSelectionUpdate({ editor: current }) {
      selection.current = current.state.selection;
    },
    onBlur({ editor: current }) {
      selection.current = current.state.selection;
    },
    onCreate({ editor: current }) {
      if (autoFocus) current.commands.focus('end', { scrollIntoView: false });
    }
  });
  function finishComposition() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    composing.current = false;
    if (!editor || editor.isDestroyed) return;
    const text = inlineText(editor.getJSON()),
      before = compositionStart.current;
    const external =
      pendingExternal.current !== null || live.current.value !== lastEmitted.current
        ? live.current.value
        : null;
    const result = inlineCompositionResult(
      text,
      before ? inlineText(before.doc.toJSON()) : lastEmitted.current,
      external,
      live.current.maxLength
    );
    if (result.kind === 'external') {
      editor.commands.setContent(inlineDocument(result.value), { emitUpdate: false });
      selection.current = editor.state.selection;
      setLimitHit(false);
    } else if (result.kind === 'restore' && before) {
      editor.view.updateState(before);
      selection.current = before.selection;
      setLimitHit(true);
    } else setLimitHit(false);
    lastEmitted.current = result.value;
    if (result.kind !== 'external') live.current.onChange(result.value);
    pendingExternal.current = null;
    compositionStart.current = null;
  }
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
    editor.view.dom.setAttribute('aria-disabled', String(disabled));
  }, [disabled, editor]);
  useEffect(() => {
    if (!editor) return;
    if (composing.current) {
      pendingExternal.current = queueInlineExternal(value, lastEmitted.current, pendingExternal.current);
      return;
    }
    if (value === lastEmitted.current || value === inlineText(editor.getJSON())) return;
    editor.commands.setContent(inlineDocument(value), { emitUpdate: false });
    lastEmitted.current = value;
    selection.current = editor.state.selection;
    setLimitHit(false);
  }, [value, editor]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  useImperativeHandle(ref, () => ({
    focus() {
      if (!editor || live.current.disabled) return;
      if (selection.current && selection.current.$from.doc === editor.state.doc)
        editor.view.dispatch(editor.state.tr.setSelection(selection.current));
      editor.commands.focus(undefined, { scrollIntoView: false });
    },
    read() {
      if (!editor) return live.current.value;
      // A click after compositionend may precede the queued finalizer. Flush before serializing a command.
      if (composing.current) {
        if (timer.current) finishComposition();
        else return null;
      }
      return inlineText(editor.getJSON());
    },
    insertSticker(stickerId) {
      if (!editor || live.current.disabled || composing.current || !stickerToken(stickerId)) return false;
      const range =
        selection.current && selection.current.$from.doc === editor.state.doc
          ? selection.current
          : editor.state.selection;
      const transaction = editor.state.tr
        .setSelection(range)
        .replaceSelectionWith(editor.schema.nodes.sticker!.create({ id: stickerId }));
      if (inlineText(transaction.doc.toJSON()).length > live.current.maxLength) {
        setLimitHit(true);
        return false;
      }
      editor.view.dispatch(transaction);
      selection.current = editor.state.selection;
      return true;
    }
  }));
  const style = {
    '--inline-border': token.colorBorder,
    '--inline-hover': token.colorPrimaryHover,
    '--inline-active': token.colorPrimary,
    '--inline-bg': token.colorBgContainer,
    '--inline-disabled-bg': token.colorBgContainerDisabled,
    '--inline-color': token.colorText,
    '--inline-placeholder': token.colorTextPlaceholder,
    '--inline-radius': token.borderRadius + 'px',
    '--inline-font-size': token.fontSize + 'px',
    '--inline-min-height': minRows * 24 + 8 + 'px',
    '--inline-max-height': maxRows * 24 + 8 + 'px'
  } as CSSProperties;
  return (
    <div
      className={'inline-sticker-input' + (disabled ? ' inline-sticker-input-disabled' : '')}
      style={style}
    >
      <EditorContent editor={editor} />
      {showCount ? (
        <span className="inline-sticker-count" aria-live="off">
          {value.length} / {maxLength}
        </span>
      ) : null}
      {limitHit ? (
        <span className="inline-sticker-limit" role="status">
          已达到字数限制，请删减后再输入。
        </span>
      ) : null}
    </div>
  );
});
export default InlineStickerInput;
