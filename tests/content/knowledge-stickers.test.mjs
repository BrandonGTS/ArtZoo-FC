import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { stickers } from '../../apps/web/components/stickers/sticker-codec.ts';
import {
  StickerNode,
  inlineDocument,
  inlineText,
  inlineExtensions
} from '../../apps/web/components/stickers/inline-document.ts';
import {
  validateKnowledgeBody,
  readKnowledgeDocument,
  documentImages,
  documentText
} from '../../apps/web/content/knowledge-document.ts';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { getSchema } = require('@tiptap/react');
const StarterKit = require('@tiptap/starter-kit').default;
const { EditorState, TextSelection } = require('@tiptap/pm/state');
const { history, undo, redo } = require('@tiptap/pm/history');
const schema = getSchema([StarterKit, StickerNode]);
const doc = (content) => ({ type: 'doc', content: [{ type: 'paragraph', content }] });
const sticker = (id) => ({ type: 'sticker', attrs: { id } });
const validate = (value) => validateKnowledgeBody(JSON.stringify(value), 'RICH_V1');

test('all 29 shared stickers survive editor/server/edit round trips without becoming uploaded media', () => {
  assert.equal(stickers.length, 29);
  const input = doc([
    { type: 'text', text: '前😀' },
    ...stickers.map((s) => sticker(s.id)),
    { type: 'text', text: '后' }
  ]);
  const first = validate(schema.nodeFromJSON(input).toJSON());
  assert.deepEqual(first.images, []);
  const restored = readKnowledgeDocument(first.body, 'RICH_V1');
  assert.deepEqual(documentImages(restored), []);
  assert.equal(validate(schema.nodeFromJSON(restored).toJSON()).body, first.body);
  assert.equal(documentText(restored), '前😀' + stickers.map((s) => '[' + s.label + ']').join('') + '后');
});
test('sticker-only content is valid and does not create media ownership references', () => {
  const out = validate(doc([sticker('01')]));
  assert.deepEqual(out.images, []);
  assert.match(documentText(readKnowledgeDocument(out.body, 'RICH_V1')), /\[.+\]/);
});
test('unknown IDs, arbitrary sources and invalid sticker placement remain rejected', () => {
  for (const id of ['00', '30', '', '1', 1, null, '../../x', 'https://evil.test/x'])
    assert.throws(() => validate(doc([sticker(id)])));
  for (const parent of ['doc', 'codeBlock', 'tableRow'])
    assert.throws(() => validate({ type: 'doc', content: [{ type: parent, content: [sticker('01')] }] }));
  assert.throws(() => validate({ type: 'doc', content: [sticker('01')] }));
  assert.throws(() =>
    validate({ type: 'doc', content: [{ type: 'image', attrs: { src: stickers[0].url } }] })
  );
});
test('untrusted sticker attributes never persist or control URLs, styling or captions', () => {
  const value = sticker('01');
  value.attrs.src = 'https://evil.test/x';
  value.attrs.style = 'position:fixed';
  value.attrs.alt = '<script>';
  value.marks = [{ type: 'link', attrs: { href: 'javascript:evil()' } }];
  assert.deepEqual(JSON.parse(validate(doc([value])).body), doc([sticker('01')]));
});
test('shared sticker atom remains allowlisted and does not import pasted HTML', () => {
  assert.deepEqual(StickerNode.config.parseHTML(), []);
  for (const item of stickers) {
    const rendered = StickerNode.config.renderHTML({
      node: { attrs: { id: item.id, src: 'https://evil.test' } }
    });
    assert.equal(rendered[1].src, item.url);
    assert.equal(rendered[1].draggable, 'false');
  }
  assert.equal(StickerNode.config.renderHTML({ node: { attrs: { id: 'invalid' } } })[0], 'span');
});
test('existing text sticker composer keeps the same atom and text encoding', () => {
  const legacySchema = getSchema(
    inlineExtensions({ limit: () => 2000, composing: () => false, rejected() {} })
  );
  const text = '旧😀' + stickers.map((s) => '[rs1:' + s.id + ']').join('');
  assert.equal(inlineText(legacySchema.nodeFromJSON(inlineDocument(text)).toJSON()), text);
});
test('insertion replaces selected text at the original caret and undo/redo preserve rich document', () => {
  let state = EditorState.create({
    schema,
    doc: schema.nodeFromJSON(doc([{ type: 'text', text: '前选后' }])),
    plugins: [history()]
  });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2, 3)));
  state = state.apply(state.tr.replaceSelectionWith(schema.nodes.sticker.create({ id: '01' })));
  assert.equal(documentText(state.doc.toJSON()), '前[' + stickers[0].label + ']后');
  const dispatch = (tr) => {
    state = state.apply(tr);
  };
  assert.equal(undo(state, dispatch), true);
  assert.equal(documentText(state.doc.toJSON()), '前选后');
  assert.equal(redo(state, dispatch), true);
  assert.equal(documentText(state.doc.toJSON()), '前[' + stickers[0].label + ']后');
});
test('historical plain text and Unicode-rich articles remain unchanged', () => {
  const old = '历史😀[rs1:01]';
  assert.equal(validateKnowledgeBody(old, 'PLAIN').body, old);
  const rich = doc([{ type: 'text', text: old, marks: [{ type: 'bold' }] }]);
  assert.deepEqual(JSON.parse(validate(rich).body), rich);
});
