import test from 'node:test';
import assert from 'node:assert/strict';
import { memberSelect } from '../../apps/web/server/members/service.ts';
import { KnowledgeService } from '../../apps/web/server/knowledge/service.ts';
import {
  KNOWLEDGE_SECTIONS,
  browseCategoryOptions,
  publishCategoryOptions
} from '../../apps/web/components/knowledge/category-options.ts';

const category = (label, i, active = true) => ({
  id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  label,
  active,
  revision: 0
});
const sections = KNOWLEDGE_SECTIONS.map((label, i) => category(label, i + 1));
const image = (i) => `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const rich = JSON.stringify({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: '<script>plain text</script>' }] },
    ...[1, 2, 1, 3, 4].map((i) => ({
      type: 'image',
      attrs: { src: `/api/knowledge-images/${image(i)}?variant=preview` }
    }))
  ]
});
const row = (overrides = {}) => ({
  id: '30000000-0000-4000-8000-000000000001',
  title: '合成知识标题',
  body: rich,
  bodyFormat: 'RICH_V1',
  authorId: '40000000-0000-4000-8000-000000000001',
  author: {
    id: '40000000-0000-4000-8000-000000000001',
    displayName: '合成昵称',
    membership: 'MEMBER',
    createdAt: new Date('2026-10-20T02:00:00Z'),
    profile: null,
    gameRegion: '合成大区',
    gameServer: '合成服务器'
  },
  category: sections[0],
  categoryId: sections[0].id,
  jobs: [],
  playstyles: [],
  gameVersions: [],
  editMode: 'AUTHOR',
  contributions: [],
  revision: 0,
  removedAt: null,
  createdAt: new Date('2026-10-20T02:00:00Z'),
  updatedAt: new Date('2026-10-20T02:00:00Z'),
  ...overrides
});
function fixture(rows, authenticate = true) {
  const calls = [];
  const tx = {
    knowledgeArticle: {
      count: async (options) => {
        calls.push(['count', options]);
        return rows.length;
      },
      findMany: async (options) => {
        calls.push(['findMany', options]);
        return rows;
      },
      findUnique: async () => rows[0]
    },
    knowledgeImage: {
      findMany: async (options) => {
        calls.push(['imageFindMany', options]);
        return [1, 2, 3, 4]
          .map((i) => ({
            id: image(i),
            articleId: rows[0]?.id,
            commentId: null,
            width: 100 * i,
            height: 80 * i
          }))
          .filter(
            (item) =>
              item.articleId === options.where.articleId &&
              item.commentId === options.where.commentId &&
              options.where.id.in.includes(item.id)
          )
          .map(({ id, width, height }) => ({ id, width, height }));
      }
    },
    knowledgeArticleRead: { count: async () => 0 },
    knowledgeArticleInteraction: { count: async () => 0, findUnique: async () => null },
    knowledgeComment: { findMany: async () => [] },
    $queryRaw: async () => []
  };
  const auth = {
    now: () => new Date('2026-10-20T03:00:00Z'),
    requireAccount: async () => {
      if (!authenticate) throw Object.assign(new Error('请先登录'), { code: 'UNAUTHENTICATED' });
      return {
        accountId: rows[0]?.authorId,
        expiresAt: new Date('2026-10-21T03:00:00Z'),
        account: { adminRole: 'NONE' }
      };
    },
    db: { $transaction: async (action) => action(tx) }
  };
  return { service: new KnowledgeService(auth), calls };
}
test('new publication offers six active sections in the requested order', () => {
  const legacy = category('历史攻略', 20);
  const input = [legacy, ...sections.toReversed()];
  assert.deepEqual(
    publishCategoryOptions(input).map((item) => item.label),
    KNOWLEDGE_SECTIONS
  );
  assert.deepEqual(input[0], legacy);
  assert.deepEqual(
    browseCategoryOptions(input).map((item) => item.value),
    [...sections.map((item) => item.id), legacy.id]
  );
});
test('legacy and disabled current category survive edits without enabling disabled choices', () => {
  const old = category('旧分类', 20, false),
    inactive = { ...sections[0], active: false };
  const options = publishCategoryOptions([inactive, ...sections.slice(1)], old);
  assert.equal(options.length, 6);
  assert.ok(!options.some((option) => option.value === inactive.id));
  assert.deepEqual(options.at(-1), { value: old.id, label: old.label, disabled: false });
  assert.deepEqual(
    publishCategoryOptions(sections, sections[0]).map((item) => item.value),
    sections.map((item) => item.id)
  );
});
test('authenticated list projects server, plain excerpt and at most three private image routes', async () => {
  const { service, calls } = fixture([row()]);
  const result = await service.list(new URL('http://synthetic.test/api/knowledge'));
  const item = result.items[0];
  assert.equal(item.author.gameRegion, '合成大区');
  assert.equal(item.author.gameServer, '合成服务器');
  assert.equal(item.summary.trim(), '<script>plain text</script>');
  assert.deepEqual(
    item.thumbnailUrls,
    [1, 2, 3].map((i) => `/api/knowledge-images/${image(i)}?variant=thumbnail`)
  );
  assert.equal(calls.filter(([name]) => name === 'imageFindMany').length, 0);
  const detail = await service.detail(item.id);
  const imageCalls = calls.filter(([name]) => name === 'imageFindMany');
  assert.equal(imageCalls.length, 1);
  assert.deepEqual(imageCalls[0][1], {
    where: { articleId: item.id, commentId: null, id: { in: [1, 2, 3, 4].map(image) } },
    select: { id: true, width: true, height: true }
  });
  assert.deepEqual(
    detail.imageDimensions,
    Object.fromEntries([1, 2, 3, 4].map((i) => [image(i), { width: 100 * i, height: 80 * i }]))
  );
  assert.deepEqual(
    detail.thumbnailUrls,
    [1, 2, 3].map((i) => `/api/knowledge-images/${image(i)}?variant=preview`)
  );
  assert.equal(detail.body, rich);
  assert.equal('body' in item, false);
  assert.equal(calls.find(([name]) => name === 'findMany')[1].where.removedAt, null);
  assert.deepEqual(calls.find(([name]) => name === 'findMany')[1].include.author.select, memberSelect);
});
test('legacy plain content keeps literal markup as text and has no image sources', async () => {
  const { service } = fixture([row({ body: '<img src=unsafe>\n旧文章', bodyFormat: 'PLAIN' })]);
  const item = (await service.list(new URL('http://synthetic.test/api/knowledge'))).items[0];
  assert.equal(item.summary, '<img src=unsafe> 旧文章');
  assert.deepEqual(item.thumbnailUrls, []);
});
test('anonymous list stops before reading rows, removed detail exposes no media projection', async () => {
  const anonymous = fixture([row()], false);
  await assert.rejects(anonymous.service.list(new URL('http://synthetic.test/api/knowledge')), {
    code: 'UNAUTHENTICATED'
  });
  assert.equal(anonymous.calls.length, 0);
  const removed = fixture([row({ removedAt: new Date() })]);
  await assert.rejects(removed.service.detail(row().id), { code: 'NOT_FOUND' });
});
