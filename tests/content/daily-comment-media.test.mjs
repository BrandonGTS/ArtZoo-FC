import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { visibleCommentIds, commentSubtreeIds } from '../../apps/web/server/daily/comment-tree.ts';
import { DailyService } from '../../apps/web/server/daily/service.ts';

// In-memory transaction adapter exercises actual DailyService decisions.
// No real auth session, database, storage, notifications, or environment files.
function fixture() {
  const actorId = randomUUID(),
    postId = randomUUID();
  const member = {
    id: actorId,
    phone: 'synthetic-only',
    membership: 'MEMBER',
    adminRole: 'NONE',
    displayName: '合成成员',
    gameRegion: '陆行鸟',
    gameServer: '神意之地',
    profile: null,
    createdAt: new Date('2030-01-01T00:00:00Z')
  };
  const actor = { id: randomUUID(), accountId: actorId, account: member };
  let state = {
    comments: [],
    media: [],
    commands: [],
    notices: [],
    audits: [],
    post: {
      id: postId,
      body: '动态',
      authorId: randomUUID(),
      author: member,
      mentions: [],
      revision: 0,
      createdAt: new Date(),
      editedAt: null,
      removedAt: null
    }
  };
  const tx = {
    $queryRaw: async (strings, ...args) => {
      if (strings[0].startsWith('/*daily-orphan:attachment-fence*/')) {
        assert.equal(args.length, 2);
        assert.equal(args[1], actorId);
        assert.ok(Array.isArray(args[0]) && args[0].length > 0 && args[0].length <= 10);
        for (const key of args[0])
          assert.ok(
            state.media.some(
              (media) => key === 'daily:' + media.id.toLowerCase() && media.ownerId === actorId
            )
          );
        assert.match(strings.join('?'), /WHERE c.namespace='daily' AND c.policy='PHOTO_VARIANT'/);
        // No synthetic image in this fixture has a retirement intent.
        return [{ found: false }];
      }
      return [];
    },
    account: {
      findMany: async ({ where }) => where.id.in.map((id) => ({ ...member, id })),
      count: async () => 1
    },
    dailyPost: {
      findUnique: async (args) =>
        args.where.id === postId
          ? {
              ...state.post,
              comments: state.comments.filter((c) => c.postId === postId),
              media: state.media.filter(
                (media) =>
                  media.postId === postId &&
                  !media.removedAt &&
                  (args.select?.media?.where?.commentId !== null || !media.commentId)
              ),
              _count: { likes: 0, comments: state.comments.filter((comment) => !comment.removedAt).length }
            }
          : null,
      update: async ({ data }) => Object.assign(state.post, data)
    },
    dailyComment: {
      findUnique: async ({ where }) => state.comments.find((comment) => comment.id === where.id) ?? null,
      create: async ({ data }) => {
        const comment = { id: randomUUID(), revision: 0, removedAt: null, ...data };
        state.comments.push(comment);
        return comment;
      },
      update: async ({ where, data }) =>
        Object.assign(
          state.comments.find((comment) => comment.id === where.id),
          data
        ),
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const c of state.comments)
          if (c.postId === where.postId && where.id.in.includes(c.id) && !c.removedAt) {
            c.removedAt = data.removedAt;
            c.revision += data.revision.increment;
            count++;
          }
        return { count };
      },
      findMany: async ({ where }) =>
        state.comments
          .filter((c) => c.postId === where.postId)
          .map((comment) => ({
            ...comment,
            author: member,
            parent: null,
            media: state.media.filter((media) => media.commentId === comment.id && !media.removedAt)
          }))
    },
    dailyMedia: {
      findMany: async ({ where }) => state.media.filter((media) => where.id.in.includes(media.id)),
      findUnique: async ({ where }) => {
        const media = state.media.find((media) => media.id === where.id);
        return media
          ? {
              ...media,
              post: media.postId ? state.post : null,
              comment: state.comments.find((comment) => comment.id === media.commentId) ?? null
            }
          : null;
      },
      update: async ({ where, data }) =>
        Object.assign(
          state.media.find((media) => media.id === where.id),
          data
        ),
      updateMany: async ({ where, data }) => {
        for (const media of state.media)
          if (
            media.postId === where.postId &&
            (where.commentId !== null || media.commentId === null) &&
            !where.id.notIn.includes(media.id)
          )
            Object.assign(media, data);
      }
    },
    dailyCommand: {
      findUnique: async ({ where }) =>
        state.commands.find(
          (command) =>
            command.actorId === where.actorId_submissionKey.actorId &&
            command.submissionKey === where.actorId_submissionKey.submissionKey
        ) ?? null,
      create: async ({ data }) => {
        state.commands.push(data);
        return data;
      }
    },
    dailyLike: { findUnique: async () => null },
    dailyNotification: {
      create: async ({ data }) => {
        state.notices.push(data);
        return data;
      }
    },
    dailyAudit: {
      create: async ({ data }) => {
        state.audits.push(data);
        return data;
      }
    }
  };
  const auth = {
    db: tx,
    requireAccount: async () => actor,
    rate: async () => {},
    now: () => new Date('2026-10-20T00:00:00.000Z'),
    transaction: async (run) => {
      const before = structuredClone(state);
      try {
        return await run(tx);
      } catch (error) {
        state = before;
        throw error;
      }
    }
  };
  let reads = 0;
  const service = new DailyService(auth, {
    read: async () => {
      reads++;
      return Buffer.from('synthetic-image');
    }
  });
  function media(overrides = {}) {
    const item = {
      id: randomUUID(),
      ownerId: actorId,
      postId: null,
      commentId: null,
      removedAt: null,
      width: 80,
      height: 60,
      frames: 1,
      position: 0,
      mime: 'image/png',
      ...overrides
    };
    state.media.push(item);
    return item;
  }
  const input = (changes) => ({
    body: '回复',
    mentions: [],
    parentId: null,
    mediaIds: [],
    submissionKey: randomUUID(),
    ...changes
  });
  return {
    service,
    media,
    input,
    actorId,
    postId,
    get state() {
      return state;
    },
    get reads() {
      return reads;
    }
  };
}
test('image-only comment claims images in order and preserves existing notification/idempotency contract', async () => {
  const f = fixture(),
    a = f.media(),
    b = f.media(),
    input = f.input({ body: '', mediaIds: [b.id, a.id] });
  const result = await f.service.comment(f.postId, input, 'synthetic');
  assert.equal(f.state.comments.length, 1);
  assert.equal(f.state.comments[0].body, '');
  assert.deepEqual(
    f.state.media.map((media) => [media.postId, media.commentId, media.position]),
    [
      [f.postId, result.id, 1],
      [f.postId, result.id, 0]
    ]
  );
  assert.equal(f.state.notices.length, 1);
  assert.equal(f.state.notices[0].kind, 'COMMENT');
  assert.equal(f.state.notices[0].commentId, result.id);
  assert.deepEqual(await f.service.comment(f.postId, input, 'synthetic'), { id: result.id, replayed: true });
  assert.equal(f.state.comments.length, 1);
  assert.equal(f.state.notices.length, 1);
});
test('legacy text comments work without mediaIds; empty and excessive image comments fail atomically', async () => {
  const f = fixture(),
    legacy = f.input();
  delete legacy.mediaIds;
  await f.service.comment(f.postId, legacy, 'synthetic');
  await assert.rejects(
    f.service.comment(f.postId, f.input({ body: '' }), 'synthetic'),
    (error) => error.code === 'VALIDATION_ERROR'
  );
  await assert.rejects(
    f.service.comment(
      f.postId,
      f.input({ mediaIds: Array.from({ length: 11 }, () => randomUUID()) }),
      'synthetic'
    ),
    (error) => error.code === 'VALIDATION_ERROR'
  );
  assert.equal(f.state.comments.length, 1);
  assert.equal(f.state.commands.length, 1);
});
for (const [name, overrides] of [
  ['foreign owner', { ownerId: randomUUID() }],
  ['removed image', { removedAt: new Date() }],
  ['post attachment', { postId: randomUUID() }],
  ['comment attachment', { commentId: randomUUID() }]
])
  test('comment rejects ' + name + ' without writes', async () => {
    const f = fixture(),
      image = f.media(overrides);
    await assert.rejects(
      f.service.comment(f.postId, f.input({ mediaIds: [image.id] }), 'synthetic'),
      (error) => error.code === 'FORBIDDEN'
    );
    assert.equal(f.state.comments.length, 0);
    assert.equal(f.state.commands.length, 0);
    assert.equal(f.state.notices.length, 0);
  });
test('duplicate image identifiers and invalid reply parents are rejected without claiming media', async () => {
  const f = fixture(),
    image = f.media();
  await assert.rejects(
    f.service.comment(f.postId, f.input({ mediaIds: [image.id, image.id] }), 'synthetic'),
    (error) => error.code === 'VALIDATION_ERROR'
  );
  await assert.rejects(
    f.service.comment(f.postId, f.input({ mediaIds: [image.id], parentId: randomUUID() }), 'synthetic'),
    (error) => error.code === 'VALIDATION_ERROR'
  );
  assert.equal(f.state.media[0].postId, null);
  assert.equal(f.state.comments.length, 0);
});
test('post previews exclude comment images and deleted comments expose no attachments or bytes', async () => {
  const f = fixture(),
    image = f.media(),
    result = await f.service.comment(f.postId, f.input({ mediaIds: [image.id] }), 'synthetic');
  assert.equal((await f.service.get(f.postId, 'synthetic')).media.length, 0);
  assert.equal((await f.service.comments(f.postId, 'synthetic')).items[0].media[0].id, image.id);
  assert.equal(
    (await f.service.media(image.id, 'thumbnail', 'synthetic')).bytes.toString(),
    'synthetic-image'
  );
  await f.service.removeComment(result.id, { revision: 0, submissionKey: randomUUID() }, 'synthetic');
  assert.deepEqual((await f.service.comments(f.postId, 'synthetic')).items, []);
  assert.equal(f.state.comments[0].body, '回复', 'physical content retained');
  await assert.rejects(
    f.service.media(image.id, 'preview', 'synthetic'),
    (error) => error.code === 'NOT_FOUND'
  );
  assert.equal(f.reads, 1);
});
test('editing post preserves comment images and cannot move them into post content', async () => {
  const f = fixture(),
    image = f.media(),
    result = await f.service.comment(f.postId, f.input({ mediaIds: [image.id] }), 'synthetic');
  f.state.post.authorId = f.actorId;
  await f.service.update(f.postId, f.input({ revision: 0 }), 'synthetic');
  assert.equal(f.state.media[0].removedAt, null);
  assert.equal(f.state.media[0].commentId, result.id);
  f.state.post.revision = 1;
  await assert.rejects(
    f.service.update(f.postId, f.input({ revision: 1, mediaIds: [image.id] }), 'synthetic'),
    (error) => error.code === 'FORBIDDEN'
  );
  assert.equal(f.state.media[0].commentId, result.id);
});

test('existing owner-only remove and admin moderation endpoints enforce post and reply permission matrices without extra notices', async () => {
  const f = fixture(),
    actor = await f.service.auth.requireAccount(),
    comment = await f.service.comment(f.postId, f.input(), 'synthetic');
  const notices = f.state.notices.length;
  await assert.rejects(
    f.service.remove(f.postId, f.input({ revision: 0 }), 'synthetic'),
    (error) => error.code === 'FORBIDDEN'
  );
  await assert.rejects(
    f.service.moderate(f.postId, f.input({ revision: 0, reason: '合成原因' }), 'synthetic'),
    (error) => error.code === 'FORBIDDEN'
  );
  f.state.comments[0].authorId = randomUUID();
  await assert.rejects(
    f.service.removeComment(comment.id, f.input({ revision: 0 }), 'synthetic'),
    (error) => error.code === 'FORBIDDEN'
  );
  actor.account.adminRole = 'ADMIN';
  await assert.rejects(
    f.service.moderate(f.postId, f.input({ commentId: comment.id, revision: 0, reason: '' }), 'synthetic'),
    (error) => error.code === 'VALIDATION_ERROR'
  );
  await f.service.moderate(
    f.postId,
    f.input({ commentId: comment.id, revision: 0, reason: '合成回复处理' }),
    'synthetic'
  );
  assert.equal(f.state.audits.at(-1).action, 'MODERATE_REMOVE');
  assert.equal(f.state.audits.at(-1).commentId, comment.id);
  await f.service.moderate(f.postId, f.input({ revision: 0, reason: '合成动态处理' }), 'synthetic');
  assert.equal(f.state.audits.at(-1).actorId, f.actorId);
  assert.equal(f.state.audits.at(-1).reason, '合成动态处理');
  assert.equal(
    f.state.notices.length,
    notices,
    'deletion and moderation do not invent notification recipients'
  );
});

test('author deletion atomically removes all cross-author descendants through tombstones, keeps siblings and replays once', async () => {
  const f = fixture(),
    root = await f.service.comment(f.postId, f.input(), 'synthetic');
  const child = await f.service.comment(f.postId, f.input({ parentId: root.id }), 'synthetic');
  const leafImage = f.media(),
    leaf = await f.service.comment(
      f.postId,
      f.input({ parentId: child.id, mediaIds: [leafImage.id] }),
      'synthetic'
    );
  const sibling = await f.service.comment(f.postId, f.input(), 'synthetic');
  f.state.comments.find((c) => c.id === child.id).authorId = randomUUID();
  f.state.comments.find((c) => c.id === child.id).removedAt = new Date('2026-01-01');
  const cross = { id: randomUUID(), postId: randomUUID(), parentId: root.id, removedAt: null, revision: 0 };
  f.state.comments.push(cross);
  const notices = structuredClone(f.state.notices),
    input = { revision: 0, submissionKey: randomUUID() };
  await f.service.removeComment(root.id, input, 'synthetic');
  await f.service.removeComment(root.id, input, 'synthetic');
  for (const id of [root.id, leaf.id]) {
    const c = f.state.comments.find((c) => c.id === id);
    assert.ok(c.removedAt);
    assert.equal(c.revision, 1);
  }
  assert.equal(
    f.state.comments.find((c) => c.id === child.id).revision,
    0,
    'already removed intermediate is unchanged'
  );
  assert.equal(f.state.comments.find((c) => c.id === sibling.id).removedAt, null);
  assert.equal(f.state.comments.find((c) => c.id === cross.id).removedAt, null);
  assert.deepEqual(
    (await f.service.comments(f.postId, 'synthetic')).items.map((c) => c.id),
    [sibling.id]
  );
  assert.equal((await f.service.get(f.postId, 'synthetic')).comments, 1);
  assert.deepEqual(f.state.notices, notices);
  assert.equal(f.state.audits.length, 1);
  assert.equal(f.state.audits[0].commentId, root.id);
  await assert.rejects(f.service.media(leafImage.id, 'original', 'synthetic'), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(
    f.service.comment(f.postId, f.input({ parentId: leaf.id }), 'synthetic'),
    (e) => e.code === 'VALIDATION_ERROR'
  );
  await assert.rejects(
    f.service.removeComment(root.id, { ...input, revision: 1 }, 'synthetic'),
    (e) => e.code === 'CONFLICT'
  );
});
test('legacy deleted ancestry is projected out of comments, counts, media and reply targets without mutating history', async () => {
  const f = fixture(),
    root = await f.service.comment(f.postId, f.input(), 'synthetic'),
    image = f.media();
  const child = await f.service.comment(
    f.postId,
    f.input({ parentId: root.id, mediaIds: [image.id] }),
    'synthetic'
  );
  f.state.comments.find((c) => c.id === root.id).removedAt = new Date('2026-01-01');
  const before = structuredClone(f.state);
  assert.deepEqual((await f.service.comments(f.postId, 'synthetic')).items, []);
  assert.equal((await f.service.get(f.postId, 'synthetic')).comments, 0);
  await assert.rejects(f.service.media(image.id, 'preview', 'synthetic'), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(
    f.service.comment(f.postId, f.input({ parentId: child.id }), 'synthetic'),
    (e) => e.code === 'VALIDATION_ERROR'
  );
  assert.deepEqual(f.state, before);
  assert.equal(f.reads, 0);
});
test('admin cascade preserves mandatory reason, target revision, author-only endpoint and root audit', async () => {
  const f = fixture(),
    root = await f.service.comment(f.postId, f.input(), 'synthetic'),
    leaf = await f.service.comment(f.postId, f.input({ parentId: root.id }), 'synthetic');
  f.state.comments[0].authorId = randomUUID();
  const actor = await f.service.auth.requireAccount();
  actor.account.adminRole = 'ADMIN';
  await assert.rejects(
    f.service.removeComment(root.id, f.input({ revision: 0 }), 'synthetic'),
    (e) => e.code === 'FORBIDDEN'
  );
  await assert.rejects(
    f.service.moderate(f.postId, f.input({ commentId: root.id, revision: 0, reason: '' }), 'synthetic'),
    (e) => e.code === 'VALIDATION_ERROR'
  );
  await assert.rejects(
    f.service.moderate(
      f.postId,
      f.input({ commentId: root.id, revision: 2, reason: '合成原因' }),
      'synthetic'
    ),
    (e) => e.code === 'CONFLICT'
  );
  await f.service.moderate(
    f.postId,
    f.input({ commentId: root.id, revision: 0, reason: '合成原因' }),
    'synthetic'
  );
  assert.deepEqual((await f.service.comments(f.postId, 'synthetic')).items, []);
  assert.ok(f.state.comments.find((c) => c.id === leaf.id).removedAt);
  assert.equal(f.state.audits.length, 1);
  assert.equal(f.state.audits[0].reason, '合成原因');
  assert.equal(f.state.audits[0].commentId, root.id);
});

test('tree projection and closure handle arbitrary existing depth, removed bridges, orphans and cycles without recursion', () => {
  const rows = Array.from({ length: 12000 }, (_, i) => ({
    id: String(i),
    parentId: i ? String(i - 1) : null,
    removedAt: null
  }));
  assert.equal(visibleCommentIds(rows).size, 12000);
  assert.equal(commentSubtreeIds(rows, '0').size, 12000);
  rows[6000].removedAt = new Date();
  assert.equal(visibleCommentIds(rows).size, 6000);
  assert.equal(commentSubtreeIds(rows, '0').size, 12000);
  const malformed = [
    { id: 'a', parentId: 'b', removedAt: null },
    { id: 'b', parentId: 'a', removedAt: null },
    { id: 'orphan', parentId: 'missing', removedAt: null }
  ];
  assert.equal(visibleCommentIds(malformed).size, 0);
  assert.deepEqual(commentSubtreeIds(malformed, 'a'), new Set(['a', 'b']));
});
