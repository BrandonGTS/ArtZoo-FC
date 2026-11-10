// Production service with synthetic, read-only transaction spies. No env/database/storage access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AlbumService } from '../../apps/web/server/albums/service.ts';
const baseline = process.argv.includes('--baseline');
const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const actorId = id(1),
  creatorId = id(2),
  uploaderId = id(3),
  albumId = id(4);
const date = new Date('2026-10-01T00:00:00Z');
function harness(
  size,
  {
    role = 'NONE',
    publicity = 'INTERNAL',
    owner = actorId,
    liked = 'mixed',
    missingAccount = false,
    removedAlbum = false
  } = {}
) {
  const queries = [],
    authCalls = [],
    transactions = [];
  const person = {
    id: uploaderId,
    displayName: 'Synthetic',
    gameRegion: 'Synthetic',
    gameServer: 'Synthetic',
    membership: 'MEMBER',
    createdAt: date,
    profile: null
  };
  const album = {
    id: albumId,
    creatorId: owner,
    publicity,
    removedAt: removedAlbum ? date : null,
    activityId: null,
    seriesId: null
  };
  const rows = Array.from({ length: size }, (_, i) => ({
    id: id(100 + i),
    albumId,
    uploaderId: i % 2 ? actorId : uploaderId,
    uploader: person,
    createdAt: new Date(date.getTime() + i),
    description: 'Synthetic ' + i,
    originalName: 'synthetic.png',
    rotation: (i % 4) * 90,
    width: 480,
    height: 320,
    frames: (i % 2) + 1,
    periodActivityId: null,
    revision: i,
    featuredAt: i % 3 ? null : date,
    featuredPool: i % 3 ? null : 'SELECTED',
    featuredSelectedAt: i % 3 ? null : date,
    _count: { likes: i, comments: 2 * i },
    album
  }));
  const isLiked = (photoId) => liked === 'all' || (liked === 'mixed' && Number(photoId.slice(-12)) % 2 === 0);
  const tx = {
    album: { findUnique: async () => album },
    account: { findUnique: async () => (missingAccount ? null : { id: uploaderId }) },
    albumPhoto: {
      findMany: async ({ skip = 0, take = rows.length }) => rows.slice(skip, skip + take),
      count: async () => rows.length,
      findUnique: async () => ({ albumId }),
      findFirst: async ({ where }) => rows.find((r) => r.id === where.id) ?? null
    },
    albumLike: {
      findUnique: async ({ where }) => {
        queries.push({ type: 'one', where });
        const k = where.photoId_accountId;
        return k.accountId === actorId && isLiked(k.photoId) ? { photoId: k.photoId } : null;
      },
      findMany: async ({ where, select }) => {
        queries.push({ type: 'batch', where, select });
        assert.deepEqual(select, { photoId: true });
        assert.equal(where.accountId, actorId);
        return where.photoId.in.filter(isLiked).map((photoId) => ({ photoId }));
      }
    }
  };
  const transaction = async (fn, options) => {
    transactions.push(options);
    return fn(tx);
  };
  tx.$transaction = transaction;
  const auth = {
    db: tx,
    transaction,
    requireAccount: async (_, token) => {
      authCalls.push(token);
      if (token !== 'synthetic-session') throw Object.assign(Error('Unauthenticated'), { status: 401 });
      return { accountId: actorId, account: { adminRole: role } };
    }
  };
  const storage = {
    read() {
      throw Error('Unexpected media read');
    },
    put() {
      throw Error('Unexpected write');
    }
  };
  return {
    service: new AlbumService(auth, storage),
    queries,
    authCalls,
    transactions,
    rows,
    isLiked,
    tx,
    album,
    reset() {
      queries.length = 0;
      authCalls.length = 0;
      transactions.length = 0;
    }
  };
}
const url = new URL('https://synthetic.invalid/api/albums');
for (const endpoint of ['photos', 'memberPhotos', 'viewerPhotos'])
  for (const size of [0, 1, 6, 24, 25])
    test(endpoint + ' DTO and bounded like reads, source rows ' + size, async () => {
      for (const role of ['NONE', 'ADMIN', 'SUPER_ADMIN'])
        for (const publicity of ['INTERNAL', 'PUBLIC_FEATURED'])
          for (const liked of ['none', 'mixed', 'all']) {
            const h = harness(size, { role, publicity, liked });
            const count = endpoint === 'photos' ? 24 : endpoint === 'memberPhotos' ? 6 : size;
            // The unchanged single-photo projection is the exact serialized reference, including false likes.
            const expected = await Promise.all(
              h.rows
                .slice(0, count)
                .map((r) => h.service.photoView(h.tx, r, actorId, role, h.album.creatorId, publicity))
            );
            h.reset();
            const result = await h.service[endpoint](
              endpoint === 'memberPhotos' ? uploaderId : albumId,
              url,
              'synthetic-session'
            );
            assert.equal(JSON.stringify(result.items), JSON.stringify(expected));
            assert.equal(h.queries.length, baseline ? expected.length : expected.length ? 1 : 0);
            assert.equal(h.authCalls.length, 1);
            if (endpoint !== 'viewerPhotos') assert.equal(result.hasMore, size > count);
            if (endpoint === 'photos') {
              assert.equal(result.page, 1);
              assert.equal(result.total, size);
              assert.equal(result.totalPages, Math.max(1, Math.ceil(size / 24)));
              assert.equal(h.transactions[0].isolationLevel, 'RepeatableRead');
            }
          }
    });
test('representative query counts for 24-photo page and 6-photo member page', async (t) => {
  const measurements = [];
  for (const [endpoint, size] of [
    ['photos', 24],
    ['memberPhotos', 6],
    ['viewerPhotos', 1003]
  ]) {
    const h = harness(size);
    const result = await h.service[endpoint](
      endpoint === 'memberPhotos' ? uploaderId : albumId,
      url,
      'synthetic-session'
    );
    const expected = baseline ? result.items.length : Math.ceil(result.items.length / 500);
    assert.equal(h.queries.length, expected);
    assert.equal(h.queries.filter((q) => q.type === 'one').length, baseline ? size : 0);
    measurements.push({ endpoint, items: result.items.length, likeQueries: h.queries.length });
  }
  t.diagnostic(JSON.stringify({ mode: baseline ? 'baseline' : 'candidate', measurements }));
});
test('identity gate, missing account and removed album stop before like queries', async () => {
  for (const endpoint of ['photos', 'memberPhotos', 'viewerPhotos']) {
    const h = harness(24);
    await assert.rejects(
      h.service[endpoint](endpoint === 'memberPhotos' ? uploaderId : albumId, url),
      (e) => e.status === 401
    );
    assert.equal(h.queries.length, 0);
  }
  const missing = harness(6, { missingAccount: true });
  await assert.rejects(
    missing.service.memberPhotos(uploaderId, url, 'synthetic-session'),
    (e) => e.status === 404
  );
  assert.equal(missing.queries.length, 0);
  for (const endpoint of ['photos', 'viewerPhotos']) {
    const h = harness(6, { removedAlbum: true });
    await assert.rejects(h.service[endpoint](albumId, url, 'synthetic-session'), (e) => e.status === 404);
    assert.equal(h.queries.length, 0);
  }
});
test('single-photo detail keeps one lookup and original membership/role projection', async () => {
  const h = harness(1, { role: 'ADMIN', publicity: 'INTERNAL', owner: creatorId });
  const result = await h.service.photoDetail(h.rows[0].id, 'synthetic-session');
  assert.equal(h.queries.length, 1);
  assert.equal(h.queries[0].type, 'one');
  assert.equal(result.canFeature, false);
  assert.equal(result.canRemove, true);
  assert.equal(result.canSetCover, false);
});
