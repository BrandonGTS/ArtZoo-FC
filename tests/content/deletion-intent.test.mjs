import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { KnowledgeService } from '../../apps/web/server/knowledge/service.ts';
import { AlbumService } from '../../apps/web/server/albums/service.ts';

const owner = '41000000-0000-4000-8000-000000000001',
  other = '41000000-0000-4000-8000-000000000002';
function fixture(role = 'NONE', actorId = owner, collaborative = false) {
  const article = {
    id: randomUUID(),
    authorId: owner,
    contributions: collaborative ? [{ accountId: other }] : [],
    revision: 0,
    removedAt: null
  };
  const album = { id: randomUUID(), creatorId: owner, revision: 0, removedAt: null };
  const photos = [{ id: randomUUID(), albumId: album.id, uploaderId: owner, revision: 0, removedAt: null }];
  const comment = {
    id: randomUUID(),
    articleId: article.id,
    albumId: album.id,
    authorId: owner,
    parentId: null,
    revision: 0,
    removedAt: null
  };
  const actor = {
    id: randomUUID(),
    accountId: actorId,
    expiresAt: new Date('2026-10-24T00:00:00Z'),
    account: { phone: 'synthetic-only', adminRole: role, membership: 'MEMBER' }
  };
  const audits = [],
    writes = [],
    commands = new Map();
  const mutate = (row, data) => {
    writes.push(data);
    Object.assign(row, { ...data, revision: row.revision + 1 });
    return row;
  };
  const tx = {
    $queryRaw: async () => [],
    knowledgeArticle: { findUnique: async () => article, update: async ({ data }) => mutate(article, data) },
    album: { findUnique: async () => album, update: async ({ data }) => mutate(album, data) },
    albumPhoto: {
      findFirst: async ({ where }) =>
        where.uploaderId
          ? photos.find((p) => p.uploaderId !== where.uploaderId.not)
          : photos.find((p) => p.id === where.id && !p.removedAt),
      findUnique: async () => photos[0],
      findMany: async () => photos,
      update: async ({ data }) => mutate(photos[0], data),
      updateMany: async ({ data }) => {
        for (const p of photos) mutate(p, data);
        return { count: photos.length };
      }
    },
    knowledgeComment: {
      findFirst: async () => comment,
      findMany: async () => [comment],
      updateMany: async ({ data }) => mutate(comment, data)
    },
    albumComment: {
      findUnique: async () => comment,
      findMany: async () => [comment],
      updateMany: async ({ data }) => mutate(comment, data)
    },
    knowledgeAudit: { create: async ({ data }) => audits.push(data) },
    albumAudit: {
      create: async ({ data }) => audits.push(data),
      createMany: async ({ data }) => audits.push(...data)
    },
    albumCommand: {
      findUnique: async ({ where }) => commands.get(where.actorId_submissionKey.submissionKey),
      create: async ({ data }) => commands.set(data.submissionKey, data)
    }
  };
  let authenticated = true;
  const auth = {
    now: () => new Date('2026-10-22T01:00:00Z'),
    requireAccount: async () => {
      if (!authenticated) throw Object.assign(new Error('unauthenticated'), { code: 'UNAUTHENTICATED' });
      return actor;
    },
    transaction: async (fn) => fn(tx)
  };
  return {
    knowledge: new KnowledgeService(auth),
    albums: new AlbumService(auth, {}),
    article,
    album,
    photos,
    comment,
    actor,
    audits,
    writes,
    deny: () => {
      authenticated = false;
    }
  };
}
const rejection = (fn, code) => assert.rejects(fn, { code });
for (const role of ['NONE', 'ADMIN', 'SUPER_ADMIN'])
  test('article ordinary author deletion without reason: ' + role, async () => {
    const f = fixture(role);
    await f.knowledge.remove(f.article.id, { expectedRevision: 0, intent: 'SELF' });
    assert.equal(f.audits[0].action, 'ARTICLE_REMOVED');
    assert.equal(f.audits[0].reason, '作者删除本人文章');
  });
test('collaborative author SELF restriction also applies to admin; governance remains available', async () => {
  for (const role of ['NONE', 'ADMIN']) {
    const f = fixture(role, owner, true);
    await rejection(
      () => f.knowledge.remove(f.article.id, { expectedRevision: 0, intent: 'SELF' }),
      'FORBIDDEN'
    );
    assert.equal(f.writes.length, 0);
  }
  const f = fixture('ADMIN', owner, true);
  await f.knowledge.remove(f.article.id, { expectedRevision: 0, intent: 'MODERATE', reason: '合成治理原因' });
  assert.equal(f.audits[0].action, 'ARTICLE_MODERATED');
});
test('article governance validates actual role, intent and reason before any write', async () => {
  const cases = [
    ['NONE', other, 'SELF', undefined, 'FORBIDDEN'],
    ['NONE', owner, 'MODERATE', '理由', 'FORBIDDEN'],
    ['ADMIN', other, 'SELF', undefined, 'FORBIDDEN'],
    ['ADMIN', other, 'MODERATE', '  ', 'VALIDATION_ERROR'],
    ['ADMIN', owner, 'FORGED', '理由', 'VALIDATION_ERROR']
  ];
  for (const [role, actor, intent, reason, code] of cases) {
    const f = fixture(role, actor);
    await rejection(() => f.knowledge.remove(f.article.id, { expectedRevision: 0, intent, reason }), code);
    assert.equal(f.writes.length, 0);
    assert.equal(f.audits.length, 0);
  }
  const f = fixture('ADMIN', other);
  await f.knowledge.remove(f.article.id, { expectedRevision: 0, intent: 'MODERATE', reason: ' 合成原因 ' });
  assert.equal(f.audits[0].reason, '合成原因');
});
test('anonymous and stale article removals leave content and audits untouched', async () => {
  const f = fixture();
  f.deny();
  await rejection(
    () => f.knowledge.remove(f.article.id, { expectedRevision: 0, intent: 'SELF' }),
    'UNAUTHENTICATED'
  );
  assert.equal(f.writes.length, 0);
  const stale = fixture('ADMIN');
  await rejection(
    () =>
      stale.knowledge.remove(stale.article.id, { expectedRevision: 1, intent: 'MODERATE', reason: '原因' }),
    'CONFLICT'
  );
  assert.equal(stale.writes.length, 0);
});
test('album owner ordinary deletion checks foreign upload history including removed photos', async () => {
  const f = fixture('ADMIN');
  f.photos.push({ id: randomUUID(), uploaderId: other, removedAt: new Date() });
  await rejection(
    () => f.albums.update(f.album.id, { action: 'remove', revision: 0, intent: 'SELF' }),
    'FORBIDDEN'
  );
  assert.equal(f.writes.length, 0);
  await f.albums.update(f.album.id, {
    action: 'remove',
    revision: 0,
    intent: 'MODERATE',
    reason: '合成原因'
  });
  assert.equal(f.audits[0].reason, '合成原因');
  const own = fixture('ADMIN');
  await own.albums.update(own.album.id, { action: 'remove', revision: 0, intent: 'SELF' });
  assert.equal(own.audits[0].reason, '创建者删除本人相册');
});
test('photo ordinary deletion retains uploader OR album creator eligibility', async () => {
  for (const actor of [owner, other]) {
    const f = fixture('ADMIN', actor);
    f.photos[0].uploaderId = other;
    await f.albums.updatePhoto(f.photos[0].id, { action: 'remove', revision: 0, intent: 'SELF' });
    assert.equal(f.audits[0].action, 'PHOTO_REMOVED');
  }
  const denied = fixture('ADMIN', randomUUID());
  await rejection(
    () => denied.albums.updatePhoto(denied.photos[0].id, { action: 'remove', revision: 0, intent: 'SELF' }),
    'FORBIDDEN'
  );
  assert.equal(denied.writes.length, 0);
  await denied.albums.updatePhoto(denied.photos[0].id, {
    action: 'remove',
    revision: 0,
    intent: 'MODERATE',
    reason: '合成原因'
  });
  assert.equal(denied.audits[0].action, 'PHOTO_MODERATED');
});
test('batch governance preserves exact request replay and rejects changed intent with same key', async () => {
  const f = fixture('ADMIN', other),
    body = {
      action: 'remove',
      intent: 'MODERATE',
      reason: '合成原因',
      photos: f.photos.map((p) => ({ id: p.id, revision: 0 })),
      submissionKey: randomUUID()
    };
  await rejection(() => f.albums.mutatePhotos(f.album.id, { ...body, reason: '' }), 'VALIDATION_ERROR');
  assert.equal(f.writes.length, 0);
  await f.albums.mutatePhotos(f.album.id, body);
  const replay = await f.albums.mutatePhotos(f.album.id, body);
  assert.equal(replay.replayed, true);
  assert.equal(f.audits.length, 1);
  await rejection(() => f.albums.mutatePhotos(f.album.id, { ...body, intent: 'SELF' }), 'CONFLICT');
  assert.equal(f.audits.length, 1);
});
for (const scope of ['knowledge', 'album'])
  test(scope + ' comment own-admin ordinary and governance remain separate', async () => {
    const erase = (f, body) =>
      scope === 'knowledge'
        ? f.knowledge.removeComment(f.article.id, f.comment.id, body)
        : f.albums.removeComment(f.comment.id, { submissionKey: randomUUID(), ...body });
    const own = fixture('ADMIN');
    await erase(own, { revision: 0, intent: 'SELF' });
    assert.equal(own.audits[0].reason, '作者删除本人评论');
    const governance = fixture('ADMIN');
    await rejection(
      () => erase(governance, { revision: 0, intent: 'MODERATE', reason: '' }),
      'VALIDATION_ERROR'
    );
    assert.equal(governance.writes.length, 0);
    await erase(governance, { revision: 0, intent: 'MODERATE', reason: '合成违规原因' });
    assert.equal(governance.audits[0].reason, '合成违规原因');
    const forged = fixture('NONE', other);
    await rejection(() => erase(forged, { revision: 0, intent: 'SELF' }), 'FORBIDDEN');
    assert.equal(forged.writes.length, 0);
  });
