import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateKnowledgeBody,
  safeKnowledgeLink,
  documentText,
  readKnowledgeDocument,
  documentImages
} from '../../apps/web/content/knowledge-document.ts';
const rich = (content) => ({ type: 'doc', content });
const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
for (const href of [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,<script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  '//evil.test/a',
  ' https://example.test',
  'https://u:p@example.test',
  'java\nscript:alert(1)',
  'https://exam\u202eple.test'
])
  test('dangerous link rejected ' + JSON.stringify(href), () => assert.throws(() => safeKnowledgeLink(href)));
test('only http and https canonical links survive', () => {
  assert.equal(
    safeKnowledgeLink('https://example.test/a?q=中文'),
    'https://example.test/a?q=%E4%B8%AD%E6%96%87'
  );
  assert.equal(safeKnowledgeLink('http://example.test'), 'http://example.test/');
});
test('legacy plain text remains byte-identical', () => {
  const body = ' <script>alert(1)</script>\n\n  旧文  ';
  assert.deepEqual(validateKnowledgeBody(body), { body, bodyFormat: 'PLAIN', images: [] });
});
test('rich schema retains confirmed structure and strips event/style attributes', () => {
  const doc = rich([
    { type: 'heading', attrs: { level: 2, onclick: 'alert(1)' }, content: [{ type: 'text', text: '标题' }] },
    {
      type: 'paragraph',
      attrs: { style: 'display:none' },
      content: [
        {
          type: 'text',
          text: '粗斜链接',
          marks: [
            { type: 'bold', attrs: { x: 'y' } },
            { type: 'italic' },
            { type: 'link', attrs: { href: 'https://example.test', onclick: 'x' } }
          ]
        }
      ]
    },
    { type: 'bulletList', content: [{ type: 'listItem', content: [p('无序')] }] },
    { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [p('有序')] }] },
    { type: 'blockquote', content: [p('引用')] },
    {
      type: 'codeBlock',
      attrs: { language: 'javascript' },
      content: [{ type: 'text', text: '<script>alert(1)</script>\n代码' }]
    }
  ]);
  const out = validateKnowledgeBody(JSON.stringify(doc), 'RICH_V1');
  assert.ok(!out.body.includes('onclick'));
  assert.ok(!out.body.includes('display:none'));
  assert.ok(!out.body.includes('language'));
  const parsed = readKnowledgeDocument(out.body, out.bodyFormat);
  assert.match(documentText(parsed), /标题/);
  assert.equal(validateKnowledgeBody(out.body, 'RICH_V1').body, out.body);
});
for (const type of ['script', 'iframe', 'table', 'video', 'style', 'svg', 'math', 'unknown'])
  test('unsupported node rejected ' + type, () =>
    assert.throws(() => validateKnowledgeBody(JSON.stringify(rich([{ type }])), 'RICH_V1'))
  );
for (const src of [
  'https://external.test/a.png',
  'data:image/png;base64,AAA',
  '/api/avatars/other',
  '/api/knowledge-images/../../etc?variant=preview',
  '/api/knowledge-images/123?variant=preview'
])
  test('untrusted image src rejected ' + src, () =>
    assert.throws(() =>
      validateKnowledgeBody(JSON.stringify(rich([{ type: 'image', attrs: { src } }])), 'RICH_V1')
    )
  );
test('images identified only by exact internal media route', () => {
  const id = '10000000-0000-4000-8000-000000000001',
    doc = rich([
      {
        type: 'image',
        attrs: { src: '/api/knowledge-images/' + id + '?variant=preview', onerror: 'alert(1)', alt: '说明' }
      }
    ]);
  const out = validateKnowledgeBody(JSON.stringify(doc), 'RICH_V1');
  assert.deepEqual(out.images, [id]);
  assert.deepEqual(documentImages(readKnowledgeDocument(out.body, out.bodyFormat)), [id]);
  assert.ok(!out.body.includes('onerror'));
});
test('deep and malformed documents rejected without recursion overflow', () => {
  let n = p('x');
  for (let i = 0; i < 30; i++) n = { type: 'blockquote', content: [n] };
  assert.throws(() => validateKnowledgeBody(JSON.stringify(rich([n])), 'RICH_V1'));
  assert.throws(() => validateKnowledgeBody('{}', 'RICH_V1'));
  assert.throws(() => validateKnowledgeBody(JSON.stringify(rich([p('')])), 'RICH_V1'));
});
