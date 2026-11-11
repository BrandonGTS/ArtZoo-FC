// Production AlbumService against a serialized, rollback-capable synthetic transaction harness.
// This file never loads dotenv, a database connection, real sessions, or user media.
import test from 'node:test';
import { rawRows } from './support/album-comments-query.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AlbumService } from '../../apps/web/server/albums/service.ts';
import { photoSelection, photoRotation } from '../../apps/web/server/albums/contract.ts';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = {
  album: uuid(1),
  other: uuid(2),
  owner: uuid(3),
  uploader: uuid(4),
  outsider: uuid(5),
  admin: uuid(6)
};
const url = (q) => new URL('https://synthetic.invalid/?' + q);
const person = (id) => ({
  id,
  displayName: 'Synthetic ' + id.slice(-2),
  createdAt: new Date(1990000000000),
  gameRegion: 'Synthetic region',
  gameServer: 'Synthetic server',
  membership: 'MEMBER',
  profile: { bio: 'Synthetic', avatar: null },
  phone: 'never-project',
  adminRole: id === ids.admin ? 'ADMIN' : 'NONE'
});
function harness(count = 26) {
  let state = {
    photos: Array.from({ length: count }, (_, i) => ({
      id: uuid(100 + i),
      albumId: ids.album,
      uploaderId: ids.uploader,
      createdAt: new Date(2000000000000 - i * 1000),
      description: 'Synthetic',
      originalName: `synthetic-${i}.png`,
      width: 32,
      height: 20,
      frames: 1,
      periodActivityId: null,
      revision: 0,
      rotation: 0,
      featuredAt: null,
      removedAt: null,
      digest: 'never-project',
      mime: 'image/png'
    })),
    commands: [],
    audits: [],
    comments: [],
    media: [],
    notifications: [],
    likes: []
  };
  const stored = new Map(state.photos.map((p) => [p.id, Buffer.from('SYNTHETIC ORIGINAL ' + p.id)])),
    mediaCalls = [];
  let tail = Promise.resolve(),
    expired = false,
    expireOnCommand = false;
  const filter = (rows, w = {}) =>
    rows.filter((p) =>
      Object.entries(w).every(([k, v]) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? 'in' in v
            ? v.in.includes(p[k])
            : 'not' in v
              ? p[k] !== v.not
              : true
          : p[k] === v
      )
    );
  const updated = (p, data) => {
    for (const [k, v] of Object.entries(data))
      p[k] = v && typeof v === 'object' && 'increment' in v ? p[k] + v.increment : v;
    return p;
  };
  const album = () => ({
    id: ids.album,
    creatorId: ids.owner,
    creator: person(ids.owner),
    category: null,
    primary: 'DAILY',
    categoryId: null,
    uploadMode: 'COMMUNITY',
    uploadsClosed: false,
    removedAt: null,
    activityId: null,
    seriesId: null,
    name: 'Synthetic',
    description: '',
    revision: 0,
    _count: {
      photos: state.photos.filter((p) => !p.removedAt).length,
      comments: state.comments.filter((c) => !c.removedAt && c.photoId === null).length
    },
    photos: state.photos.filter((p) => !p.removedAt).slice(0, 1)
  });
  const projected = (p) =>
    p
      ? {
          ...p,
          uploader: person(p.uploaderId),
          album: { removedAt: null },
          _count: {
            likes: 0,
            comments: state.comments.filter((c) => c.photoId === p.id && !c.removedAt).length
          }
        }
      : null;
  const comment = (c) =>
    c
      ? {
          ...c,
          author: person(c.authorId),
          parent: c.parentId
            ? { author: person(state.comments.find((x) => x.id === c.parentId).authorId) }
            : null,
          media: state.media
            .filter((m) => m.commentId === c.id && !m.removedAt)
            .sort((a, b) => a.position - b.position)
        }
      : null;
  const tx = {
    $queryRaw: async (strings, ...values) => {
      if (strings.join('?').includes('WITH RECURSIVE scope AS MATERIALIZED')) {
        assert.equal(strings.length, 5, 'exact comments query parameter shape');
        return rawRows(
          {
            comments: state.comments,
            people: [...new Set(state.comments.map((c) => c.authorId))].map(person),
            media: state.media
          },
          values
        );
      }
      // 替身：评论图片尚未进入"待清理"流程（真实数据库中由 MediaRetirementIntent 判定）。
      if (strings.join('?').includes('album-comment-orphan:attachment-fence')) return [{ found: false }];
      return [];
    },
    album: { findUnique: async ({ where }) => (where.id === ids.album ? album() : null) },
    albumPhoto: {
      findUnique: async ({ where }) => projected(state.photos.find((p) => p.id === where.id)),
      findFirst: async ({ where }) => projected(filter(state.photos, where)[0]),
      findMany: async ({ where, skip = 0, take }) =>
        filter(state.photos, where)
          .slice(skip, take === undefined ? undefined : skip + take)
          .map(projected),
      count: async ({ where }) => filter(state.photos, where).length,
      update: async ({ where, data }) =>
        updated(
          state.photos.find((p) => p.id === where.id),
          data
        ),
      updateMany: async ({ where, data }) => {
        const rows = filter(state.photos, where);
        rows.forEach((p) => updated(p, data));
        return { count: rows.length };
      }
    },
    albumCommand: {
      findUnique: async ({ where }) =>
        state.commands.find(
          (c) =>
            c.actorId === where.actorId_submissionKey.actorId &&
            c.submissionKey === where.actorId_submissionKey.submissionKey
        ),
      create: async ({ data }) => {
        state.commands.push(data);
        if (expireOnCommand) expired = true;
        return data;
      }
    },
    albumLike: {
      findUnique: async ({ where }) =>
        state.likes.find(
          (l) =>
            l.photoId === where.photoId_accountId.photoId && l.accountId === where.photoId_accountId.accountId
        ) ?? null,
      findMany: async ({ where, select }) => {
        assert.equal(typeof where.accountId, 'string');
        assert.ok(Array.isArray(where.photoId.in));
        assert.deepEqual(select, { photoId: true });
        return filter(state.likes, where).map((l) => ({ photoId: l.photoId }));
      }
    },
    albumAudit: {
      create: async ({ data }) => state.audits.push(data),
      createMany: async ({ data }) => state.audits.push(...data)
    },
    account: {
      findMany: async ({ where }) =>
        where.id ? where.id.in.map(person) : [person(ids.owner), person(ids.uploader), person(ids.outsider)],
      findUnique: async ({ where }) => person(where.id)
    },
    albumComment: {
      findUnique: async ({ where }) =>
        comment(
          where.id
            ? state.comments.find((c) => c.id === where.id)
            : state.comments.find(
                (c) =>
                  c.authorId === where.authorId_submissionKey.authorId &&
                  c.submissionKey === where.authorId_submissionKey.submissionKey
              )
        ),
      findFirst: async ({ where }) => comment(filter(state.comments, where)[0]),
      findMany: async ({ where }) => filter(state.comments, where).map(comment),
      create: async ({ data }) => {
        const c = {
          id: randomUUID(),
          revision: 0,
          createdAt: new Date(2000000000000 + state.comments.length),
          removedAt: null,
          ...data
        };
        state.comments.push(c);
        return c;
      },
      updateMany: async ({ where, data }) => {
        const rows = filter(state.comments, where);
        rows.forEach((c) => updated(c, data));
        return { count: rows.length };
      }
    },
    albumCommentMedia: {
      findMany: async ({ where }) => filter(state.media, where),
      findUnique: async ({ where }) => state.media.find((m) => m.id === where.id),
      findFirst: async ({ where }) => {
        const m = filter(state.media, where)[0];
        return m
          ? { ...m, comment: m.commentId ? state.comments.find((c) => c.id === m.commentId) : null }
          : null;
      },
      update: async ({ where, data }) =>
        updated(
          state.media.find((m) => m.id === where.id),
          data
        )
    },
    albumNotification: { createMany: async ({ data }) => state.notifications.push(...data) }
  };
  const transaction = (fn) => {
    const run = tail.then(async () => {
      const before = structuredClone(state);
      try {
        return await fn(tx);
      } catch (e) {
        state = before;
        throw e;
      }
    });
    tail = run.catch(() => {});
    return run;
  };
  const auth = {
    now: () => new Date(2000000000000),
    requireAccount: async (_, token) => {
      if (!token || expired) throw Object.assign(new Error('Synthetic unauthenticated'), { status: 401 });
      return { id: token, accountId: token, account: person(token) };
    },
    transaction,
    db: { $transaction: transaction }
  };
  const storage = {
    read: async (id, variant) => {
      mediaCalls.push({ id, variant });
      return stored.get(id) ?? Buffer.from('Synthetic attachment');
    },
    put: async () => {
      throw Error('Unexpected byte write');
    },
    discardUncommitted: async () => {
      throw Error('Unexpected byte removal');
    }
  };
  return {
    service: new AlbumService(auth, storage),
    get state() {
      return state;
    },
    stored,
    mediaCalls,
    expireAtFinalWrite() {
      expireOnCommand = true;
    }
  };
}
const rotate = (id, revision = 0, direction = 'right', submissionKey = randomUUID()) => ({
  action: 'rotate',
  photoId: id,
  revision,
  direction,
  submissionKey
});
const remove = (rows, extra = {}) => ({
  action: 'remove',
  photos: rows.map((p) => ({ id: p.id, revision: p.revision })),
  submissionKey: randomUUID(),
  intent: 'SELF',
  ...extra
});
const commentBody = (extra = {}) => ({
  body: 'Synthetic comment',
  mentions: [],
  parentId: null,
  photoId: null,
  mediaIds: [],
  submissionKey: randomUUID(),
  ...extra
});
const rejected = (status) => (e) => e.status === status;
test('selection rejects empty, duplicate and malformed rows; rotation rejects invalid direction', () => {
  for (const value of [
    [],
    [
      { id: uuid(3), revision: 0 },
      { id: uuid(3), revision: 0 }
    ],
    [{ id: uuid(3), revision: -1 }],
    null
  ])
    assert.throws(() => photoSelection(value), rejected(400));
  assert.equal(photoRotation(0, 'left'), 270);
  assert.equal(photoRotation(270, 'right'), 0);
  assert.throws(() => photoRotation(0, 'up'), rejected(400));
});
test('24-photo pages preserve old page behavior and expose accurate total; overlay reaches all 26', async () => {
  const h = harness(),
    one = await h.service.photos(ids.album, url('page=1'), ids.outsider),
    two = await h.service.photos(ids.album, url('page=2'), ids.outsider),
    past = await h.service.photos(ids.album, url('page=3'), ids.outsider),
    viewer = await h.service.viewerPhotos(ids.album, url(''), ids.outsider);
  assert.equal(one.items.length, 24);
  assert.equal(one.hasMore, true);
  assert.equal(one.total, 26);
  assert.equal(one.totalPages, 2);
  assert.equal(two.items.length, 2);
  assert.equal(two.hasMore, false);
  assert.equal(past.items.length, 0);
  assert.equal(viewer.items.length, 26);
  assert.deepEqual(
    viewer.items.map((x) => x.id),
    [...one.items, ...two.items].map((x) => x.id)
  );
  const dto = viewer.items[0];
  assert.equal(dto.uploader.gameServer, 'Synthetic server');
  assert.equal(dto.originalName, 'synthetic-0.png');
  for (const key of ['phone', 'digest', 'mime', 'batchId', 'adminRole'])
    assert.equal(JSON.stringify(dto).includes('"' + key + '"'), false);
  assert.equal(h.mediaCalls.length, 0);
});
test('empty photos still return one total page; anonymous metadata denied', async () => {
  const h = harness(0),
    result = await h.service.photos(ids.album, url(''), ids.outsider);
  assert.equal(result.total, 0);
  assert.equal(result.totalPages, 1);
  await assert.rejects(h.service.viewerPhotos(ids.album, url('')), rejected(401));
});
test('rotation persists quarter turns, replays once, and preserves every original byte', async () => {
  const h = harness(1),
    p = h.state.photos[0],
    before = Buffer.from(h.stored.get(p.id)),
    body = rotate(p.id);
  const first = await h.service.mutatePhotos(ids.album, body, ids.uploader),
    again = await h.service.mutatePhotos(ids.album, body, ids.uploader);
  assert.equal(first.rotation, 90);
  assert.equal(again.replayed, true);
  assert.equal(h.state.photos[0].revision, 1);
  assert.equal((await h.service.photoDetail(p.id, ids.uploader)).rotation, 90);
  await h.service.mutatePhotos(ids.album, rotate(p.id, 1, 'left'), ids.uploader);
  assert.equal(h.state.photos[0].rotation, 0);
  assert.deepEqual((await h.service.readMedia(p.id, 'original', ids.uploader)).bytes, before);
  assert.deepEqual(h.stored.get(p.id), before);
});
test('album creator, outsider and administrator cannot rotate another uploader photo', async () => {
  for (const actor of [ids.owner, ids.outsider, ids.admin]) {
    const h = harness(1);
    await assert.rejects(
      h.service.mutatePhotos(ids.album, rotate(h.state.photos[0].id), actor),
      rejected(403)
    );
    assert.equal(h.state.photos[0].revision, 0);
    assert.equal(h.state.commands.length, 0);
  }
});
test('parallel stale-revision rotations have one winner; new key cannot reapply old revision', async () => {
  const h = harness(1),
    id = h.state.photos[0].id,
    results = await Promise.allSettled([
      h.service.mutatePhotos(ids.album, rotate(id), ids.uploader),
      h.service.mutatePhotos(ids.album, rotate(id), ids.uploader)
    ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  assert.equal(h.state.photos[0].rotation, 90);
});
test('same submission key with changed rotation payload is rejected', async () => {
  const h = harness(1),
    body = rotate(h.state.photos[0].id);
  await h.service.mutatePhotos(ids.album, body, ids.uploader);
  await assert.rejects(
    h.service.mutatePhotos(ids.album, { ...body, direction: 'left' }, ids.uploader),
    rejected(409)
  );
  assert.equal(h.state.photos[0].rotation, 90);
});
test('cross-page batch deletion only marks selected records, clears featured, and replays without extra audits', async () => {
  const h = harness(),
    rows = [h.state.photos[0], h.state.photos[25]],
    body = remove(rows);
  rows[0].featuredAt = new Date();
  const before = new Map([...h.stored].map(([id, b]) => [id, Buffer.from(b)]));
  const first = await h.service.mutatePhotos(ids.album, body, ids.uploader),
    again = await h.service.mutatePhotos(ids.album, body, ids.uploader);
  assert.equal(first.count, 2);
  assert.equal(again.replayed, true);
  assert.equal(h.state.photos.filter((p) => p.removedAt).length, 2);
  assert.equal(h.state.photos[0].featuredAt, null);
  assert.equal(h.state.audits.length, 2);
  assert.equal(h.state.photos.length, 26);
  assert.deepEqual(h.stored, before);
  await assert.rejects(h.service.photoDetail(rows[0].id, ids.uploader), rejected(404));
});
test('one foreign, missing, or stale selected photo rejects the complete batch without audit or command', async () => {
  for (const mode of ['foreign', 'missing', 'stale']) {
    const h = harness(2),
      body = remove(h.state.photos);
    if (mode === 'foreign') h.state.photos[1].uploaderId = ids.outsider;
    if (mode === 'missing') body.photos[1].id = uuid(999);
    if (mode === 'stale') body.photos[1].revision = 2;
    await assert.rejects(
      h.service.mutatePhotos(ids.album, body, ids.uploader),
      rejected(mode === 'foreign' ? 403 : mode === 'missing' ? 404 : 409)
    );
    assert.ok(h.state.photos.every((p) => !p.removedAt));
    assert.equal(h.state.audits.length, 0);
    assert.equal(h.state.commands.length, 0);
  }
});
test('ordinary deletion needs no reason but administrator governance requires reason and cannot fake SELF', async () => {
  const owner = harness(1),
    ordinary = remove(owner.state.photos, { intent: 'SELF' });
  await owner.service.mutatePhotos(ids.album, ordinary, ids.owner);
  assert.equal(owner.state.photos.filter((p) => p.removedAt).length, 1);
  assert.equal(owner.state.audits[0].reason, '相册创建者删除照片');
  assert.equal(owner.state.audits[0].action, 'PHOTO_REMOVED');
  assert.equal((await owner.service.mutatePhotos(ids.album, ordinary, ids.owner)).replayed, true);
  assert.equal(owner.state.audits.length, 1);
  const h = harness(1);
  for (const extra of [
    { intent: undefined },
    { intent: 'MODERATE' },
    { intent: 'SELF', reason: '不能伪造资格' }
  ]) {
    await assert.rejects(
      h.service.mutatePhotos(ids.album, remove(h.state.photos, extra), ids.admin),
      rejected(extra.intent === 'SELF' ? 403 : 400)
    );
    assert.equal(h.state.commands.length, 0);
    assert.equal(h.state.audits.length, 0);
    assert.equal(h.state.photos[0].removedAt, null);
  }
  const body = remove(h.state.photos, { intent: 'MODERATE', reason: 'Synthetic governance reason' });
  await h.service.mutatePhotos(ids.album, body, ids.admin);
  assert.equal(h.state.photos.filter((p) => p.removedAt).length, 1);
  assert.equal(h.state.audits[0].reason, 'Synthetic governance reason');
  assert.equal(h.state.audits[0].action, 'PHOTO_MODERATED');
  assert.equal((await h.service.mutatePhotos(ids.album, body, ids.admin)).replayed, true);
  assert.equal(h.state.audits.length, 1);
  const self = harness(1);
  self.state.photos[0].uploaderId = ids.admin;
  await self.service.mutatePhotos(ids.album, remove(self.state.photos, { intent: 'SELF' }), ids.admin);
  assert.equal(self.state.audits[0].action, 'PHOTO_REMOVED');
  assert.equal(self.state.audits[0].reason, '上传者删除本人照片');
  assert.equal(self.state.commands.length, 1);
  const outsider = harness(1);
  await assert.rejects(
    outsider.service.mutatePhotos(ids.album, remove(outsider.state.photos), ids.outsider),
    rejected(403)
  );
  assert.equal(outsider.state.audits.length, 0);
  assert.equal(outsider.state.commands.length, 0);
});
test('session expiry after command insertion rolls back content, audit and replay record together', async () => {
  const h = harness(1);
  h.expireAtFinalWrite();
  await assert.rejects(
    h.service.mutatePhotos(ids.album, rotate(h.state.photos[0].id), ids.uploader),
    rejected(401)
  );
  assert.equal(h.state.photos[0].rotation, 0);
  assert.equal(h.state.commands.length, 0);
});
test('comment attachment is owner-bound, album-bound, single-use, and supports an image-only comment', async () => {
  for (const mode of ['owner', 'album', 'used']) {
    const h = harness();
    const m = {
      id: uuid(800),
      ownerId: ids.outsider,
      albumId: ids.album,
      commentId: null,
      removedAt: null,
      position: 0
    };
    if (mode === 'owner') m.ownerId = ids.uploader;
    if (mode === 'album') m.albumId = ids.other;
    if (mode === 'used') m.commentId = uuid(900);
    h.state.media.push(m);
    await assert.rejects(
      h.service.comment(ids.album, commentBody({ body: '', mediaIds: [m.id] }), ids.outsider),
      rejected(403)
    );
    assert.equal(h.state.comments.length, 0);
    assert.equal(h.state.notifications.length, 0);
  }
  const h = harness(),
    m = {
      id: uuid(800),
      ownerId: ids.outsider,
      albumId: ids.album,
      commentId: null,
      removedAt: null,
      position: 0
    };
  h.state.media.push(m);
  const body = commentBody({ body: '', mediaIds: [m.id] }),
    result = await h.service.comment(ids.album, body, ids.outsider);
  assert.equal(h.state.media[0].commentId, result.id);
  assert.equal((await h.service.comment(ids.album, body, ids.outsider)).replayed, true);
  assert.equal(h.state.notifications.length, 1);
  assert.equal(h.state.notifications[0].recipientId, ids.owner);
});
test('nested comments preserve original recipients exactly and replay does not duplicate notification', async () => {
  const h = harness(),
    root = await h.service.comment(ids.album, commentBody(), ids.uploader),
    body = commentBody({
      parentId: root.id,
      body: '@' + person(ids.owner).displayName + ' synthetic',
      mentions: [ids.owner]
    });
  await h.service.comment(ids.album, body, ids.outsider);
  await h.service.comment(ids.album, body, ids.outsider);
  assert.deepEqual(
    h.state.notifications
      .slice(1)
      .map((n) => n.recipientId)
      .sort(),
    [ids.owner, ids.uploader].sort()
  );
  const list = await h.service.comments(ids.album, url('all=1'), ids.admin);
  assert.equal(list.items.length, 2);
  assert.equal(list.items[1].parentId, root.id);
  assert.equal(list.items[1].author.gameServer, 'Synthetic server');
  assert.equal(list.items[1].canDelete, false);
  assert.equal(list.items[1].canModerate, true);
});
test('removing one comment hides its whole branch and attachments while preserving sibling and physical data', async () => {
  const h = harness(),
    root = await h.service.comment(ids.album, commentBody(), ids.uploader),
    child = await h.service.comment(ids.album, commentBody({ parentId: root.id }), ids.outsider),
    sibling = await h.service.comment(ids.album, commentBody(), ids.outsider);
  h.state.media.push({
    id: uuid(800),
    ownerId: ids.outsider,
    albumId: ids.album,
    commentId: child.id,
    removedAt: null,
    position: 0
  });
  const body = { revision: 0, submissionKey: randomUUID(), intent: 'SELF' };
  await h.service.removeComment(root.id, body, ids.uploader);
  assert.equal((await h.service.removeComment(root.id, body, ids.uploader)).replayed, true);
  assert.deepEqual(
    (await h.service.comments(ids.album, url('all=1'), ids.outsider)).items.map((x) => x.id),
    [sibling.id]
  );
  assert.equal(h.state.comments.length, 3);
  assert.equal(h.state.media.length, 1);
  await assert.rejects(h.service.commentMedia(ids.album, uuid(800), 'preview', ids.outsider), rejected(404));
  await assert.rejects(
    h.service.comment(ids.album, commentBody({ parentId: child.id }), ids.outsider),
    rejected(400)
  );
});
test('comment governance still requires a reason; ordinary creator cannot remove another author comment', async () => {
  const h = harness(),
    c = await h.service.comment(ids.album, commentBody(), ids.uploader),
    body = { revision: 0, submissionKey: randomUUID() };
  await assert.rejects(h.service.removeComment(c.id, { ...body, intent: 'SELF' }, ids.owner), rejected(403));
  await assert.rejects(
    h.service.removeComment(c.id, { ...body, intent: 'MODERATE' }, ids.admin),
    rejected(400)
  );
  await h.service.removeComment(
    c.id,
    { ...body, intent: 'MODERATE', reason: 'Synthetic moderation reason' },
    ids.admin
  );
  assert.equal(h.state.audits[0].reason, 'Synthetic moderation reason');
});
test('unattached comment media is private to uploader and attached media stays internal', async () => {
  const h = harness();
  h.state.media.push({
    id: uuid(800),
    ownerId: ids.uploader,
    albumId: ids.album,
    commentId: null,
    removedAt: null
  });
  await assert.rejects(h.service.commentMedia(ids.album, uuid(800), 'preview', ids.outsider), rejected(404));
  assert.ok((await h.service.commentMedia(ids.album, uuid(800), 'preview', ids.uploader)).bytes);
  await assert.rejects(h.service.commentMedia(ids.album, uuid(800), 'preview'), rejected(401));
});

test('cross-page body parser accepts a large selection and rejects oversize or non-object bodies', async () => {
  const { readPhotoCommandBody } = await import('../../apps/web/server/albums/command-body.ts');
  const photos = Array.from({ length: 300 }, (_, i) => ({ id: uuid(10000 + i), revision: 0 })),
    body = JSON.stringify({ action: 'remove', photos, submissionKey: randomUUID() });
  assert.ok(body.length > 8192);
  assert.equal(
    (await readPhotoCommandBody(new Request('https://synthetic.invalid/', { method: 'PATCH', body }))).photos
      .length,
    300
  );
  await assert.rejects(
    readPhotoCommandBody(
      new Request('https://synthetic.invalid/', { method: 'PATCH', body: 'x'.repeat(1024 * 1024 + 1) })
    ),
    rejected(400)
  );
  await assert.rejects(
    readPhotoCommandBody(new Request('https://synthetic.invalid/', { method: 'PATCH', body: '[]' })),
    rejected(400)
  );
});
