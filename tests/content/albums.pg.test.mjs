import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '../_shared/database.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { tokenDigest } from '../../apps/web/server/auth/crypto.ts';
import { unavailableSms, mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import { AlbumService } from '../../apps/web/server/albums/service.ts';
import { LocalPhotoStorage } from '../../apps/web/server/albums/storage.ts';
const sharp = createRequire(new URL('../../apps/web/package.json', import.meta.url))('sharp');

test('相册：创建、上传、权限、点赞与管理（数据库）', async (t) => {
  const testDb = await createTestDatabase();
  const db = testDb.db;
  const sql = await testDb.pool.connect();
  const dir = mkdtempSync(join(tmpdir(), 'artzoo-albums-'));
  const check = (name, fn) => t.test(name, fn);
  try {
    // 4 个合成账号（0 成员、1 朋友、2 成员、3 管理员）和一个已结束的合成活动。
    const tokens = [],
      ids = [];
    for (let i = 0; i < 4; i++) {
      const a = { id: randomUUID() };
      await sql.query(
        'INSERT INTO "Account" (id,phone,"passwordHash",membership,"adminRole","displayName","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)',
        [
          a.id,
          'synthetic-album-' + i,
          'NONLOGIN-SYNTHETIC',
          i === 1 ? 'FRIEND' : 'MEMBER',
          i === 3 ? 'ADMIN' : 'NONE',
          '合成人物' + i
        ]
      );
      ids.push(a.id);
      const token = randomBytes(32).toString('base64url');
      await db.accountSession.create({
        data: { accountId: a.id, tokenHash: tokenDigest(token), expiresAt: new Date('2035-01-01') }
      });
      tokens.push(token);
    }
    const activity = { id: randomUUID() };
    await sql.query(
      'INSERT INTO "Activity" (id,"organizerId","idempotencyKey","requestFingerprint",title,description,category,"startsAt","endsAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        activity.id,
        ids[0],
        randomUUID(),
        'synthetic',
        'Synthetic ended activity',
        'unchanged',
        'SOCIAL',
        new Date('2020-01-01'),
        new Date('2020-01-02')
      ]
    );
    async function registration(activityId, accountId, extra = {}) {
      const seat = await db.activitySeat.create({
        data: { activityId, position: await db.activitySeat.count({ where: { activityId } }), kind: 'ANY' }
      });
      return db.activityRegistration.create({ data: { activityId, accountId, seatId: seat.id, ...extra } });
    }
    const auth = new AccountService(db, {
        phone: mainlandChinaPhone,
        sms: unavailableSms,
        environment: 'test'
      }),
      service = new AlbumService(auth, new LocalPhotoStorage(join(dir, 'original'), join(dir, 'derived')));
    const u = new URL('http://localhost/albums'),
      image = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#456738' } })
        .png()
        .toBuffer();
    const make = (patch = {}) => ({
      name: '合成相册',
      description: '',
      primary: 'DAILY',
      uploadMode: 'AUTHOR',
      ...patch
    });
    let author, community, linked, photo;
    const gate = {};
    await check('anonymous denied internal album/category APIs', async () => {
      await assert.rejects(service.list(u), (e) => e.status === 401);
      await assert.rejects(service.categories(), (e) => e.status === 401);
    });
    await check('explicit upload mode, friend creation, empty configured dictionary', async () => {
      await assert.rejects(service.create(make({ uploadMode: undefined }), tokens[0]));
      author = await service.create(make(), tokens[1]);
      community = await service.create(make({ uploadMode: 'COMMUNITY' }), tokens[0]);
      assert.equal((await service.categories(tokens[0])).items.length, 0);
    });
    await check(
      'retired secondary dictionary rejects FRIEND and ADMIN writes; synthetic inactive fixture still blocks creation',
      async () => {
        const before = await db.albumCategory.findMany({ orderBy: { id: 'asc' } });
        for (const token of [tokens[1], tokens[3]])
          await assert.rejects(
            service.saveCategory({ primary: 'DAILY', label: '合成分类' }, token),
            (e) => e.status === 403
          );
        assert.deepEqual(await db.albumCategory.findMany({ orderBy: { id: 'asc' } }), before);
        const c = await db.albumCategory.create({
          data: { primary: 'DAILY', label: '合成分类', active: false }
        });
        await assert.rejects(service.create(make({ categoryId: c.id }), tokens[0]));
      }
    );
    await check('author-only rejects another user; every upload preserves original', async () => {
      const fields = { batchId: randomUUID(), batchIndex: 0 };
      await assert.rejects(
        service.upload(author.id, fields, image, 'synthetic.png', tokens[0]),
        (e) => e.status === 403
      );
      photo = await service.upload(author.id, fields, image, 'synthetic.png', tokens[1]);
      assert.deepEqual((await service.readMedia(photo.id, 'original', tokens[1])).bytes, image);
    });
    await check('idempotent retry does not duplicate photos or original files', async () => {
      const fields = { batchId: randomUUID(), batchIndex: 0 };
      const [a, b] = await Promise.all([
        service.upload(community.id, fields, image, 'same.png', tokens[1]),
        service.upload(community.id, fields, image, 'same.png', tokens[1])
      ]);
      assert.equal(a.id, b.id);
      assert.equal(await db.albumPhoto.count({ where: { albumId: community.id } }), 1);
    });
    await check('closed upload gate rechecked and author can reopen', async () => {
      const a = await service.detail(author.id, tokens[1]);
      await service.update(author.id, { ...a, categoryId: null, uploadsClosed: true }, tokens[1]);
      await assert.rejects(
        service.upload(author.id, { batchId: randomUUID(), batchIndex: 0 }, image, 'x.png', tokens[1]),
        (e) => e.status === 403
      );
      const b = await service.detail(author.id, tokens[1]);
      await service.update(author.id, { ...b, categoryId: null, uploadsClosed: false }, tokens[1]);
    });
    await check(
      'linked activity roster ignores attendance/end, rejects nonparticipants/withdrawn',
      async () => {
        linked = await service.create(
          make({ primary: 'GAME', activityId: activity.id, uploadMode: undefined }),
          tokens[0]
        );
        assert.equal(
          (await service.create(make({ primary: 'GAME', activityId: activity.id }), tokens[0])).id,
          linked.id
        );
        await assert.rejects(
          service.upload(linked.id, { batchId: randomUUID(), batchIndex: 0 }, image, 'x.png', tokens[0]),
          (e) => e.status === 403
        );
        const foreign = await db.activity.create({
          data: {
            organizerId: ids[2],
            idempotencyKey: randomUUID(),
            requestFingerprint: 'foreign',
            title: 'Foreign synthetic activity',
            description: '',
            category: 'SOCIAL',
            startsAt: new Date('2020-01-01'),
            endsAt: new Date('2020-01-02')
          }
        });
        await registration(foreign.id, ids[2]);
        await assert.rejects(
          service.upload(
            linked.id,
            { batchId: randomUUID(), batchIndex: 0, periodActivityId: foreign.id },
            image,
            'foreign.png',
            tokens[2]
          ),
          (e) => e.status === 400
        );
        await assert.rejects(
          service.photos(linked.id, new URL('http://localhost/?periodActivityId=' + foreign.id), tokens[2]),
          (e) => e.status === 400
        );
        const reg = await registration(activity.id, ids[1]);
        await service.upload(
          linked.id,
          { batchId: randomUUID(), batchIndex: 0 },
          image,
          'late.png',
          tokens[1]
        );
        await db.activityRegistration.update({
          where: { id: reg.id },
          data: { status: 'WITHDRAWN', exitedAt: new Date(), seatId: null, seatSnapshot: { kind: 'ANY' } }
        });
        await assert.rejects(
          service.upload(linked.id, { batchId: randomUUID(), batchIndex: 0 }, image, 'x.png', tokens[1]),
          (e) => e.status === 403
        );
      }
    );
    await check('activity lookup is opt-in and administrator cannot edit creator metadata', async () => {
      assert.equal((await service.forActivity(activity.id, tokens[0])).album.id, linked.id);
      const a = await service.detail(community.id, tokens[3]);
      assert.equal(a.canManage, false);
      await assert.rejects(
        service.update(community.id, { ...a, name: 'admin edit', categoryId: null }, tokens[3]),
        (e) => e.status === 403
      );
    });
    await check(
      'disabled category can be retained to close existing album, but never newly assigned',
      async () => {
        const c = await db.albumCategory.create({ data: { primary: 'DAILY', label: '合成停用历史分类' } }),
          a = await service.create(make({ categoryId: c.id }), tokens[0]);
        await db.albumCategory.update({ where: { id: c.id }, data: { active: false } });
        const view = await service.detail(a.id, tokens[0]);
        await service.update(a.id, { ...view, categoryId: c.id, uploadsClosed: true }, tokens[0]);
        assert.equal((await service.detail(a.id, tokens[0])).uploadsClosed, true);
        await assert.rejects(service.create(make({ categoryId: c.id }), tokens[0]), (e) => e.status === 400);
        const other = await service.detail(community.id, tokens[0]);
        await assert.rejects(
          service.update(community.id, { ...other, categoryId: c.id }, tokens[0]),
          (e) => e.status === 400
        );
      }
    );
    await check('long-term shares one album and auto-tag contract checks period belongs', async () => {
      const series = await db.activitySeries.create({
          data: { weekdays: [1], durationMinutes: 60, totalPeriods: 2 }
        }),
        periods = [];
      for (let n = 1; n <= 2; n++)
        periods.push(
          await db.activity.create({
            data: {
              organizerId: ids[0],
              idempotencyKey: randomUUID(),
              requestFingerprint: 's',
              title: 'Synthetic period ' + n,
              description: '',
              category: 'SOCIAL',
              mode: 'SERIES',
              seriesId: series.id,
              periodNumber: n,
              startsAt: new Date('2020-01-01'),
              endsAt: new Date('2020-01-02')
            }
          })
        );
      const a = await service.create(make({ primary: 'GAME', activityId: periods[1].id }), tokens[0]),
        b = await service.create(make({ primary: 'GAME', activityId: periods[0].id }), tokens[0]);
      assert.equal(a.id, b.id);
      await registration(periods[1].id, ids[1]);
      await assert.rejects(
        service.upload(
          a.id,
          { batchId: randomUUID(), batchIndex: 0, periodActivityId: activity.id },
          image,
          'wrong.png',
          tokens[1]
        )
      );
      const upload = await service.upload(
        a.id,
        { batchId: randomUUID(), batchIndex: 0, periodActivityId: periods[1].id },
        image,
        'period.png',
        tokens[1]
      );
      assert.equal(
        (await db.albumPhoto.findUnique({ where: { id: upload.id } })).periodActivityId,
        periods[1].id
      );
      await service.upload(a.id, { batchId: randomUUID(), batchIndex: 0 }, image, 'untagged.png', tokens[1]);
    });
    await check('author edits description/period only; other user denied and stale rejected', async () => {
      await assert.rejects(
        service.updatePhoto(
          photo.id,
          { action: 'edit', revision: 0, description: 'bad', periodActivityId: null },
          tokens[0]
        ),
        (e) => e.status === 403
      );
      await service.updatePhoto(
        photo.id,
        { action: 'edit', revision: 0, description: '本人说明', periodActivityId: null },
        tokens[1]
      );
      await assert.rejects(
        service.updatePhoto(photo.id, { action: 'edit', revision: 0, description: 'stale' }, tokens[1]),
        (e) => e.status === 409
      );
    });
    await check(
      'creator cannot delete whole album containing another uploader, even after soft removal',
      async () => {
        const d = await service.detail(community.id, tokens[0]);
        assert.equal(d.canDelete, false);
        await assert.rejects(
          service.update(community.id, { action: 'remove', revision: d.revision, intent: 'SELF' }, tokens[0]),
          (e) => e.status === 403
        );
      }
    );
    await check('comments notify owner/reply/mention once and never actor; retry once', async () => {
      const key = randomUUID(),
        body = {
          body: '@合成人物0 @合成人物2 合成评论',
          mentions: [ids[0], ids[2]],
          parentId: null,
          photoId: null,
          submissionKey: key
        };
      const c = await service.comment(community.id, body, tokens[1]);
      await service.comment(community.id, body, tokens[1]);
      assert.equal(await db.albumNotification.count({ where: { commentId: c.id } }), 2);
      assert.equal(await db.albumNotification.count({ where: { commentId: c.id, recipientId: ids[1] } }), 0);
      const r = await service.comment(
        community.id,
        {
          body: '@合成人物1 回复',
          mentions: [ids[1]],
          parentId: c.id,
          photoId: null,
          submissionKey: randomUUID()
        },
        tokens[0]
      );
      assert.equal(await db.albumNotification.count({ where: { commentId: r.id } }), 1);
      await assert.rejects(
        service.comment(author.id, { ...body, submissionKey: key }, tokens[1]),
        (e) => e.status === 409
      );
    });
    await check('photo comment routes to uploader; likes idempotent and no notification', async () => {
      const c = await service.comment(
        author.id,
        { body: '照片评论', mentions: [], parentId: null, photoId: photo.id, submissionKey: randomUUID() },
        tokens[0]
      );
      assert.equal(
        (await db.albumNotification.findMany({ where: { commentId: c.id } }))[0].recipientId,
        ids[1]
      );
      const before = await db.albumNotification.count();
      await Promise.all([
        service.like(photo.id, { liked: true }, tokens[0]),
        service.like(photo.id, { liked: true }, tokens[0])
      ]);
      assert.equal(await db.albumLike.count({ where: { photoId: photo.id } }), 1);
      assert.equal(await db.albumNotification.count(), before);
    });
    await check(
      'PUBLIC album selected derivatives only; member album and candidate stay private, original and album metadata require login',
      async () => {
        await assert.rejects(service.readMedia(photo.id, 'preview'));
        await assert.rejects(service.readMedia(photo.id, 'original'), (e) => e.status === 401);
        const before = await db.albumPhoto.findUniqueOrThrow({ where: { id: photo.id } });
        await assert.rejects(
          service.updatePhoto(photo.id, { action: 'feature', revision: 1 }, tokens[3]),
          (e) => e.status === 409
        );
        process.env.ARTZOO_ALBUM_UPLOAD_NOTICE = 'SYNTHETIC TEST NOTICE ONLY';
        await assert.rejects(
          service.updatePhoto(photo.id, { action: 'feature', revision: 1 }, tokens[3]),
          (e) => e.status === 409
        );
        assert.deepEqual(await db.albumPhoto.findUniqueOrThrow({ where: { id: photo.id } }), before);
        // Disposable isolated fixture only: PUBLIC maps to this one internal value; the old global notice grants no visibility.
        await db.album.update({ where: { id: author.id }, data: { publicity: 'PUBLIC_FEATURED' } });
        await service.updatePhoto(photo.id, { action: 'feature', revision: 1 }, tokens[3]);
        await assert.rejects(service.readMedia(photo.id, 'preview'), (e) => e.status === 404);
        assert.equal((await service.featured(u)).items.length, 0);
        await service.updatePhoto(
          photo.id,
          { action: 'featured-pool', pool: 'SELECTED', revision: 2 },
          tokens[3]
        );
        assert.ok((await service.readMedia(photo.id, 'preview')).bytes.length);
        await assert.rejects(service.readMedia(photo.id, 'preview', 'invalid'), (e) => e.status === 401);
        await assert.rejects(service.readMedia(photo.id, 'original'), (e) => e.status === 401);
        await assert.rejects(service.detail(author.id), (e) => e.status === 401);
        await assert.rejects(service.photos(author.id, u), (e) => e.status === 401);
        assert.equal((await service.featured(u)).items.length, 1);
        await assert.rejects(service.featured(u, tokens[0], true), (e) => e.status === 403);
      }
    );
    await check(
      'moderation requires reason and denies fake SELF, records reason actor/time and revokes media without deleting bytes',
      async () => {
        const before = await db.albumPhoto.findUniqueOrThrow({ where: { id: photo.id } }),
          audits = await db.albumAudit.count({ where: { photoId: photo.id } });
        await assert.rejects(
          service.updatePhoto(photo.id, { action: 'remove', revision: 3 }, tokens[2]),
          (e) => e.status === 403
        );
        await assert.rejects(
          service.updatePhoto(photo.id, { action: 'remove', revision: 3, intent: 'MODERATE' }, tokens[3]),
          (e) => e.status === 400
        );
        await assert.rejects(
          service.updatePhoto(photo.id, { action: 'remove', revision: 3, intent: 'SELF' }, tokens[3]),
          (e) => e.status === 403
        );
        assert.deepEqual(await db.albumPhoto.findUniqueOrThrow({ where: { id: photo.id } }), before);
        assert.equal(await db.albumAudit.count({ where: { photoId: photo.id } }), audits);
        const reason = '合成违规照片治理原因';
        await service.updatePhoto(
          photo.id,
          { action: 'remove', revision: 3, intent: 'MODERATE', reason },
          tokens[3]
        );
        await assert.rejects(service.readMedia(photo.id, 'original', tokens[1]));
        await assert.rejects(service.readMedia(photo.id, 'preview'));
        const a = await db.albumAudit.findFirst({ where: { photoId: photo.id, action: 'PHOTO_MODERATED' } });
        assert.equal(a.actorId, ids[3]);
        assert.equal(a.reason, reason);
        assert.ok(a.createdAt);
        assert.deepEqual(await service.storage.read(photo.id, 'original'), image);
      }
    );
    await check('all notifications remain local: no QQ or activity outbox', async () => {
      assert.equal(await db.activityOutbox.count(), 0);
    });

    await check('roster lock rechecks membership after a concurrent withdrawal', async () => {
      const reg = await registration(activity.id, ids[2]),
        gate = {};
      let release, entered;
      const wait = new Promise((r) => (release = r)),
        ready = new Promise((r) => (entered = r));
      const storage = {
        ...service.storage,
        put: async (...args) => {
          await service.storage.put(...args);
          entered();
          await wait;
        },
        read: (...args) => service.storage.read(...args),
        discardUncommitted: (...args) => service.storage.discardUncommitted(...args)
      };
      const upload = new AlbumService(auth, storage).upload(
        linked.id,
        { batchId: randomUUID(), batchIndex: 0 },
        image,
        'race.png',
        tokens[2]
      );
      await ready;
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'activity:' + activity.id},0))::text`;
        await tx.activityRegistration.update({
          where: { id: reg.id },
          data: { status: 'WITHDRAWN', exitedAt: new Date(), seatId: null, seatSnapshot: { kind: 'ANY' } }
        });
      });
      release();
      await assert.rejects(upload, (e) => e.status === 403);
    });
    await check('close gate wins while image is processing and session revocation is rechecked', async () => {
      const a = await service.detail(community.id, tokens[0]);
      let release, entered;
      const ready = new Promise((r) => (entered = r)),
        wait = new Promise((r) => (release = r)),
        storage = {
          put: async (...args) => {
            await service.storage.put(...args);
            entered();
            await wait;
          },
          read: (...args) => service.storage.read(...args),
          discardUncommitted: (...args) => service.storage.discardUncommitted(...args)
        };
      const upload = new AlbumService(auth, storage).upload(
        community.id,
        { batchId: randomUUID(), batchIndex: 0 },
        image,
        'close-race.png',
        tokens[1]
      );
      await ready;
      await service.update(community.id, { ...a, categoryId: null, uploadsClosed: true }, tokens[0]);
      release();
      await assert.rejects(upload, (e) => e.status === 403);
      const b = await service.detail(community.id, tokens[0]);
      await service.update(community.id, { ...b, categoryId: null, uploadsClosed: false }, tokens[0]);
      let release2, entered2;
      const ready2 = new Promise((r) => (entered2 = r)),
        wait2 = new Promise((r) => (release2 = r)),
        storage2 = {
          ...storage,
          put: async (...args) => {
            await service.storage.put(...args);
            entered2();
            await wait2;
          }
        };
      const upload2 = new AlbumService(auth, storage2).upload(
        community.id,
        { batchId: randomUUID(), batchIndex: 0 },
        image,
        'session-race.png',
        tokens[2]
      );
      await ready2;
      await db.accountSession.updateMany({ where: { accountId: ids[2] }, data: { revokedAt: new Date() } });
      release2();
      await assert.rejects(upload2, (e) => e.status === 401);
    });

    await check('session expiry while waiting for final album lock prevents write', async () => {
      let clock = new Date('2030-01-01T00:00:00Z');
      const token = randomBytes(32).toString('base64url');
      await db.accountSession.create({
        data: {
          accountId: ids[1],
          tokenHash: tokenDigest(token),
          expiresAt: new Date(clock.getTime() + 1000)
        }
      });
      const expiryAuth = new AccountService(db, {
          phone: mainlandChinaPhone,
          sms: unavailableSms,
          environment: 'test',
          now: () => clock
        }),
        expiryService = new AlbumService(expiryAuth, service.storage),
        a = await expiryService.detail(author.id, token);
      await sql.query('BEGIN');
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['album:' + author.id]);
      const update = expiryService.update(
        author.id,
        { ...a, name: 'must not commit', categoryId: null },
        token
      );
      const rejection = assert.rejects(update, (e) => e.status === 401);
      await new Promise((r) => setTimeout(r, 120));
      clock = new Date(clock.getTime() + 2000);
      await sql.query('COMMIT');
      await rejection;
      assert.notEqual((await db.album.findUnique({ where: { id: author.id } })).name, 'must not commit');
    });
    await check(
      'same-name mentions validate exact server identity and reject stale second recipient',
      async () => {
        const people = [];
        for (const server of ['合成甲区', '合成乙区'])
          people.push(
            await db.account.create({
              data: {
                phone: 'synthetic-duplicate-' + randomUUID(),
                passwordHash: 'NONLOGIN-SYNTHETIC',
                membership: 'FRIEND',
                displayName: '同名合成',
                gameRegion: '合成大区',
                gameServer: server
              }
            })
          );
        const body = {
          body: '@同名合成（合成乙区） 合成评论',
          mentions: [people[1].id],
          parentId: null,
          photoId: null,
          submissionKey: randomUUID()
        };
        const c = await service.comment(community.id, body, tokens[0]);
        const notices = await db.albumNotification.findMany({ where: { commentId: c.id } });
        assert.equal(notices.length, 1);
        assert.equal(notices[0].recipientId, people[1].id);
        await assert.rejects(
          service.comment(
            community.id,
            { ...body, mentions: people.map((p) => p.id), submissionKey: randomUUID() },
            tokens[0]
          ),
          (e) => e.status === 400
        );
      }
    );
    const relations = await sql.query(
      `SELECT conname FROM pg_constraint WHERE conname IN ('Album_activityId_fkey','Album_seriesId_fkey','AlbumPhoto_periodActivityId_fkey','AlbumNotification_commentId_fkey','AlbumNotification_albumId_fkey','AlbumNotification_photoId_fkey')`
    );
    assert.equal(relations.rowCount, 6);
  } finally {
    sql.release();
    await testDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
