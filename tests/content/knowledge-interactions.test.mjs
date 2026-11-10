import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { KnowledgeService } from '../../apps/web/server/knowledge/service.ts';
import { messageCategory } from '../../apps/web/server/messages/projection.ts';
const articleId = '31000000-0000-4000-8000-000000000001',
  ownerId = '41000000-0000-4000-8000-000000000001',
  actorId = '41000000-0000-4000-8000-000000000002';
const person = (id) => ({
  id,
  displayName: '合成成员',
  membership: 'MEMBER',
  gameRegion: '测试大区',
  gameServer: '测试服',
  createdAt: new Date('2026-10-22T00:00:00Z'),
  profile: null
});
const row = () => ({
  id: articleId,
  authorId: ownerId,
  author: person(ownerId),
  category: { id: randomUUID(), label: '历史分类', active: false, revision: 0 },
  title: '保留旧文',
  body: '正文',
  bodyFormat: 'PLAIN',
  jobs: ['原职业'],
  playstyles: ['原玩法'],
  gameVersions: ['原版本'],
  contributions: [],
  revision: 0,
  editMode: 'AUTHOR',
  removedAt: null,
  createdAt: new Date('2026-10-22T00:00:00Z'),
  updatedAt: new Date('2026-10-22T00:00:00Z')
});
function fixture() {
  const article = row(),
    reads = new Map(),
    interactions = new Map(),
    events = [],
    comments = [],
    audits = [];
  const actor = {
    id: randomUUID(),
    accountId: actorId,
    expiresAt: new Date('2026-10-23T00:00:00Z'),
    account: { phone: 'fixture-only', adminRole: 'NONE' }
  };
  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async (strings, ...values) => {
      events.push(values);
      return 1;
    },
    knowledgeArticle: { findUnique: async () => article },
    knowledgeArticleRead: {
      upsert: async ({ where, create }) => {
        const key = JSON.stringify(where);
        if (!reads.has(key)) reads.set(key, create);
        return reads.get(key);
      },
      count: async () => reads.size
    },
    knowledgeArticleInteraction: {
      findUnique: async ({ where }) => interactions.get(where.articleId_accountId.accountId) ?? null,
      upsert: async ({ where, create, update }) => {
        const key = where.articleId_accountId.accountId;
        interactions.set(key, interactions.has(key) ? { ...interactions.get(key), ...update } : create);
        return interactions.get(key);
      },
      count: async ({ where }) =>
        [...interactions.values()].filter((value) =>
          where.collectedAt ? value.collectedAt : where.likedAt ? value.likedAt : true
        ).length
    },
    knowledgeComment: {
      findMany: async () => comments,
      findFirst: async ({ where }) =>
        comments.find((value) => value.id === where.id && value.articleId === where.articleId) ?? null,
      updateMany: async ({ where, data }) => {
        for (const value of comments)
          if (where.id.in.includes(value.id) && !value.removedAt) {
            value.removedAt = data.removedAt;
            value.revision++;
          }
        return { count: where.id.in.length };
      }
    },
    knowledgeAudit: {
      create: async ({ data }) => {
        audits.push(data);
        return data;
      }
    }
  };
  let allowed = true;
  const auth = {
    now: () => new Date('2026-10-22T01:00:00Z'),
    requireAccount: async () => {
      if (!allowed) throw Object.assign(new Error('请先登录'), { code: 'UNAUTHENTICATED' });
      return actor;
    },
    transaction: async (fn) => fn(tx),
    db: { $transaction: async (fn) => fn(tx) }
  };
  return {
    service: new KnowledgeService(auth),
    actor,
    article,
    reads,
    interactions,
    events,
    comments,
    audits,
    deny() {
      allowed = false;
    }
  };
}
test('explicit read command counts one article once per authenticated session and stores only digest', async () => {
  const f = fixture();
  await f.service.detail(articleId, 'fixture-token');
  assert.equal(f.reads.size, 0);
  await f.service.read(articleId, {}, 'fixture-token');
  await f.service.read(articleId, {}, 'fixture-token');
  assert.equal(f.reads.size, 1);
  const record = [...f.reads.values()][0];
  assert.notEqual(record.sessionKey, f.actor.id);
  assert.match(record.sessionKey, /^[0-9a-f]{64}$/);
  f.actor.id = randomUUID();
  await f.service.read(articleId, {}, 'fixture-token');
  assert.equal(f.reads.size, 2);
});
test('collection create/cancel/recollect has correct counts and one permanent nonself notification', async () => {
  const f = fixture(),
    send = (collected) =>
      f.service.interact(articleId, 'collect', { collected, submissionKey: randomUUID() }, 'fixture-token');
  await send(true);
  await send(true);
  let detail = await f.service.detail(articleId, 'fixture-token');
  assert.equal(detail.collections, 1);
  assert.equal(detail.collected, true);
  assert.equal(f.events.length, 1);
  assert.ok(f.events[0].includes('COLLECTION'));
  await send(false);
  detail = await f.service.detail(articleId, 'fixture-token');
  assert.equal(detail.collections, 0);
  assert.equal(detail.collected, false);
  await send(true);
  assert.equal(f.events.length, 1);
  assert.ok(f.interactions.get(actorId).collectionNotifiedAt);
  assert.equal(messageCategory({ source: 'interaction', kind: 'COLLECTION' }), 'likes');
  assert.equal(f.article.title, '保留旧文');
  assert.deepEqual(f.article.jobs, ['原职业']);
  assert.equal(f.audits.length, 0);
});
test('likes and collections are independent; owner interaction makes no self notification', async () => {
  const f = fixture();
  await f.service.interact(articleId, 'like', { liked: true, submissionKey: randomUUID() });
  await f.service.interact(articleId, 'collect', { collected: true, submissionKey: randomUUID() });
  let detail = await f.service.detail(articleId);
  assert.equal(detail.likes, 1);
  assert.equal(detail.collections, 1);
  assert.equal(f.events.length, 2);
  await f.service.interact(articleId, 'like', { liked: false, submissionKey: randomUUID() });
  detail = await f.service.detail(articleId);
  assert.equal(detail.likes, 0);
  assert.equal(detail.collections, 1);
  f.actor.accountId = ownerId;
  await f.service.interact(articleId, 'collect', { collected: true, submissionKey: randomUUID() });
  assert.equal(f.events.length, 2);
});
test('anonymous/removed/invalid commands cannot count or create interaction notices', async () => {
  const anonymous = fixture();
  anonymous.deny();
  await assert.rejects(() => anonymous.service.read(articleId, {}), { code: 'UNAUTHENTICATED' });
  assert.equal(anonymous.reads.size, 0);
  const f = fixture();
  await assert.rejects(
    () => f.service.interact(articleId, 'collect', { collected: 'yes', submissionKey: randomUUID() }),
    { code: 'VALIDATION_ERROR' }
  );
  f.article.removedAt = new Date();
  await assert.rejects(() => f.service.read(articleId, {}), { code: 'NOT_FOUND' });
  await assert.rejects(
    () => f.service.interact(articleId, 'collect', { collected: true, submissionKey: randomUUID() }),
    { code: 'NOT_FOUND' }
  );
  assert.equal(f.reads.size, 0);
  assert.equal(f.events.length, 0);
});
function comment(id, parentId = null, authorId = actorId) {
  return {
    id,
    articleId,
    body: '评论',
    authorId,
    author: person(authorId),
    parentId,
    parent: null,
    createdAt: new Date('2026-10-22T00:00:00Z'),
    revision: 0,
    removedAt: null,
    images: []
  };
}
test('root pagination contains full reply ancestry and focused comment resolves correct page', async () => {
  const f = fixture();
  for (let i = 0; i < 11; i++) f.comments.push(comment(randomUUID()));
  const root = f.comments[10],
    child = comment(randomUUID(), root.id);
  child.parent = { author: root.author };
  f.comments.push(child);
  const first = await f.service.comments(articleId, new URL('http://fixture.test/?page=1'));
  assert.equal(first.items.length, 10);
  assert.equal(first.totalPages, 2);
  const second = await f.service.comments(articleId, new URL('http://fixture.test/?commentId=' + child.id));
  assert.equal(second.page, 2);
  assert.deepEqual(
    second.items.map((item) => item.id),
    [root.id, child.id]
  );
  assert.equal(second.items[0].canDelete, true);
  assert.equal(second.items[0].canModerate, false);
  root.removedAt = new Date();
  const hidden = await f.service.comments(articleId, new URL('http://fixture.test/'));
  assert.ok(!hidden.items.some((item) => item.id === child.id));
});
test('comment removal preserves siblings, enforces ownership/reason and removes descendant branch', async () => {
  const f = fixture(),
    root = comment(randomUUID()),
    child = comment(randomUUID(), root.id),
    sibling = comment(randomUUID());
  f.comments.push(root, child, sibling);
  await f.service.removeComment(articleId, root.id, { revision: 0, submissionKey: randomUUID() });
  assert.ok(root.removedAt);
  assert.ok(child.removedAt);
  assert.equal(sibling.removedAt, null);
  assert.equal(f.audits.length, 1);
  await f.service.removeComment(articleId, root.id, { revision: 0, submissionKey: randomUUID() });
  assert.equal(f.audits.length, 1);
  const forbidden = fixture(),
    other = comment(randomUUID(), null, ownerId);
  forbidden.comments.push(other);
  await assert.rejects(() => forbidden.service.removeComment(articleId, other.id, { revision: 0 }), {
    code: 'FORBIDDEN'
  });
  forbidden.actor.account.adminRole = 'ADMIN';
  await assert.rejects(() => forbidden.service.removeComment(articleId, other.id, { revision: 0 }), {
    code: 'VALIDATION_ERROR'
  });
  await forbidden.service.removeComment(articleId, other.id, {
    revision: 0,
    reason: '合成违规原因',
    commentId: other.id
  });
  assert.ok(other.removedAt);
  assert.equal(forbidden.events.length, 0);
});
