import { Extension, Mark, Node, mergeAttributes, type Editor } from '@tiptap/react';
import {
  tableEditing,
  addColumnAfter,
  addColumnBefore,
  deleteColumn,
  addRowAfter,
  addRowBefore,
  deleteRow,
  deleteTable,
  mergeCells,
  splitCell,
  setCellAttr,
  goToNextCell
} from '@tiptap/pm/tables';
import { TextSelection, type Command } from '@tiptap/pm/state';
import { knowledgePresentation, safeKnowledgeColor } from '../../content/knowledge-document';

export const TextStyle = Mark.create({
  name: 'textStyle',
  addAttributes() {
    return {
      fontSize: {
        default: null,
        parseHTML: (e) =>
          ['12px', '14px', '16px', '18px', '24px', '36px'].includes(e.style.fontSize)
            ? e.style.fontSize
            : null
      },
      color: { default: null, parseHTML: () => null },
      backgroundColor: { default: null, parseHTML: () => null }
    };
  },
  parseHTML() {
    return [{ tag: 'span[style]' }];
  },
  renderHTML({ HTMLAttributes: a }) {
    return [
      'span',
      {
        style: [
          a.fontSize ? 'font-size:' + a.fontSize : '',
          a.color ? 'color:' + safeKnowledgeColor(a.color) : '',
          a.backgroundColor ? 'background-color:' + safeKnowledgeColor(a.backgroundColor) : ''
        ]
          .filter(Boolean)
          .join(';')
      },
      0
    ];
  }
});
export const Presentation = Extension.create({
  name: 'knowledgePresentation',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (e) =>
              ['left', 'center', 'right', 'justify'].includes(e.style.textAlign) ? e.style.textAlign : null,
            renderHTML: (a) =>
              a.textAlign
                ? { style: 'text-align:' + knowledgePresentation({ textAlign: a.textAlign }).textAlign }
                : {}
          },
          lineHeight: {
            default: null,
            parseHTML: () => null,
            renderHTML: (a) =>
              a.lineHeight
                ? { style: 'line-height:' + knowledgePresentation({ lineHeight: a.lineHeight }).lineHeight }
                : {}
          },
          indent: {
            default: 0,
            parseHTML: () => 0,
            renderHTML: (a) =>
              a.indent
                ? {
                    style:
                      'margin-left:' + Number(knowledgePresentation({ indent: a.indent }).indent) * 2 + 'em'
                  }
                : {}
          }
        }
      }
    ];
  }
});
export const LinkTitle = Extension.create({
  name: 'knowledgeLinkTitle',
  addGlobalAttributes() {
    return [
      {
        types: ['link'],
        attributes: {
          title: { default: null, parseHTML: (e) => (e.getAttribute('title') ?? '').slice(0, 500) }
        }
      }
    ];
  }
});
export const TableNode = Node.create({
  name: 'table',
  group: 'block',
  content: 'tableRow+',
  isolating: true,
  addOptions() {
    return { tableRole: 'table' };
  },
  extendNodeSchema(extension) {
    return {
      tableRole:
        extension.name === 'table'
          ? 'table'
          : extension.name === 'tableRow'
            ? 'row'
            : extension.name === 'tableCell'
              ? 'cell'
              : extension.name === 'tableHeader'
                ? 'header_cell'
                : undefined
    };
  },
  addAttributes() {
    return { width: { default: 100, parseHTML: () => 100 } };
  },
  parseHTML() {
    return [{ tag: 'table' }];
  },
  renderHTML({ HTMLAttributes: a }) {
    return ['table', { style: 'width:' + Number(a.width) + '%' }, ['tbody', 0]];
  },
  addProseMirrorPlugins() {
    return [tableEditing()];
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => runTable(this.editor, goToNextCell(1)),
      'Shift-Tab': () => runTable(this.editor, goToNextCell(-1))
    };
  }
});
export const TableRow = Node.create({
  name: 'tableRow',
  content: '(tableCell|tableHeader)*',
  addAttributes() {
    return { height: { default: null, parseHTML: () => null } };
  },
  parseHTML() {
    return [{ tag: 'tr' }];
  },
  renderHTML({ HTMLAttributes: a }) {
    return ['tr', a.height ? { style: 'height:' + Number(a.height) + 'px' } : {}, 0];
  }
});
const cellAttributes = () => ({
  colspan: { default: 1, parseHTML: (e: HTMLElement) => Number(e.getAttribute('colspan') ?? 1) },
  rowspan: { default: 1, parseHTML: (e: HTMLElement) => Number(e.getAttribute('rowspan') ?? 1) },
  colwidth: { default: null, parseHTML: () => null },
  backgroundColor: { default: null, parseHTML: () => null },
  textAlign: { default: null, parseHTML: () => null }
});
function cellHTML(tag: string, a: Record<string, unknown>) {
  return [
    tag,
    mergeAttributes(
      { colspan: a.colspan, rowspan: a.rowspan },
      {
        style: [
          a.backgroundColor ? 'background-color:' + safeKnowledgeColor(a.backgroundColor) : '',
          a.textAlign ? 'text-align:' + knowledgePresentation({ textAlign: a.textAlign }).textAlign : '',
          Array.isArray(a.colwidth) ? 'width:' + Number(a.colwidth[0]) + 'px' : ''
        ]
          .filter(Boolean)
          .join(';')
      }
    ),
    0
  ] as const;
}
export const TableCell = Node.create({
  name: 'tableCell',
  content: 'block+',
  isolating: true,
  addAttributes: cellAttributes,
  parseHTML() {
    return [{ tag: 'td' }];
  },
  renderHTML({ HTMLAttributes: a }) {
    return cellHTML('td', a);
  }
});
export const TableHeader = Node.create({
  name: 'tableHeader',
  content: 'block+',
  isolating: true,
  addAttributes: cellAttributes,
  parseHTML() {
    return [{ tag: 'th' }];
  },
  renderHTML({ HTMLAttributes: a }) {
    return cellHTML('th', a);
  }
});
export const Details = Node.create({
  name: 'details',
  group: 'block',
  content: 'detailsSummary detailsContent',
  defining: true,
  isolating: true,
  parseHTML() {
    return [{ tag: 'details' }];
  },
  renderHTML() {
    return ['details', { open: true }, 0];
  }
});
export const DetailsSummary = Node.create({
  name: 'detailsSummary',
  content: 'inline*',
  defining: true,
  parseHTML() {
    return [{ tag: 'summary' }];
  },
  renderHTML() {
    return ['summary', {}, 0];
  }
});
export const DetailsContent = Node.create({
  name: 'detailsContent',
  content: 'block+',
  defining: true,
  parseHTML() {
    return [{ tag: 'div[data-knowledge-details]' }];
  },
  renderHTML() {
    return ['div', { 'data-knowledge-details': '' }, 0];
  }
});
export function insertKnowledgeTable(editor: Editor, rows: number, columns: number) {
  return editor
    .chain()
    .focus()
    .insertContent({
      type: 'table',
      content: Array.from({ length: rows }, () => ({
        type: 'tableRow',
        content: Array.from({ length: columns }, () => ({
          type: 'tableCell',
          content: [{ type: 'paragraph' }]
        }))
      }))
    })
    .run();
}
export const tableActions = {
  addColumnBefore,
  addColumnAfter,
  deleteColumn,
  addRowBefore,
  addRowAfter,
  deleteRow,
  deleteTable,
  mergeCells,
  splitCell
};
export function runTable(editor: Editor, command: Command) {
  editor.commands.focus();
  return command(editor.state, editor.view.dispatch, editor.view);
}
export function setKnowledgeCell(editor: Editor, key: string, value: unknown) {
  return runTable(editor, setCellAttr(key, value));
}
export function setBlockPresentation(editor: Editor, attrs: Record<string, unknown>) {
  return editor
    .chain()
    .focus()
    .command(({ tr, state, dispatch }) => {
      const safe = knowledgePresentation(attrs);
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (['paragraph', 'heading'].includes(node.type.name) && dispatch)
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...safe });
      });
      return true;
    })
    .run();
}
export function unwrapDetails(editor: Editor) {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--)
    if ($from.node(depth).type.name === 'details') {
      const wrapper = $from.node(depth),
        start = $from.before(depth),
        content = wrapper.child(1).content;
      const tr = editor.state.tr.replaceWith(start, start + wrapper.nodeSize, content);
      tr.setSelection(TextSelection.near(tr.doc.resolve(start)));
      editor.view.dispatch(tr);
      return true;
    }
  return false;
}
