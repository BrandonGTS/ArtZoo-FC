// Production AlbumService, serialized rollback-capable synthetic transactions; no DB/env/user media.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { AlbumService } from '../../apps/web/server/albums/service.ts';
const req = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const bytes = await req('sharp')({ create: { width: 8, height: 6, channels: 3, background: '#234567' } })
  .png()
  .toBuffer();
const owner = randomUUID(),
  uploader = randomUUID(),
  stranger = randomUUID(),
  administrator = randomUUID();
const error = (status) => (e) => e.status === status;
function harness() {
  let state = { albums: [], photos: [], audits: [], commands: [] },
    tail = Promise.resolve(),
    failCreate = false;
  const match = (row, w = {}) =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'OR') return v.some((x) => match(row, x));
      if (v && typeof v === 'object') {
        if ('in' in v) return v.in.includes(row[k]);
        if ('not' in v) return row[k] !== v.not;
        if ('contains' in v) return (row[k] ?? '').includes(v.contains);
        return match(k === 'album' ? state.albums.find((a) => a.id === row.albumId) : row[k], v);
      }
      return row[k] === v;
    });
  const rows = (type, w) => state[type].filter((x) => match(x, w));
  const update = (row, data) => {
    for (const [k, v] of Object.entries(data))
      row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v;
    return row;
  };
  const album = (id) => {
    const a = state.albums.find((x) => x.id === id);
    return a
      ? {
          ...a,
          creator: { id: a.creatorId, displayName: 'Synthetic' },
          category: null,
          coverPhoto: state.photos.find((p) => p.id === a.coverPhotoId) ?? null,
          photos: rows('photos', { albumId: id, removedAt: null }).slice().reverse().slice(0, 1),
          _count: { photos: rows('photos', { albumId: id, removedAt: null }).length, comments: 0 }
        }
      : null;
  };
  const tx = {
    $queryRaw: async () => [],
    album: {
      findUnique: async ({ where }) => album(where.id),
      create: async ({ data }) => {
        const a = {
          id: randomUUID(),
          revision: 0,
          publicity: 'INTERNAL',
          coverPhotoId: null,
          activityId: null,
          seriesId: null,
          removedAt: null,
          uploadsClosed: false,
          categoryId: null,
          ...data
        };
        state.albums.push(a);
        return a;
      },
      update: async ({ where, data }) =>
        update(
          state.albums.find((a) => a.id === where.id),
          data
        )
    },
    albumPhoto: {
      findFirst: async ({ where }) => rows('photos', where)[0] ?? null,
      findUnique: async ({ where }) => {
        const p = where.id
          ? state.photos.find((p) => p.id === where.id)
          : rows('photos', where.albumId_uploaderId_batchId_batchIndex)[0];
        return p ? { ...p, album: album(p.albumId) } : null;
      },
      findMany: async ({ where }) => rows('photos', where),
      count: async ({ where }) => rows('photos', where).length,
      create: async ({ data }) => {
        if (failCreate) {
          failCreate = false;
          throw Error('Synthetic persistence failure');
        }
        const p = {
          removedAt: null,
          uploadAlbumId: null,
          revision: 0,
          featuredAt: null,
          featuredPool: null,
          featuredSelectedAt: null,
          rotation: 0,
          ...data
        };
        state.photos.push(p);
        return p;
      },
      update: async ({ where, data }) =>
        update(
          state.photos.find((p) => p.id === where.id),
          data
        ),
      updateMany: async ({ where, data }) => {
        const ps = rows('photos', where);
        ps.forEach((p) => update(p, data));
        return { count: ps.length };
      }
    },
    albumAudit: {
      findFirst: async ({ where }) => rows('audits', where)[0] ?? null,
      create: async ({ data }) => {
        const a = { id: randomUUID(), ...data };
        state.audits.push(a);
        return a;
      },
      createMany: async ({ data }) => state.audits.push(...data)
    },
    albumCommand: {
      findUnique: async ({ where }) => rows('commands', where.actorId_submissionKey)[0] ?? null,
      create: async ({ data }) => state.commands.push(data)
    }
  };
  const transaction = (fn) => {
    const p = tail.then(async () => {
      const before = structuredClone(state);
      try {
        return await fn(tx);
      } catch (e) {
        state = before;
        throw e;
      }
    });
    tail = p.catch(() => {});
    return p;
  };
  tx.$transaction = transaction;
  const auth = {
    now: () => new Date('2030-01-01'),
    transaction,
    db: tx,
    requireAccount: async (_, token) => {
      if (!token) throw Object.assign(Error('Synthetic unauthenticated'), { status: 401 });
      return {
        id: token,
        accountId: token,
        account: {
          phone: 'synthetic',
          membership: 'MEMBER',
          adminRole: token === administrator ? 'ADMIN' : 'NONE'
        }
      };
    }
  };
  const stored = new Map(),
    storage = {
      put: async (id, o) => stored.set(id, o),
      discardUncommitted: async (id) => stored.delete(id),
      read: async (id, k) => stored.get(id)[k]
    };
  const service = new AlbumService(auth, storage);
  const create = () =>
    service.create({ name: 'Synthetic', primary: 'DAILY', uploadMode: 'COMMUNITY' }, owner);
  const upload = (id, fields = { batchId: randomUUID(), batchIndex: 0 }, who = uploader) =>
    service.upload(id, fields, bytes, 'synthetic.png', who);
  return {
    service,
    create,
    upload,
    stored,
    get state() {
      return state;
    },
    failCreate() {
      failCreate = true;
    }
  };
}
test('new album first successful upload pins first photo, serialized concurrent uploads and replay never replace it', async () => {
  const h = harness(),
    a = await h.create(),
    fields = { batchId: randomUUID(), batchIndex: 0 };
  assert.equal(h.state.audits[0].action, 'ALBUM_CREATED_INITIAL_COVER');
  const [first, second] = await Promise.all([h.upload(a.id, fields), h.upload(a.id)]);
  assert.notEqual(first.id, second.id);
  const initialCover = h.state.albums[0].coverPhotoId;
  assert.ok([first.id, second.id].includes(initialCover));
  assert.equal(h.state.albums[0].revision, 1);
  assert.equal((await h.upload(a.id, fields)).replayed, true);
  assert.equal(h.state.photos.length, 2);
  assert.equal(h.stored.size, 2);
  assert.equal(h.state.albums[0].revision, 1);
  const manual = [first, second].find((p) => p.id !== initialCover);
  const body = {
    action: 'cover',
    photoId: manual.id,
    revision: 0,
    albumRevision: 1,
    submissionKey: randomUUID()
  };
  await h.service.mutatePhotos(a.id, body, owner);
  await h.upload(a.id);
  assert.equal(h.state.albums[0].coverPhotoId, manual.id);
  assert.equal(h.state.albums[0].revision, 2);
});
test('failed unauthorized/processing/persistence uploads do not consume first cover, and retry initializes once', async () => {
  const h = harness(),
    a = await h.create(),
    fields = { batchId: randomUUID(), batchIndex: 0 };
  h.state.albums[0].uploadMode = 'AUTHOR';
  await assert.rejects(h.upload(a.id, fields), error(403));
  h.state.albums[0].uploadMode = 'COMMUNITY';
  await assert.rejects(h.service.upload(a.id, fields, Buffer.from('bad'), 'bad.png', uploader));
  h.failCreate();
  await assert.rejects(h.upload(a.id, fields), /Synthetic persistence failure/);
  assert.equal(h.state.albums[0].coverPhotoId, null);
  assert.equal(h.state.photos.length, 0);
  assert.equal(h.stored.size, 0);
  const first = await h.upload(a.id, fields);
  assert.equal(h.state.albums[0].coverPhotoId, first.id);
  assert.equal((await h.upload(a.id, fields)).replayed, true);
});
test('legacy current fallback is frozen only on successful upload; legacy empty/removed/moved history never initializes as new', async () => {
  const h = harness(),
    a = await h.create();
  h.state.audits.length = 0;
  const first = await h.upload(a.id);
  assert.equal(h.state.albums[0].coverPhotoId, null);
  const before = await h.service.detail(a.id, uploader);
  assert.ok(before.cover.includes(first.id));
  assert.equal(h.state.albums[0].coverPhotoId, null);
  await h.upload(a.id);
  assert.equal(h.state.albums[0].coverPhotoId, first.id);
  assert.equal(h.state.albums[0].revision, 1);
  for (const mode of ['removed', 'moved']) {
    const x = harness(),
      b = await x.create(),
      p = await x.upload(b.id);
    x.state.albums[0].coverPhotoId = null;
    if (mode === 'removed') x.state.photos[0].removedAt = new Date();
    else {
      x.state.photos[0].uploadAlbumId = b.id;
      x.state.photos[0].albumId = randomUUID();
    }
    await x.upload(b.id);
    assert.equal(x.state.albums[0].coverPhotoId, null, mode);
  }
});
const remove = (photos, extra = {}) => ({
  action: 'remove',
  photos: photos.map((p) => ({ id: p.id, revision: p.revision })),
  submissionKey: randomUUID(),
  intent: 'SELF',
  ...extra
});
test('creator deletes without reason; admin moderation requires reason, preserves audit/replay and retains bytes', async () => {
  for (const actor of [owner, administrator]) {
    const h = harness(),
      a = await h.create(),
      p = await h.upload(a.id),
      q = await h.upload(a.id);
    const moderation =
      actor === administrator
        ? { intent: 'MODERATE', reason: 'Synthetic moderator photo removal' }
        : { intent: 'SELF' };
    if (actor === administrator) {
      const before = structuredClone(h.state);
      await assert.rejects(
        h.service.updatePhoto(p.id, { action: 'remove', revision: 0, intent: 'MODERATE' }, actor),
        error(400)
      );
      await assert.rejects(
        h.service.mutatePhotos(a.id, remove(h.state.photos, { intent: 'MODERATE' }), actor),
        error(400)
      );
      assert.deepEqual(h.state, before);
      assert.equal(h.stored.size, 2);
    }
    await h.service.updatePhoto(p.id, { action: 'remove', revision: 0, ...moderation }, actor);
    const body = remove([h.state.photos[1]], moderation);
    await h.service.mutatePhotos(a.id, body, actor);
    assert.equal((await h.service.mutatePhotos(a.id, body, actor)).replayed, true);
    assert.equal(h.state.photos.length, 2);
    assert.ok(h.state.photos.every((p) => p.removedAt));
    assert.equal(h.stored.size, 2);
    const audits = h.state.audits.filter((a) => a.photoId);
    assert.equal(audits.length, 2);
    assert.ok(
      audits.every(
        (a) =>
          a.reason === (actor === administrator ? 'Synthetic moderator photo removal' : '相册创建者删除照片')
      )
    );
  }
});
test('deletion keeps forbidden/stale/atomic checks and admin album moderation requires an audited explicit reason', async () => {
  const h = harness(),
    a = await h.create();
  await h.upload(a.id);
  await h.upload(a.id);
  await assert.rejects(
    h.service.updatePhoto(h.state.photos[0].id, { action: 'remove', revision: 0, intent: 'SELF' }, stranger),
    error(403)
  );
  await assert.rejects(h.service.mutatePhotos(a.id, remove(h.state.photos), stranger), error(403));
  await assert.rejects(
    h.service.mutatePhotos(a.id, remove([h.state.photos[0], { ...h.state.photos[1], revision: 9 }]), owner),
    error(409)
  );
  assert.ok(h.state.photos.every((p) => !p.removedAt));
  assert.equal(h.state.audits.length, 1);
  await assert.rejects(
    h.service.update(a.id, { action: 'remove', revision: 1, intent: 'SELF' }, owner),
    error(403)
  );
  await assert.rejects(
    h.service.update(a.id, { action: 'remove', revision: 0, intent: 'MODERATE', reason: 'r' }, administrator),
    error(409)
  );
  const before = structuredClone(h.state);
  await assert.rejects(
    h.service.update(a.id, { action: 'remove', revision: 1, intent: 'MODERATE' }, administrator),
    error(400)
  );
  assert.deepEqual(h.state, before);
  assert.equal(h.stored.size, 2);
  await h.service.update(
    a.id,
    { action: 'remove', revision: 1, intent: 'MODERATE', reason: 'Synthetic moderator album removal' },
    administrator
  );
  assert.equal(h.state.audits.at(-1).reason, 'Synthetic moderator album removal');
});
test('creator can delete own empty album; explicit public type and selected pool replace the legacy environment gate', async () => {
  const h = harness(),
    a = await h.create();
  await h.service.update(a.id, { action: 'remove', revision: 0, intent: 'SELF' }, owner);
  assert.equal(h.state.audits.at(-1).reason, '创建者删除本人相册');
  const x = harness(),
    b = await x.create(),
    p = await x.upload(b.id),
    publicUrl = new URL('http://qc21-synthetic.invalid/api/albums/featured');
  const prior = process.env.ARTZOO_ALBUM_UPLOAD_NOTICE;
  delete process.env.ARTZOO_ALBUM_UPLOAD_NOTICE;
  try {
    assert.equal(x.state.albums[0].publicity, 'INTERNAL');
    await assert.rejects(
      x.service.updatePhoto(p.id, { action: 'feature', revision: 0 }, administrator),
      (e) => e.status === 409 && e.message.includes('公开可见')
    );
    await assert.rejects(x.service.updatePhoto(p.id, { action: 'feature', revision: 0 }, owner), error(403));
    await assert.rejects(
      x.service.updatePhoto(p.id, { action: 'unfeature', revision: 0 }, administrator),
      error(400)
    );
    assert.equal(x.state.photos[0].revision, 0);
    assert.equal(x.state.photos[0].featuredAt, null);
    await x.service.update(
      b.id,
      {
        revision: 1,
        name: 'Synthetic',
        primary: 'DAILY',
        uploadMode: 'COMMUNITY',
        uploadsClosed: false,
        visibility: 'PUBLIC'
      },
      owner
    );
    await x.service.updatePhoto(p.id, { action: 'feature', revision: 0 }, administrator);
    assert.equal(x.state.photos[0].featuredPool, 'CANDIDATE');
    assert.equal((await x.service.featured(publicUrl)).items.length, 0);
    await assert.rejects(x.service.readMedia(p.id, 'preview'), error(404));
    await x.service.updatePhoto(
      p.id,
      { action: 'featured-pool', pool: 'SELECTED', revision: 1 },
      administrator
    );
    assert.equal((await x.service.featured(publicUrl)).items[0].id, p.id);
    assert.ok((await x.service.readMedia(p.id, 'thumbnail')).bytes.length);
    await assert.rejects(x.service.readMedia(p.id, 'original'), error(401));
    await x.service.updatePhoto(
      p.id,
      { action: 'unfeature', revision: 2, reason: 'Synthetic cancellation' },
      administrator
    );
    assert.equal(x.state.photos[0].featuredAt, null);
    assert.equal(x.state.photos[0].featuredPool, null);
    assert.equal(x.state.photos[0].featuredSelectedAt, null);
    assert.equal(x.state.photos[0].removedAt, null);
    assert.equal(x.stored.size, 1);
    assert.equal(x.state.audits.at(-1).reason, 'Synthetic cancellation');
    assert.equal((await x.service.featured(publicUrl)).items.length, 0);
    await assert.rejects(x.service.readMedia(p.id, 'preview'), error(404));
  } finally {
    if (prior === undefined) delete process.env.ARTZOO_ALBUM_UPLOAD_NOTICE;
    else process.env.ARTZOO_ALBUM_UPLOAD_NOTICE = prior;
  }
});
