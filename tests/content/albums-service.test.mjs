// Production AlbumService + rollback-capable synthetic transactions. No database or disk media.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AlbumService } from '../../apps/web/server/albums/service.ts';
import { PUBLIC_FEATURED_UPLOAD_NOTICE } from '../../apps/web/content/album-publicity.ts';
const owner = randomUUID(),
  uploader = randomUUID(),
  outsider = randomUUID(),
  admin = randomUUID(),
  superAdmin = randomUUID();
const status = (n) => (e) => e.status === n;
const url = (q = '') => new URL('http://synthetic.invalid/api/albums/featured' + q);
function harness() {
  let state = { albums: [], photos: [], audits: [] },
    tail = Promise.resolve(),
    roleOverride = null,
    reads = 0,
    afterRead = null,
    authCalls = 0,
    roleChangeAt = null;
  const match = (r, w = {}) =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'OR') return v.some((x) => match(r, x));
      if (v && typeof v === 'object') {
        if ('not' in v) return r[k] !== v.not;
        if ('contains' in v) return (r[k] ?? '').toLowerCase().includes(v.contains.toLowerCase());
        return match(k === 'album' ? state.albums.find((a) => a.id === r.albumId) : r[k], v);
      }
      return r[k] === v;
    });
  const update = (r, d) => {
    for (const [k, v] of Object.entries(d))
      r[k] = v && typeof v === 'object' && 'increment' in v ? r[k] + v.increment : v;
    return r;
  };
  const album = (id) => {
    const a = state.albums.find((a) => a.id === id);
    return a
      ? {
          ...a,
          creator: { id: a.creatorId, displayName: 'Synthetic' },
          category: null,
          coverPhoto: null,
          photos: [],
          _count: { photos: state.photos.filter((p) => p.albumId === id && !p.removedAt).length, comments: 0 }
        }
      : null;
  };
  const project = (p, select) => {
    const result = {
      ...p,
      album: album(p.albumId),
      uploader: {
        id: p.uploaderId,
        displayName: 'Synthetic',
        gameRegion: null,
        gameServer: null,
        membership: 'MEMBER',
        createdAt: new Date('2030-01-01'),
        profile: null
      },
      _count: { likes: 0, comments: 0 }
    };
    if (!select) return result;
    return Object.fromEntries(
      Object.entries(select)
        .filter(([, v]) => v)
        .map(([k]) => [k, result[k]])
    );
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
      findUnique: async ({ where, select }) => {
        const p = state.photos.find((p) => p.id === where.id);
        return p ? project(p, select) : null;
      },
      findFirst: async ({ where }) => {
        const p = state.photos.find((p) => match(p, where));
        return p ? project(p) : null;
      },
      findMany: async ({ where, select, orderBy = [], skip = 0, take = 999 }) =>
        state.photos
          .filter((p) => match(p, where))
          .sort((a, b) => {
            for (const term of orderBy) {
              const [k, dir] = Object.entries(term)[0],
                av = a[k],
                bv = b[k];
              if (av === bv || +av === +bv) continue;
              return (av > bv ? 1 : -1) * (dir === 'desc' ? -1 : 1);
            }
            return 0;
          })
          .slice(skip, skip + take)
          .map((p) => project(p, select)),
      count: async ({ where }) => state.photos.filter((p) => match(p, where)).length,
      update: async ({ where, data }) =>
        update(
          state.photos.find((p) => p.id === where.id),
          data
        )
    },
    albumCategory: { findMany: async () => [] },
    albumLike: { findUnique: async () => null },
    albumAudit: {
      create: async ({ data }) => {
        state.audits.push(data);
        return data;
      }
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
    transaction,
    db: tx,
    now: () => new Date('2030-01-01T00:00:00Z'),
    requireAccount: async (_, token) => {
      authCalls++;
      if (roleChangeAt === authCalls) roleOverride = 'NONE';
      if (![owner, uploader, outsider, admin, superAdmin].includes(token))
        throw Object.assign(Error('Unauthenticated'), { status: 401 });
      return {
        id: token,
        accountId: token,
        account: {
          phone: 'synthetic',
          membership: 'MEMBER',
          adminRole:
            roleOverride ?? (token === admin ? 'ADMIN' : token === superAdmin ? 'SUPER_ADMIN' : 'NONE')
        }
      };
    }
  };
  const stored = new Map(),
    storage = {
      read: async (id, variant) => {
        reads++;
        if (afterRead) {
          const fn = afterRead;
          afterRead = null;
          await fn();
        }
        return stored.get(id)?.[variant] ?? Buffer.from('synthetic');
      }
    };
  const service = new AlbumService(auth, storage);
  const create = (publicity) =>
    service.create(
      {
        name: 'Synthetic',
        primary: 'DAILY',
        uploadMode: 'COMMUNITY',
        ...(publicity
          ? {
              visibility:
                publicity === 'PUBLIC_FEATURED' ? 'PUBLIC' : publicity === 'INTERNAL' ? 'MEMBERS' : publicity
            }
          : {})
      },
      owner
    );
  const addPhoto = (albumId) => {
    const p = {
      id: randomUUID(),
      albumId,
      uploaderId: uploader,
      revision: 0,
      description: 'Synthetic',
      originalName: 'synthetic.png',
      mime: 'image/png',
      width: 8,
      height: 6,
      rotation: 0,
      frames: 1,
      periodActivityId: null,
      createdAt: new Date(),
      removedAt: null,
      featuredAt: null,
      featuredPool: null,
      featuredSelectedAt: null
    };
    state.photos.push(p);
    stored.set(p.id, {
      original: Buffer.from('original'),
      preview: Buffer.from('preview'),
      thumbnail: Buffer.from('thumbnail')
    });
    return p;
  };
  const edit = (a, publicity, actor = owner) =>
    service.update(
      a.id,
      {
        name: 'Synthetic',
        primary: 'DAILY',
        uploadMode: 'COMMUNITY',
        uploadsClosed: false,
        revision: state.albums.find((x) => x.id === a.id).revision,
        visibility:
          publicity === 'PUBLIC_FEATURED' ? 'PUBLIC' : publicity === 'INTERNAL' ? 'MEMBERS' : publicity
      },
      actor
    );
  const act = (p, action, extra = {}, actor = admin) =>
    service.updatePhoto(
      p.id,
      { revision: state.photos.find((x) => x.id === p.id).revision, action, ...extra },
      actor
    );
  return {
    service,
    create,
    addPhoto,
    edit,
    act,
    stored,
    get state() {
      return state;
    },
    get reads() {
      return reads;
    },
    afterRead(fn) {
      afterRead = fn;
    },
    setRole(role) {
      roleOverride = role;
    },
    demoteOnThirdAuth() {
      authCalls = 0;
      roleChangeAt = 3;
    }
  };
}
test('QC24 explicit publicity defaults INTERNAL, only creator changes it, notice is shipped independently of legacy env', async () => {
  const h = harness(),
    a = await h.create(),
    p = h.addPhoto(a.id);
  assert.equal((await h.service.detail(a.id, owner)).visibility, 'MEMBERS');
  for (const who of [outsider, admin, superAdmin])
    await assert.rejects(h.edit(a, 'PUBLIC_FEATURED', who), status(403));
  await assert.rejects(h.act(p, 'feature'), status(409));
  await h.edit(a, 'PUBLIC_FEATURED');
  const view = await h.service.detail(a.id, owner);
  assert.equal(view.publicity, undefined);
  assert.equal(view.visibility, 'PUBLIC');
  assert.equal((await h.service.categories(owner)).uploadNotice, PUBLIC_FEATURED_UPLOAD_NOTICE);
  assert.match(PUBLIC_FEATURED_UPLOAD_NOTICE, /访客可能保存/);
  assert.match(PUBLIC_FEATURED_UPLOAD_NOTICE, /无法追回/);
  await assert.rejects(h.create('__proto__'), status(400));
  assert.equal((await h.service.photoDetail(p.id, admin)).canFeature, true);
  assert.equal((await h.service.photoDetail(p.id, owner)).canFeature, false);
});
test('QC24 ADMIN/SUPER feature into candidate, reversible audited pools and cancellation preserve photo/media', async () => {
  const h = harness(),
    a = await h.create('PUBLIC_FEATURED'),
    p = h.addPhoto(a.id);
  for (const who of [owner, uploader, outsider])
    await assert.rejects(h.act(p, 'feature', {}, who), status(403));
  await h.act(p, 'feature', {}, superAdmin);
  assert.equal(h.state.photos[0].featuredPool, 'CANDIDATE');
  assert.equal((await h.service.featured(url())).items.length, 0);
  await assert.rejects(h.service.readMedia(p.id, 'preview'), status(404));
  assert.equal((await h.service.featured(url('?manage=1'), admin, true)).total, 1);
  await h.act(p, 'featured-pool', { pool: 'SELECTED' });
  assert.ok(h.state.photos[0].featuredSelectedAt);
  assert.equal((await h.service.featured(url())).items[0].id, p.id);
  for (const variant of ['preview', 'thumbnail'])
    assert.ok((await h.service.readMedia(p.id, variant)).bytes.length);
  await assert.rejects(h.service.readMedia(p.id, 'original'), status(401));
  await assert.rejects(h.service.readMedia(p.id, 'preview', 'expired'), status(401));
  await assert.rejects(h.service.readMedia(p.id, 'preview', ''), status(401));
  await assert.rejects(h.service.featured(url(), ''), status(401));
  await h.act(p, 'featured-pool', { pool: 'CANDIDATE' });
  await assert.rejects(h.service.readMedia(p.id, 'preview'), status(404));
  await h.act(p, 'featured-pool', { pool: 'SELECTED' });
  const before = structuredClone(h.state.photos[0]);
  await assert.rejects(h.act(p, 'unfeature', { reason: '' }), status(400));
  assert.deepEqual(h.state.photos[0], before);
  await h.act(p, 'unfeature', { reason: 'Synthetic cancellation' });
  assert.equal(h.state.photos.length, 1);
  assert.equal(h.stored.size, 1);
  assert.equal(h.state.photos[0].removedAt, null);
  assert.equal(h.state.photos[0].featuredAt, null);
  assert.equal(h.state.photos[0].featuredPool, null);
  assert.equal(h.state.audits.at(-1).reason, 'Synthetic cancellation');
  assert.deepEqual(
    h.state.audits.filter((a) => a.photoId).map((a) => a.action),
    [
      'PHOTO_FEATURED',
      'PHOTO_FEATURED_SELECTED',
      'PHOTO_FEATURED_CANDIDATE',
      'PHOTO_FEATURED_SELECTED',
      'PHOTO_UNFEATURED'
    ]
  );
  await assert.rejects(h.service.readMedia(p.id, 'thumbnail'), status(404));
});
test('QC24 management requires admin, preserves 24 pagination; public stable selected sorting excludes private/deleted', async () => {
  const h = harness(),
    a = await h.create('PUBLIC_FEATURED');
  const ps = Array.from({ length: 26 }, () => h.addPhoto(a.id));
  for (const p of ps) {
    await h.act(p, 'feature');
    await h.act(p, 'featured-pool', { pool: 'SELECTED' });
  }
  await assert.rejects(h.service.featured(url(), owner, true), status(403));
  await assert.rejects(h.service.featured(url(), null, true), status(401));
  const first = await h.service.featured(url()),
    second = await h.service.featured(url('?page=2'));
  assert.equal(first.total, 26);
  assert.equal(first.items.length, 24);
  assert.equal(first.hasMore, true);
  assert.equal(second.items.length, 2);
  assert.equal(first.totalPages, 2);
  const expected = ps
    .map((p) => p.id)
    .sort()
    .reverse();
  assert.deepEqual(
    [...first.items, ...second.items].map((p) => p.id),
    expected
  );
  assert.equal('uploader' in first.items[0], false);
  assert.equal('album' in first.items[0], false);
  await h.edit(a, 'INTERNAL');
  assert.equal((await h.service.featured(url())).items.length, 0);
  const managed = await h.service.featured(url('?pool=SELECTED'), admin, true);
  assert.equal(managed.total, 26);
  assert.equal(managed.items[0].album.visibility, 'MEMBERS');
  await assert.rejects(h.act(ps[0], 'featured-pool', { pool: 'CANDIDATE' }), status(409));
  await h.act(ps[0], 'unfeature', { reason: 'Private album cancellation' });
  await assert.rejects(h.service.readMedia(ps[1].id, 'preview'), status(404));
  assert.equal(h.state.photos[1].featuredPool, 'SELECTED');
});
test('QC24 concurrent stale pool commands serialize; private conversion races cannot expose, storage-time revocation rechecked', async () => {
  const h = harness(),
    a = await h.create('PUBLIC_FEATURED'),
    p = h.addPhoto(a.id);
  await h.act(p, 'feature');
  const commands = await Promise.allSettled([
    h.act(p, 'featured-pool', { pool: 'SELECTED' }),
    h.act(p, 'featured-pool', { pool: 'SELECTED' })
  ]);
  assert.equal(commands.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(commands.find((x) => x.status === 'rejected').reason.status, 409);
  h.afterRead(() => h.edit(a, 'INTERNAL'));
  await assert.rejects(h.service.readMedia(p.id, 'preview'), status(404));
  assert.equal((await h.service.featured(url())).total, 0);
  assert.equal(h.state.photos[0].featuredPool, 'SELECTED');
  await h.edit(a, 'PUBLIC_FEATURED');
  await h.act(p, 'featured-pool', { pool: 'CANDIDATE' });
  await Promise.allSettled([h.edit(a, 'INTERNAL'), h.act(p, 'featured-pool', { pool: 'SELECTED' })]);
  assert.equal((await h.service.featured(url())).total, 0);
  await assert.rejects(h.service.readMedia(p.id, 'preview'), status(404));
});
test('QC24 removed parents/photos and missing selected timestamp never authorize old anonymous URLs', async () => {
  const h = harness(),
    a = await h.create('PUBLIC_FEATURED'),
    p = h.addPhoto(a.id);
  await h.act(p, 'feature');
  await h.act(p, 'featured-pool', { pool: 'SELECTED' });
  h.state.photos[0].featuredSelectedAt = null;
  await assert.rejects(h.service.readMedia(p.id, 'preview'), status(404));
  assert.equal((await h.service.featured(url())).total, 0);
  h.state.photos[0].featuredSelectedAt = new Date();
  h.state.photos[0].removedAt = new Date();
  await assert.rejects(h.service.readMedia(p.id, 'thumbnail'), status(404));
  h.state.photos[0].removedAt = null;
  h.state.albums[0].removedAt = new Date();
  await assert.rejects(h.service.readMedia(p.id, 'preview'), status(404));
});

test('QC24 identity is checked again under album lock before a management write', async () => {
  const h = harness(),
    a = await h.create('PUBLIC_FEATURED'),
    p = h.addPhoto(a.id);
  h.demoteOnThirdAuth();
  await assert.rejects(h.act(p, 'feature'), status(403));
  assert.equal(h.state.photos[0].revision, 0);
  assert.equal(h.state.photos[0].featuredAt, null);
  assert.equal(h.state.audits.filter((a) => a.photoId).length, 0);
});

test('visibility is the only API setting; obsolete or contradictory publicity never writes', async () => {
  const h = harness(),
    a = await h.service.create({ name: 'Synthetic', primary: 'DAILY', uploadMode: 'COMMUNITY' }, owner);
  const before = structuredClone(h.state);
  for (const body of [
    { publicity: 'PUBLIC_FEATURED' },
    { visibility: 'MEMBERS', publicity: 'PUBLIC_FEATURED' },
    { visibility: 'INTERNAL' },
    { visibility: 'PUBLIC_FEATURED' },
    { visibility: null }
  ]) {
    await assert.rejects(
      h.service.create({ name: 'Synthetic', primary: 'DAILY', uploadMode: 'COMMUNITY', ...body }, owner),
      status(400)
    );
    await assert.rejects(
      h.service.update(
        a.id,
        {
          name: 'Synthetic',
          primary: 'DAILY',
          uploadMode: 'COMMUNITY',
          uploadsClosed: false,
          revision: 0,
          ...body
        },
        owner
      ),
      status(400)
    );
  }
  assert.deepEqual(h.state, before);
});
