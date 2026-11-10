import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  validateKnowledgeBody,
  readKnowledgeDocument,
  documentImages,
  documentText
} from '../../apps/web/content/knowledge-document.ts';
import { KnowledgeService } from '../../apps/web/server/knowledge/service.ts';
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
  DetailsContent
} from '../../apps/web/components/knowledge/rich-extensions.ts';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { getSchema } = require('@tiptap/react'),
  StarterKit = require('@tiptap/starter-kit').default;
const { EditorState } = require('@tiptap/pm/state'),
  { CellSelection, mergeCells, splitCell, TableMap } = require('@tiptap/pm/tables');
const p = (text = '正文') => ({ type: 'paragraph', content: [{ type: 'text', text }] }),
  doc = (content) => ({ type: 'doc', content }),
  body = (content) => JSON.stringify(doc(content));
const cell = (text, attrs = {}) => ({ type: 'tableCell', attrs, content: [p(text)] }),
  row = (content) => ({ type: 'tableRow', content });
const validate = (value) => validateKnowledgeBody(JSON.stringify(value), 'RICH_V1');
test('all requested inline and block styles round trip through server whitelist', () => {
  const node = p('字号和颜色');
  node.attrs = { textAlign: 'justify', lineHeight: 1.3, indent: 3, style: 'position:fixed' };
  node.content[0].marks = [
    { type: 'bold' },
    { type: 'italic' },
    { type: 'underline' },
    { type: 'strike' },
    {
      type: 'textStyle',
      attrs: { fontSize: '24px', color: '#A34335', backgroundColor: '#FFF2CC', style: 'bad' }
    },
    { type: 'link', attrs: { href: 'https://example.test/path', title: '链接标题', target: '_self' } }
  ];
  const out = validate(doc([node]));
  assert.ok(!out.body.includes('position'));
  assert.ok(!out.body.includes('"style"'));
  assert.match(out.body, /#a34335/);
  assert.equal(validateKnowledgeBody(out.body, 'RICH_V1').body, out.body);
  const parsed = readKnowledgeDocument(out.body, 'RICH_V1');
  assert.equal(parsed.content[0].attrs.indent, 3);
  assert.equal(parsed.content[0].content[0].marks.find((m) => m.type === 'link').attrs.target, '_self');
});
for (const attrs of [
  { color: 'red' },
  { color: 'url(https://evil.test/x)' },
  { backgroundColor: '#fff;display:none' },
  { fontSize: '999px' }
])
  test('unsafe text style rejected ' + JSON.stringify(attrs), () =>
    assert.throws(() =>
      validate(
        doc([
          { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'textStyle', attrs }] }] }
        ])
      )
    )
  );
for (const attrs of [{ indent: 9 }, { textAlign: 'expression(alert(1))' }, { lineHeight: 20 }])
  test('unsafe paragraph style rejected ' + JSON.stringify(attrs), () => {
    const n = p();
    n.attrs = attrs;
    assert.throws(() => validate(doc([n])));
  });
test('table merged cells and details keep internal image references and readable text', () => {
  const id = '10000000-0000-4000-8000-000000000001',
    image = { type: 'image', attrs: { src: '/api/knowledge-images/' + id + '?variant=preview' } };
  const table = {
    type: 'table',
    attrs: { width: 80 },
    content: [
      row([
        cell('合并', { rowspan: 2, colspan: 1, colwidth: [120], backgroundColor: '#d9ead3' }),
        cell('右上')
      ]),
      row([cell('右下')])
    ]
  };
  const details = {
    type: 'details',
    content: [
      { type: 'detailsSummary', content: [{ type: 'text', text: '展开图片' }] },
      { type: 'detailsContent', content: [p('折叠内容'), image] }
    ]
  };
  const out = validate(doc([table, details])),
    parsed = readKnowledgeDocument(out.body, 'RICH_V1');
  assert.deepEqual(documentImages(parsed), [id]);
  assert.match(documentText(parsed), /右下/);
  assert.match(documentText(parsed), /折叠内容/);
  assert.equal(validateKnowledgeBody(out.body, 'RICH_V1').body, out.body);
});
test('malformed tables, CSS and arbitrary embeds are rejected', () => {
  for (const value of [
    { type: 'table', content: [row([cell('x', { rowspan: 3 })])] },
    { type: 'table', content: [row([cell('x')]), row([cell('x'), cell('y')])] },
    { type: 'table', content: [row([cell('x', { backgroundColor: 'url(x)' })])] },
    { type: 'details', content: [p('bad')] },
    { type: 'iframe', attrs: { src: 'https://evil.test' } }
  ])
    assert.throws(() => validate(doc([value])));
});
test('installed Tiptap schema supports real PM table merging and whitelist roundtrip', () => {
  const schema = getSchema([
    StarterKit,
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
  ]);
  assert.equal(schema.nodes.table.spec.tableRole, 'table');
  assert.equal(schema.nodes.tableCell.spec.tableRole, 'cell');
  const value = schema.nodeFromJSON(
    doc([{ type: 'table', content: [row([cell('a'), cell('b')]), row([cell('c'), cell('d')])] }, p('after')])
  );
  value.check();
  let state = EditorState.create({ schema, doc: value });
  const map = TableMap.get(value.firstChild),
    offset = 1;
  state = state.apply(
    state.tr.setSelection(
      new CellSelection(state.doc.resolve(offset + map.map[0]), state.doc.resolve(offset + map.map[3]))
    )
  );
  assert.equal(
    mergeCells(state, (tr) => {
      state = state.apply(tr);
    }),
    true
  );
  state.doc.check();
  validate(state.doc.toJSON());
  assert.equal(
    splitCell(state, (tr) => {
      state = state.apply(tr);
    }),
    true
  );
  state.doc.check();
  validate(state.doc.toJSON());
});
const owner = '41000000-0000-4000-8000-000000000001',
  other = '41000000-0000-4000-8000-000000000002',
  articleId = '31000000-0000-4000-8000-000000000001',
  categoryId = '51000000-0000-4000-8000-000000000001';
function fixture(actorId = other, role = 'NONE') {
  const article = {
    id: articleId,
    authorId: owner,
    author: {
      id: owner,
      displayName: '合成作者',
      membership: 'MEMBER',
      createdAt: new Date(),
      profile: null
    },
    categoryId,
    category: { id: categoryId, label: '旧分类', active: false, revision: 0 },
    title: '旧文',
    body: '旧文 <script>',
    bodyFormat: 'PLAIN',
    jobs: ['未识别旧职业'],
    playstyles: ['旧玩法'],
    gameVersions: ['旧版本'],
    editMode: 'COMMUNITY',
    contributions: [{ accountId: other }],
    revision: 0,
    removedAt: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const actor = {
      id: '61000000-0000-4000-8000-000000000001',
      accountId: actorId,
      expiresAt: new Date('2099-01-01'),
      account: { phone: 'fixture-only', adminRole: role }
    },
    writes = [],
    versions = [];
  const tx = {
    $queryRaw: async () => [],
    knowledgeArticle: {
      findUnique: async () => article,
      update: async ({ data }) => {
        writes.push(data);
        Object.assign(article, data);
        return article;
      }
    },
    knowledgeCategory: { findUnique: async () => article.category },
    knowledgeVersion: {
      aggregate: async () => ({ _max: { number: 1 } }),
      create: async ({ data }) => {
        versions.push(data);
      }
    },
    knowledgeContribution: { upsert: async () => {} },
    knowledgeArticleRead: { count: async () => 0 },
    knowledgeArticleInteraction: { count: async () => 0, findUnique: async () => null },
    knowledgeComment: { findMany: async () => [] }
  };
  const auth = {
    now: () => new Date('2026-10-23'),
    requireAccount: async () => actor,
    transaction: async (fn) => fn(tx),
    db: { $transaction: async (fn) => fn(tx) }
  };
  return { service: new KnowledgeService(auth), article, writes, versions };
}
for (const role of ['NONE', 'ADMIN', 'SUPER_ADMIN'])
  test('COMMUNITY rejects ordinary edit by nonauthor ' + role, async () => {
    const f = fixture(other, role);
    assert.equal((await f.service.detail(articleId)).canEdit, false);
    await assert.rejects(() => f.service.edit(articleId, { body: 'new', expectedRevision: 0 }), {
      code: 'FORBIDDEN'
    });
    assert.equal(f.writes.length, 0);
    assert.equal(f.versions.length, 0);
  });
test('author metadata-only edit preserves unknown old tags, permissions, body bytes and contribution history', async () => {
  const f = fixture(owner);
  await f.service.edit(articleId, {
    title: '新标题',
    categoryId,
    body: f.article.body,
    bodyFormat: 'PLAIN',
    expectedRevision: 0
  });
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].jobs, ['未识别旧职业']);
  assert.deepEqual(f.writes[0].playstyles, ['旧玩法']);
  assert.deepEqual(f.writes[0].gameVersions, ['旧版本']);
  assert.equal(f.writes[0].editMode, 'COMMUNITY');
  assert.equal(f.writes[0].body, '旧文 <script>');
  assert.equal(f.versions.length, 0);
  assert.deepEqual(f.article.contributions, [{ accountId: other }]);
});
test('manual category service rejects administrator without any write', async () => {
  const f = fixture(owner, 'ADMIN');
  await assert.rejects(() => f.service.saveCategory({ label: '新分类', active: true }), {
    code: 'FORBIDDEN'
  });
  assert.equal(f.writes.length, 0);
});
