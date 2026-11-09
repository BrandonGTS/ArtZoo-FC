'use client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { EditorContent, useEditor, useEditorState, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import ImageExtension from '@tiptap/extension-image';
import { Button, ColorPicker, Input, Modal, Popover, Select, Tooltip, theme } from 'antd';
import {
  knowledgeImageId,
  knowledgePreviewDimensions,
  readKnowledgeDocument,
  safeKnowledgeLink,
  KNOWLEDGE_FONT_SIZES,
  KNOWLEDGE_LINE_HEIGHTS,
  type BodyFormat
} from '../../content/knowledge-document';
import {
  TextStyle,
  Presentation,
  LinkTitle,
  TableNode,
  TableRow,
  TableCell,
  TableHeader,
  Details,
  DetailsSummary,
  DetailsContent,
  insertKnowledgeTable,
  tableActions,
  runTable,
  setKnowledgeCell,
  setBlockPresentation,
  unwrapDetails
} from './rich-extensions';
import StickerPicker from '../stickers/sticker-picker';
import { StickerNode } from '../stickers/inline-document';
import { stickerToken } from '../stickers/sticker-codec';
import './rich-editor.css';
const ImageNode = ImageExtension.extend({
  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (element) => {
          try {
            knowledgeImageId((element as HTMLElement).getAttribute('src'));
            return {};
          } catch {
            return false;
          }
        }
      }
    ];
  }
}).configure({ allowBase64: false });
const palette = [
  '#000000',
  '#434343',
  '#666666',
  '#999999',
  '#b7b7b7',
  '#ffffff',
  '#980000',
  '#ff0000',
  '#ff9900',
  '#ffff00',
  '#00ff00',
  '#00ffff',
  '#4a86e8',
  '#0000ff',
  '#9900ff',
  '#ff00ff',
  '#e6b8af',
  '#fce5cd',
  '#fff2cc',
  '#d9ead3',
  '#cfe2f3',
  '#d9d2e9'
];

// Inline SVG keeps the existing editor dependency and document allowlists unchanged.
const toolbarPaths: Record<string, string> = {
  撤销: 'M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12',
  重做: 'm15 5 5 5-5 5M20 10H10a6 6 0 0 0 0 12',
  粗体: 'M7 4h6a4 4 0 0 1 0 8H7zm0 8h7a4 4 0 0 1 0 8H7z',
  斜体: 'M10 4h9M5 20h9M15 4 9 20',
  下划线: 'M6 4v7a6 6 0 0 0 12 0V4M4 21h16',
  删除线: 'M17 5c-1-1-3-2-5-2-3 0-5 2-5 4 0 3 3 4 5 4M4 12h16M7 19c1 1 3 2 5 2 3 0 5-2 5-4 0-2-2-3-4-4',
  清除格式: 'm4 5 10 0m-5 0-4 14m7-2 5-6 5 4-5 6h-5l-3-3M15 21h7',
  左对齐: 'M4 5h16M4 10h10M4 15h16M4 20h10',
  居中: 'M4 5h16M7 10h10M4 15h16M7 20h10',
  右对齐: 'M4 5h16M10 10h10M4 15h16M10 20h10',
  两端对齐: 'M4 5h16M4 10h16M4 15h16M4 20h16',
  减少缩进: 'M10 5h10M10 10h10M10 15h10M4 20h16M6 9l-3 3 3 3',
  增加缩进: 'M10 5h10M10 10h10M10 15h10M4 20h16M3 9l3 3-3 3',
  格式刷: 'M4 3h16v6H4zM16 9v4H9v8H6v-8h10',
  应用格式: 'M4 3h16v6H4zM16 9v4H9v8H6v-8h10',
  链接: 'm10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
  移除链接: 'm9 15 6-6M6 17l-1 1a4 4 0 0 1-4-6l3-3m7-3 1-1a4 4 0 0 1 6 6l-2 2M3 3l18 18',
  引用: 'M5 6h5v7H5c0 3 1 4 3 5M14 6h5v7h-5c0 3 1 4 3 5',
  日期时间: 'M4 5h16v16H4zM8 3v4M16 3v4M4 10h16M12 13v4h3',
  本站图片: 'M3 4h18v16H3zM3 17l6-6 5 5 3-3 4 4M16 8h.01',
  表情: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M8 9h.01M16 9h.01M8 14c2 4 6 4 8 0',
  无序列表: 'M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01',
  有序列表: 'M9 5h12M9 12h12M9 19h12M3 3h1v5M3 12c0-2 3-2 3 0 0 1-3 3-3 3h3M3 18h2l-1 2c3-1 3 3-1 2',
  插入表格: 'M3 4h18v16H3zM3 10h18M3 15h18M9 4v16M15 4v16',
  表格属性: 'M3 4h18v16H3zM3 10h18M9 4v16M15 4v6M15 15h6M18 12v6',
  插入折叠: 'M3 4h18v16H3zM3 10h18m5-3 2 2 2-2M7 14h10M7 17h7',
  删除折叠: 'M3 4h18v16H3zM3 10h18m5-3 2 2 2-2M9 13l6 5M15 13l-6 5',
  恢复草稿: 'M5 8V3m0 5h5M5 8a8 8 0 1 1-1 8M12 7v6l4 2',
  全屏: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
  退出全屏: 'M3 8h5V3M16 3v5h5M8 21v-5H3M21 16h-5v5',
  字色: 'm6 18 6-14 6 14M8 14h8M4 22h16',
  背景色: 'm6 16 8-12 6 4-8 12H6l-3 2M10 10l6 4M3 22h18'
};
function ToolbarIcon({ label }: { label: string }) {
  return (
    <svg
      className="knowledge-toolbar-icon"
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={toolbarPaths[label]} />
    </svg>
  );
}

function uploadImage(
  file: File,
  batchId: string,
  batchIndex: number
): Promise<{ url: string; width: number; height: number }> {
  const form = new FormData();
  form.set('file', file);
  form.set('batchId', batchId);
  form.set('batchIndex', String(batchIndex));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/knowledge-images');
    xhr.setRequestHeader('X-ArtZoo-Request', '1');
    xhr.timeout = 120000;
    xhr.onload = () => {
      try {
        const result = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && result.ok) resolve(result.data);
        else reject(Error(result.error?.message ?? '图片上传失败'));
      } catch {
        reject(Error('图片上传结果无法确认，请检查后再试'));
      }
    };
    xhr.onerror = () => reject(Error('图片上传连接中断，请检查后再试'));
    xhr.ontimeout = () => reject(Error('图片上传超时，请检查后再试'));
    xhr.send(form);
  });
}
export default function KnowledgeRichEditor({
  body,
  bodyFormat,
  disabled,
  onChange,
  onBusy,
  onError,
  onRestoreDraft,
  draftAvailable = false
}: {
  body: string;
  bodyFormat: BodyFormat;
  disabled: boolean;
  onChange(value: string): void;
  onBusy(value: boolean): void;
  onError(message: string): void;
  onRestoreDraft?(): void;
  draftAvailable?: boolean;
}) {
  const { token } = theme.useToken();
  const editorTheme = {
    '--knowledge-input-bg': disabled ? token.colorBgContainerDisabled : token.colorBgContainer,
    '--knowledge-input-border': token.colorBorder,
    '--knowledge-input-hover-border': token.colorPrimaryHover,
    '--knowledge-input-active-border': token.colorPrimary,
    '--knowledge-input-radius': token.borderRadius + 'px',
    '--knowledge-input-text': token.colorText,
    '--knowledge-input-split': token.colorSplit,
    '--knowledge-input-active-bg': token.colorFillSecondary
  } as CSSProperties;
  const fileInput = useRef<HTMLInputElement>(null),
    uploading = useRef(false),
    live = useRef(false),
    [uploadBusy, setUploadBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false),
    [link, setLink] = useState(''),
    [linkText, setLinkText] = useState(''),
    [linkTitle, setLinkTitle] = useState(''),
    [linkTarget, setLinkTarget] = useState('_blank'),
    [linkError, setLinkError] = useState<string | null>(null);
  const [full, setFull] = useState(false),
    [tableOpen, setTableOpen] = useState(false),
    [grid, setGrid] = useState([1, 1]),
    [brush, setBrush] = useState<{ marks: JSONContent[]; presentation: Record<string, unknown> } | null>(
      null
    ),
    [cellColor, setCellColor] = useState('#ffffff'),
    [cellWidth, setCellWidth] = useState('120'),
    [rowHeight, setRowHeight] = useState('36'),
    [tableWidth, setTableWidth] = useState('100');
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (!full) return;
    const escape = (e: KeyboardEvent) => {
      // A foreground dialog owns Escape; closing the picker must not also exit fullscreen.
      if (e.key === 'Escape' && !(e.target instanceof Element && e.target.closest('[role="dialog"]')))
        setFull(false);
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [full]);
  const initial = body
    ? readKnowledgeDocument(body, bodyFormat)
    : { type: 'doc', content: [{ type: 'paragraph' }] };
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        horizontalRule: false,
        code: false,
        link: { openOnClick: false, autolink: false, linkOnPaste: false, protocols: ['http', 'https'] }
      }),
      ImageNode,
      StickerNode,
      TextStyle,
      Presentation,
      LinkTitle,
      TableNode,
      TableRow,
      TableCell,
      TableHeader,
      Details,
      DetailsSummary,
      DetailsContent
    ],
    content: initial,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': '正文',
        'aria-multiline': 'true',
        class: 'knowledge-rich-input'
      },
      handlePaste: (_view, event) => {
        if (event.clipboardData?.files.length) {
          event.preventDefault();
          void files([...event.clipboardData.files]);
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        if (event.dataTransfer?.files.length) {
          event.preventDefault();
          void files([...event.dataTransfer.files]);
          return true;
        }
        return false;
      }
    },
    onUpdate: ({ editor, transaction }) => {
      if (transaction.docChanged) onChange(JSON.stringify(editor.getJSON()));
    }
  });
  const state = useEditorState({
    editor,
    selector: (ctx) =>
      ctx.editor
        ? {
            bold: ctx.editor.isActive('bold'),
            italic: ctx.editor.isActive('italic'),
            underline: ctx.editor.isActive('underline'),
            strike: ctx.editor.isActive('strike'),
            bullet: ctx.editor.isActive('bulletList'),
            ordered: ctx.editor.isActive('orderedList'),
            quote: ctx.editor.isActive('blockquote'),
            link: ctx.editor.isActive('link'),
            table: ctx.editor.isActive('table'),
            details: ctx.editor.isActive('details'),
            style: ctx.editor.getAttributes('textStyle'),
            paragraph: { ...ctx.editor.getAttributes('paragraph'), ...ctx.editor.getAttributes('heading') },
            undo: ctx.editor.can().undo(),
            redo: ctx.editor.can().redo()
          }
        : null
  });
  useEffect(() => {
    editor?.setEditable(!disabled && !uploadBusy, false);
  }, [editor, disabled, uploadBusy]);
  async function files(selected: File[]) {
    if (!selected.length || !live.current || !editor || disabled || uploading.current) return;
    if (selected.length > 10) {
      onError('每次选取最多10张图片');
      return;
    }
    if (selected.some((file) => !file.size || file.size > 30 * 1024 * 1024)) {
      onError('每张图片最多30MiB');
      return;
    }
    uploading.current = true;
    setUploadBusy(true);
    onBusy(true);
    const batchId = crypto.randomUUID();
    try {
      for (let i = 0; i < selected.length; i++) {
        if (!live.current) return;
        const file = selected[i]!,
          result = await uploadImage(file, batchId, i);
        if (!live.current) return;
        knowledgeImageId(result.url);
        editor
          .chain()
          .insertContentAt(editor.state.selection.to, {
            type: 'image',
            attrs: { src: result.url, alt: file.name, title: '', ...knowledgePreviewDimensions(result) }
          })
          .run();
        onChange(JSON.stringify(editor.getJSON()));
      }
    } catch (e) {
      if (live.current) onError(e instanceof Error ? e.message : '图片上传失败');
    } finally {
      uploading.current = false;
      if (live.current) {
        setUploadBusy(false);
        onBusy(false);
      }
    }
  }
  const locked = disabled || uploadBusy || !editor;
  function applyLink() {
    if (!editor) return;
    try {
      const href = safeKnowledgeLink(link),
        text = linkText.trim();
      if (!text) throw Error('请填写显示文本');
      if (linkTitle.length > 500) throw Error('标题最多500字');
      editor
        .chain()
        .focus()
        .extendMarkRange('link')
        .insertContent({
          type: 'text',
          text,
          marks: [{ type: 'link', attrs: { href, title: linkTitle, target: linkTarget } }]
        })
        .run();
      setLinkOpen(false);
      setLinkError(null);
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : '链接无效');
    }
  }
  function iconButton(label: string, extraDisabled = false) {
    return (
      <Tooltip title={label} trigger={['hover', 'focus']}>
        <Button
          type="text"
          className="knowledge-toolbar-button"
          disabled={locked || extraDisabled}
          title={label}
          aria-label={label}
          icon={<ToolbarIcon label={label} />}
        />
      </Tooltip>
    );
  }
  function colorPicker(key: 'color' | 'backgroundColor', label: string) {
    return (
      <Popover
        trigger="click"
        content={
          <div className="knowledge-color-picker">
            <div className="knowledge-color-grid">
              {palette.map((color) => (
                <Button
                  key={color}
                  type="text"
                  aria-label={label + color}
                  style={{ backgroundColor: color }}
                  onClick={() =>
                    editor
                      ?.chain()
                      .focus()
                      .setMark('textStyle', { [key]: color })
                      .run()
                  }
                />
              ))}
            </div>
            <Button
              type="text"
              onClick={() =>
                editor
                  ?.chain()
                  .focus()
                  .setMark('textStyle', { [key]: null })
                  .run()
              }
            >
              移除{label}
            </Button>
            <ColorPicker
              disabledAlpha
              format="hex"
              disabled={locked}
              onChangeComplete={(color) =>
                editor
                  ?.chain()
                  .focus()
                  .setMark('textStyle', { [key]: color.toHexString() })
                  .run()
              }
            >
              <Button aria-label={'自定义' + label}>自定义{label}</Button>
            </ColorPicker>
          </div>
        }
      >
        {iconButton(label)}
      </Popover>
    );
  }
  function command(label: string, run: () => unknown, active = false, extraDisabled = false) {
    return (
      <Tooltip title={label} trigger={['hover', 'focus']}>
        <Button
          type="text"
          className="knowledge-toolbar-button"
          disabled={locked || extraDisabled}
          title={label}
          aria-label={label}
          aria-pressed={active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run()}
          icon={<ToolbarIcon label={label} />}
        />
      </Tooltip>
    );
  }
  function applyBrush() {
    if (!editor) return;
    if (!brush) {
      setBrush({
        marks: editor.state.selection.$from
          .marks()
          .map((m) => m.toJSON())
          .filter((m) => m.type !== 'link'),
        presentation: {
          textAlign: state?.paragraph.textAlign ?? 'left',
          lineHeight: state?.paragraph.lineHeight ?? 1.5,
          indent: state?.paragraph.indent ?? 0
        }
      });
      return;
    }
    editor
      .chain()
      .focus()
      .unsetAllMarks()
      .command(({ tr, dispatch }) => {
        if (dispatch)
          for (const mark of brush.marks) {
            const type = editor.schema.marks[mark.type!];
            if (type) {
              const m = type.create(mark.attrs);
              if (editor.state.selection.empty) tr.addStoredMark(m);
              else tr.addMark(editor.state.selection.from, editor.state.selection.to, m);
            }
          }
        return true;
      })
      .run();
    setBlockPresentation(editor, brush.presentation);
    setBrush(null);
  }
  function insertDetails() {
    editor
      ?.chain()
      .focus()
      .insertContent({
        type: 'details',
        content: [
          { type: 'detailsSummary', content: [{ type: 'text', text: '点击展开' }] },
          { type: 'detailsContent', content: [{ type: 'paragraph' }] }
        ]
      })
      .run();
  }
  const cellMenu = (
    <div className="knowledge-table-menu">
      {Object.entries(tableActions).map(([name, action], i) => (
        <Button
          key={name}
          type="text"
          disabled={locked || !state?.table}
          onClick={() => editor && runTable(editor, action)}
        >
          {
            [
              '前插列',
              '后插列',
              '删除列',
              '上插行',
              '下插行',
              '删除行',
              '删除表格',
              '合并单元格',
              '拆分单元格'
            ][i]
          }
        </Button>
      ))}
      <label>
        单元格宽度(px)
        <Input
          aria-label="单元格宽度"
          type="number"
          min={20}
          max={1600}
          value={cellWidth}
          onChange={(e) => setCellWidth(e.target.value)}
        />
      </label>
      <Button
        disabled={locked || !state?.table}
        onClick={() => {
          const n = Number(cellWidth);
          if (!Number.isInteger(n) || n < 20 || n > 1600) {
            onError('单元格宽度须为20–1600px');
            return;
          }
          if (editor) {
            const span = Number(
              editor.getAttributes(editor.isActive('tableHeader') ? 'tableHeader' : 'tableCell').colspan ?? 1
            );
            setKnowledgeCell(editor, 'colwidth', Array(span).fill(n));
          }
        }}
      >
        应用宽度
      </Button>
      <ColorPicker
        disabledAlpha
        format="hex"
        disabled={locked || !state?.table}
        value={cellColor}
        onChangeComplete={(color) => setCellColor(color.toHexString())}
      >
        <Button aria-label="单元格背景色">单元格背景色</Button>
      </ColorPicker>
      <Button
        disabled={locked || !state?.table}
        onClick={() => editor && setKnowledgeCell(editor, 'backgroundColor', cellColor)}
      >
        应用背景
      </Button>
      <Button
        disabled={locked || !state?.table}
        onClick={() => editor && setKnowledgeCell(editor, 'backgroundColor', null)}
      >
        移除背景
      </Button>
      <Select
        aria-label="单元格对齐"
        disabled={locked || !state?.table}
        placeholder="单元格对齐"
        options={['left', 'center', 'right', 'justify'].map((value, i) => ({
          value,
          label: ['左对齐', '居中', '右对齐', '两端对齐'][i]
        }))}
        onChange={(value) => editor && setKnowledgeCell(editor, 'textAlign', value)}
      />
      <label>
        行高(px)
        <Input
          aria-label="表格行高"
          type="number"
          min={20}
          max={600}
          value={rowHeight}
          onChange={(e) => setRowHeight(e.target.value)}
        />
      </label>
      <Button
        disabled={locked || !state?.table}
        onClick={() => {
          const n = Number(rowHeight);
          if (Number.isInteger(n) && n >= 20 && n <= 600)
            editor?.chain().focus().updateAttributes('tableRow', { height: n }).run();
          else onError('行高须为20–600px');
        }}
      >
        应用行高
      </Button>
      <label>
        表格宽度(%)
        <Input
          aria-label="表格宽度"
          type="number"
          min={10}
          max={100}
          value={tableWidth}
          onChange={(e) => setTableWidth(e.target.value)}
        />
      </label>
      <Button
        disabled={locked || !state?.table}
        onClick={() => {
          const n = Number(tableWidth);
          if (Number.isInteger(n) && n >= 10 && n <= 100)
            editor?.chain().focus().updateAttributes('table', { width: n }).run();
          else onError('表格宽度须为10–100%');
        }}
      >
        应用表格宽度
      </Button>
    </div>
  );
  return (
    <div
      style={editorTheme}
      className={'knowledge-rich-editor knowledge-editor-v2' + (full ? ' knowledge-editor-fullscreen' : '')}
    >
      <div className="knowledge-rich-toolbar-v2" role="toolbar" aria-label="正文工具">
        <div className="knowledge-toolbar-row">
          {command('撤销', () => editor?.chain().focus().undo().run(), false, !state?.undo)}
          {command('重做', () => editor?.chain().focus().redo().run(), false, !state?.redo)}
          <Tooltip title="字号" trigger={['hover', 'focus']}>
            <Select
              aria-label="字号"
              size="small"
              className="knowledge-font-select"
              disabled={locked}
              value={Number(String(state?.style.fontSize ?? 14).replace('px', ''))}
              options={KNOWLEDGE_FONT_SIZES.map((value) => ({ value, label: String(value) }))}
              onChange={(n) =>
                editor
                  ?.chain()
                  .focus()
                  .setMark('textStyle', { fontSize: n + 'px' })
                  .run()
              }
            />
          </Tooltip>
          {colorPicker('color', '字色')}
          {colorPicker('backgroundColor', '背景色')}
          {command('粗体', () => editor?.chain().focus().toggleBold().run(), !!state?.bold)}
          {command('斜体', () => editor?.chain().focus().toggleItalic().run(), !!state?.italic)}
          {command('下划线', () => editor?.chain().focus().toggleUnderline().run(), !!state?.underline)}
          {command('删除线', () => editor?.chain().focus().toggleStrike().run(), !!state?.strike)}
          {command('清除格式', () => {
            editor?.chain().focus().unsetAllMarks().run();
            if (editor) setBlockPresentation(editor, { textAlign: 'left', lineHeight: 1.5, indent: 0 });
          })}
          <Tooltip title="行高" trigger={['hover', 'focus']}>
            <Select
              aria-label="行高"
              size="small"
              className="knowledge-line-select"
              disabled={locked}
              value={Number(state?.paragraph.lineHeight ?? 1.5)}
              options={KNOWLEDGE_LINE_HEIGHTS.map((value) => ({ value, label: String(value) }))}
              onChange={(value) => editor && setBlockPresentation(editor, { lineHeight: value })}
            />
          </Tooltip>
          {(['left', 'center', 'right', 'justify'] as const).map((value, i) => (
            <span key={value}>
              {command(
                ['左对齐', '居中', '右对齐', '两端对齐'][i]!,
                () => editor && setBlockPresentation(editor, { textAlign: value }),
                state?.paragraph.textAlign === value
              )}
            </span>
          ))}
          {command(
            '减少缩进',
            () =>
              editor &&
              setBlockPresentation(editor, { indent: Math.max(0, Number(state?.paragraph.indent ?? 0) - 1) })
          )}
          {command(
            '增加缩进',
            () =>
              editor &&
              setBlockPresentation(editor, { indent: Math.min(8, Number(state?.paragraph.indent ?? 0) + 1) })
          )}
        </div>
        <div className="knowledge-toolbar-row">
          {command(brush ? '应用格式' : '格式刷', applyBrush, !!brush)}
          {command(
            '链接',
            () => {
              if (!editor) return;
              if (editor.isActive('link')) editor.commands.extendMarkRange('link');
              const a = editor.getAttributes('link');
              setLink(a.href ?? '');
              setLinkText(
                editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ') ||
                  ''
              );
              setLinkTitle(a.title ?? '');
              setLinkTarget(a.target ?? '_blank');
              setLinkError(null);
              setLinkOpen(true);
            },
            !!state?.link
          )}
          {command('移除链接', () => editor?.chain().focus().unsetLink().run(), false, !state?.link)}
          {command('引用', () => editor?.chain().focus().toggleBlockquote().run(), !!state?.quote)}
          {command('日期时间', () =>
            editor
              ?.chain()
              .focus()
              .insertContent(
                new Intl.DateTimeFormat('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false
                }).format(new Date())
              )
              .run()
          )}
          <Tooltip title="本站图片" trigger={['hover', 'focus']}>
            <Button
              type="text"
              className="knowledge-toolbar-button"
              disabled={locked}
              title="本站图片"
              aria-label="本站图片"
              onClick={() => fileInput.current?.click()}
              icon={<ToolbarIcon label="本站图片" />}
            />
          </Tooltip>
          <StickerPicker
            compact
            className="knowledge-toolbar-button"
            disabled={locked}
            zIndex={full ? 1200 : undefined}
            onSelect={(id) =>
              !locked &&
              !!editor &&
              !!stickerToken(id) &&
              editor.chain().focus().insertContent({ type: 'sticker', attrs: { id } }).run()
            }
            onClosed={() => {
              if (!locked) editor?.commands.focus();
            }}
          />
          {command('无序列表', () => editor?.chain().focus().toggleBulletList().run(), !!state?.bullet)}
          {command('有序列表', () => editor?.chain().focus().toggleOrderedList().run(), !!state?.ordered)}
          <Popover
            trigger="click"
            open={tableOpen && !locked}
            onOpenChange={setTableOpen}
            content={
              <div>
                <p>
                  {grid[0]}行 × {grid[1]}列
                </p>
                <div className="knowledge-table-grid">
                  {Array.from({ length: 100 }, (_, i) => {
                    const row = Math.floor(i / 10) + 1,
                      col = (i % 10) + 1;
                    return (
                      <Button
                        key={i}
                        type="text"
                        aria-label={'插入' + row + '行' + col + '列表格'}
                        className={row <= grid[0]! && col <= grid[1]! ? 'knowledge-grid-selected' : ''}
                        onMouseEnter={() => setGrid([row, col])}
                        onFocus={() => setGrid([row, col])}
                        onClick={() => {
                          if (editor) insertKnowledgeTable(editor, row, col);
                          setTableOpen(false);
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            }
          >
            {iconButton('插入表格')}
          </Popover>
          <Popover trigger="click" content={cellMenu}>
            {iconButton('表格属性', !state?.table)}
          </Popover>
          {command('插入折叠', insertDetails)}
          {command('删除折叠', () => editor && unwrapDetails(editor), false, !state?.details)}
          {command('恢复草稿', () => onRestoreDraft?.(), false, !draftAvailable)}
          {command(full ? '退出全屏' : '全屏', () => setFull(!full), full)}
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept=".jpg,.jpeg,.png,.webp,.bmp,.gif,.tif,.tiff,.avif,.mpo"
        disabled={locked}
        onChange={(e) => {
          const selected = [...(e.target.files ?? [])];
          e.target.value = '';
          void files(selected);
        }}
      />
      {uploadBusy ? <p role="status">正在上传图片…</p> : null}
      <EditorContent editor={editor} />
      <Modal
        title="插入链接"
        open={linkOpen}
        onCancel={() => setLinkOpen(false)}
        onOk={applyLink}
        okText="确定"
        cancelText="取消"
      >
        <div className="knowledge-link-fields">
          <label>
            地址
            <Input
              autoComplete="off"
              aria-label="链接地址"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
          </label>
          <label>
            显示文本
            <Input aria-label="链接显示文本" value={linkText} onChange={(e) => setLinkText(e.target.value)} />
          </label>
          <label>
            标题
            <Input
              aria-label="链接标题"
              maxLength={500}
              value={linkTitle}
              onChange={(e) => setLinkTitle(e.target.value)}
            />
          </label>
          <label>
            打开位置
            <Select
              aria-label="链接打开位置"
              value={linkTarget}
              options={[
                { value: '_blank', label: '新窗口' },
                { value: '_self', label: '当前窗口' }
              ]}
              onChange={setLinkTarget}
            />
          </label>
          {linkError ? (
            <p className="knowledge-error" role="alert">
              {linkError}
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
