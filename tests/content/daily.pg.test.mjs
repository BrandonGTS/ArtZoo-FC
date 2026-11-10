import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '../_shared/database.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { tokenDigest } from '../../apps/web/server/auth/crypto.ts';
import { unavailableSms, mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import { DailyService } from '../../apps/web/server/daily/service.ts';
import { LocalPhotoStorage } from '../../apps/web/server/media/photo-storage.ts';
const sharp = createRequire(new URL('../../apps/web/package.json', import.meta.url))('sharp');

test('日常：发布、评论、点赞、图片与管理（数据库）', async (t) => {
  const testDb = await createTestDatabase();
  const db = testDb.db;
  const sql = await testDb.pool.connect();
  const dir = mkdtempSync(join(tmpdir(), 'artzoo-daily-'));
  const check = (name, fn) => t.test(name, fn);
  try {
    // 4 个合成账号：0 成员、1 朋友、2 成员、3 管理员。
    const fixtureIds = [];
    for (let n = 0; n < 4; n++) {
      const accountId = randomUUID();
      fixtureIds.push(accountId);
      await sql.query(
        'INSERT INTO "Account" (id,phone,"passwordHash",membership,"adminRole","displayName","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)',
        [
          accountId,
          'synthetic-daily-' + n,
          'NONLOGIN-SYNTHETIC',
          n === 1 ? 'FRIEND' : 'MEMBER',
          n === 3 ? 'ADMIN' : 'NONE',
          ['云朵咕', '竹影清', '松果眠', '合成管理员'][n]
        ]
      );
    }
    const tokens = [],
      people = [];
    for (const accountId of fixtureIds) {
      people.push(await db.account.findUniqueOrThrow({ where: { id: accountId } }));
      const token = randomBytes(32).toString('base64url');
      await db.accountSession.create({
        data: { accountId, tokenHash: tokenDigest(token), expiresAt: new Date('2040-01-01') }
      });
      tokens.push(token);
    }
    const albumTables = (
      await sql.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'Album%' ORDER BY tablename"
      )
    ).rows.map((row) => row.tablename);
    const albumSnapshot = async () =>
      Promise.all(
        albumTables.map(async (table) => [
          table,
          (await sql.query('SELECT count(*)::text AS count FROM "' + table.replaceAll('"', '""') + '"'))
            .rows[0].count
        ])
      );
    const albumsBefore = await albumSnapshot();
    let now = new Date('2030-10-19T01:00:00Z');
    const auth = new AccountService(db, {
        phone: mainlandChinaPhone,
        sms: unavailableSms,
        environment: 'test',
        now: () => now
      }),
      storage = new LocalPhotoStorage(join(dir, 'original'), join(dir, 'derived')),
      service = new DailyService(auth, storage),
      url = new URL('http://localhost/daily');
    const body = (extra = {}) => ({
      body: '一起分享今天的日常',
      mentions: [],
      mediaIds: [],
      submissionKey: randomUUID(),
      ...extra
    });
    const command = (extra = {}) => ({ submissionKey: randomUUID(), ...extra });
    const u = async (fields = {}) =>
      service.upload({ batchId: randomUUID(), batchIndex: 0, ...fields }, image, 'synthetic.png', tokens[1]);
    const image = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#436b4e' } })
      .png()
      .toBuffer();
    let a, b, c, media;
    await check(
      'anonymous and invalid session cannot read internal posts/comments/media/notifications',
      async () => {
        await assert.rejects(service.list(url), (e) => e.status === 401);
        await assert.rejects(service.notifications(), (e) => e.status === 401);
        await assert.rejects(service.list(url, 'invalid'), (e) => e.status === 401);
      }
    );
    await check('member and friend create plain-text posts, concurrent retry exactly once', async () => {
      a = await service.create(body(), tokens[0]);
      now = new Date(now.getTime() + 1000);
      const input = body({ body: '朋友也可以发布' }),
        result = await Promise.all([service.create(input, tokens[1]), service.create(input, tokens[1])]);
      assert.equal(result[0].id, result[1].id);
      b = result[0];
      assert.equal(await db.dailyPost.count(), 2);
    });
    await check('create emits no broadcast and reused key with different payload conflicts', async () => {
      assert.equal(await db.dailyNotification.count(), 0);
      const input = body();
      const p = await service.create(input, tokens[0]);
      c = p;
      await assert.rejects(
        service.create({ ...input, body: 'different' }, tokens[0]),
        (e) => e.status === 409
      );
    });
    await check('author edit only; stale revision rejected; original timestamp remains stable', async () => {
      const post = await service.get(a.id, tokens[0]);
      await assert.rejects(
        service.update(a.id, { ...body(), revision: 0 }, tokens[1]),
        (e) => e.status === 403
      );
      now = new Date(now.getTime() + 1000);
      await service.update(a.id, { ...body({ body: '已修改的正文' }), revision: 0 }, tokens[0]);
      const edited = await service.get(a.id, tokens[1]);
      assert.ok(edited.editedAt);
      assert.equal(edited.createdAt, post.createdAt);
      await assert.rejects(
        service.update(a.id, { ...body(), revision: 0 }, tokens[0]),
        (e) => e.status === 409
      );
    });
    await check('sorted by original publication time and ID, not edit/comment/like', async () => {
      const expected = (await service.list(url, tokens[0])).items.map((x) => x.id);
      await service.comment(a.id, command({ body: '后来评论', mentions: [], parentId: null }), tokens[1]);
      await service.like(a.id, command({ liked: true }), tokens[1]);
      assert.deepEqual(
        (await service.list(url, tokens[0])).items.map((x) => x.id),
        expected
      );
      assert.equal(expected.at(-1), a.id);
    });
    await check('comment/reply/mentions recipients deduplicated, no self notices', async () => {
      const input = command({
          body: '@云朵咕 @松果眠 评论',
          mentions: [people[0].id, people[2].id],
          parentId: null
        }),
        comment = await service.comment(a.id, input, tokens[1]);
      await service.comment(a.id, input, tokens[1]);
      let notices = await db.dailyNotification.findMany({ where: { commentId: comment.id } });
      assert.equal(notices.length, 2);
      assert.deepEqual(new Set(notices.map((x) => x.recipientId)), new Set([people[0].id, people[2].id]));
      const reply = await service.comment(
        a.id,
        command({ body: '@竹影清 回复', mentions: [people[1].id], parentId: comment.id }),
        tokens[0]
      );
      notices = await db.dailyNotification.findMany({ where: { commentId: reply.id } });
      assert.equal(notices.length, 1);
      assert.equal(notices[0].recipientId, people[1].id);
    });
    await check(
      'post owner has no extra comment deletion right; commenter deletion hides its entire reply branch',
      async () => {
        const comment = await service.comment(
          a.id,
          command({ body: '要删除的评论', mentions: [], parentId: null }),
          tokens[1]
        );
        const reply = await service.comment(
          a.id,
          command({ body: '保留的回复', mentions: [], parentId: comment.id }),
          tokens[2]
        );
        await assert.rejects(
          service.removeComment(comment.id, command({ revision: 0 }), tokens[0]),
          (e) => e.status === 403
        );
        await service.removeComment(comment.id, command({ revision: 0 }), tokens[1]);
        const rows = (await service.comments(a.id, tokens[0])).items;
        assert.equal(
          rows.find((x) => x.id === comment.id),
          undefined
        );
        assert.equal(
          rows.find((x) => x.id === reply.id),
          undefined
        );
      }
    );
    await check('like/unlike set semantics and retries generate no notification', async () => {
      const n = await db.dailyNotification.count();
      await Promise.all([
        service.like(b.id, command({ liked: true }), tokens[0]),
        service.like(b.id, command({ liked: true }), tokens[0])
      ]);
      assert.equal(await db.dailyLike.count({ where: { postId: b.id } }), 1);
      await service.like(b.id, command({ liked: false }), tokens[0]);
      assert.equal(await db.dailyLike.count({ where: { postId: b.id } }), 0);
      assert.equal(await db.dailyNotification.count(), n);
    });
    await check('staged media private, original preserved and upload retry exactly once', async () => {
      const fields = { batchId: randomUUID(), batchIndex: 0 };
      const uploads = await Promise.all([
        service.upload(fields, image, 'synthetic.png', tokens[1]),
        service.upload(fields, image, 'synthetic.png', tokens[1])
      ]);
      media = uploads[0];
      assert.equal(uploads[0].id, uploads[1].id);
      assert.deepEqual((await service.media(media.id, 'original', tokens[1])).bytes, image);
      await assert.rejects(service.media(media.id, 'thumbnail', tokens[0]), (e) => e.status === 404);
      await assert.rejects(service.media(media.id, 'thumbnail'), (e) => e.status === 401);
      await assert.rejects(service.upload(fields, image, 'changed.png', tokens[1]), (e) => e.status === 409);
    });
    await check(
      'media ownership prevents theft; attached media available to registered friends',
      async () => {
        await assert.rejects(
          service.create(body({ mediaIds: [media.id] }), tokens[0]),
          (e) => e.status === 403
        );
        const post = await service.create(body({ body: '', mediaIds: [media.id] }), tokens[1]);
        assert.ok((await service.media(media.id, 'preview', tokens[0])).bytes.length);
        assert.equal((await service.get(post.id, tokens[0])).media[0].id, media.id);
        await assert.rejects(
          service.create(body({ mediaIds: [media.id] }), tokens[1]),
          (e) => e.status === 403
        );
      }
    );

    await check(
      'comment media image-only publishes a visible attachment with original bytes and one existing COMMENT notice',
      async () => {
        const upload = await u(),
          input = command({ body: '', mentions: [], parentId: null, mediaIds: [upload.id] });
        const noticeBefore = await db.dailyNotification.count(),
          result = await service.comment(a.id, input, tokens[1]);
        const row = await db.dailyMedia.findUniqueOrThrow({ where: { id: upload.id } });
        assert.equal(row.ownerId, people[1].id);
        assert.equal(row.postId, a.id);
        assert.equal(row.commentId, result.id);
        assert.equal(row.position, 0);
        const view = (await service.comments(a.id, tokens[0])).items.find((item) => item.id === result.id);
        assert.equal(view.body, '');
        assert.deepEqual(
          view.media.map((item) => item.id),
          [upload.id]
        );
        assert.deepEqual((await service.media(upload.id, 'original', tokens[0])).bytes, image);
        const notices = await db.dailyNotification.findMany({ where: { commentId: result.id } });
        assert.equal(await db.dailyNotification.count(), noticeBefore + 1);
        assert.equal(notices.length, 1);
        assert.equal(notices[0].kind, 'COMMENT');
        assert.equal(notices[0].recipientId, people[0].id);
      }
    );
    await check(
      'comment text plus images preserves order and deduplicates existing reply/mention recipients',
      async () => {
        const first = await u(),
          second = await u();
        const parent = await service.comment(
          a.id,
          command({ body: '附件回复父评论', mentions: [], parentId: null }),
          tokens[2]
        );
        const result = await service.comment(
          a.id,
          command({
            body: '@云朵咕 @松果眠 图片回复',
            mentions: [people[0].id, people[2].id],
            parentId: parent.id,
            mediaIds: [second.id, first.id]
          }),
          tokens[1]
        );
        const view = (await service.comments(a.id, tokens[0])).items.find((item) => item.id === result.id);
        assert.equal(view.body, '@云朵咕 @松果眠 图片回复');
        assert.equal(view.parentId, parent.id);
        assert.deepEqual(
          view.media.map((item) => item.id),
          [second.id, first.id]
        );
        const notices = await db.dailyNotification.findMany({ where: { commentId: result.id } });
        assert.deepEqual(
          new Set(notices.map((item) => item.recipientId)),
          new Set([people[0].id, people[2].id])
        );
        assert.ok(notices.every((item) => item.kind === 'COMMENT'));
      }
    );
    await check(
      'comment attachments reject foreign owner, removed media, missing media, and images already bound to either post',
      async () => {
        const foreign = await u(),
          removed = await u(),
          samePost = await u(),
          otherPost = await u();
        await db.dailyMedia.update({ where: { id: removed.id }, data: { removedAt: now } });
        const selfPost = await service.create(body({ mediaIds: [samePost.id] }), tokens[1]);
        const another = await service.create(body({ mediaIds: [otherPost.id] }), tokens[1]);
        const before = {
          comments: await db.dailyComment.count(),
          commands: await db.dailyCommand.count(),
          notices: await db.dailyNotification.count()
        };
        for (const [postId, mediaId, token] of [
          [a.id, foreign.id, tokens[0]],
          [a.id, removed.id, tokens[1]],
          [a.id, randomUUID(), tokens[1]],
          [selfPost.id, samePost.id, tokens[1]],
          [a.id, otherPost.id, tokens[1]]
        ]) {
          await assert.rejects(
            service.comment(
              postId,
              command({ body: '不可认领', mentions: [], parentId: null, mediaIds: [mediaId] }),
              token
            ),
            (error) => error.status === 403
          );
        }
        assert.deepEqual(
          {
            comments: await db.dailyComment.count(),
            commands: await db.dailyCommand.count(),
            notices: await db.dailyNotification.count()
          },
          before
        );
        assert.equal((await db.dailyMedia.findUniqueOrThrow({ where: { id: foreign.id } })).postId, null);
        assert.equal(
          (await db.dailyMedia.findUniqueOrThrow({ where: { id: otherPost.id } })).postId,
          another.id
        );
      }
    );
    await check(
      'comment media retry reuses the result and duplicate IDs or changed payload cannot claim twice',
      async () => {
        const upload = await u(),
          input = command({ body: '带图幂等', mentions: [], parentId: null, mediaIds: [upload.id] });
        const first = await service.comment(a.id, input, tokens[1]),
          before = { comments: await db.dailyComment.count(), notices: await db.dailyNotification.count() };
        const retry = await service.comment(a.id, input, tokens[1]);
        assert.equal(retry.id, first.id);
        assert.equal(retry.replayed, true);
        await assert.rejects(
          service.comment(a.id, { ...input, body: '同键改内容' }, tokens[1]),
          (error) => error.status === 409
        );
        await assert.rejects(
          service.comment(
            b.id,
            command({ body: '跨动态再用', mentions: [], parentId: null, mediaIds: [upload.id] }),
            tokens[1]
          ),
          (error) => error.status === 403
        );
        const staged = await u();
        await assert.rejects(
          service.comment(
            a.id,
            command({ body: '重复附件', mentions: [], parentId: null, mediaIds: [staged.id, staged.id] }),
            tokens[1]
          ),
          (error) => error.status === 400
        );
        assert.equal((await db.dailyMedia.findUniqueOrThrow({ where: { id: staged.id } })).commentId, null);
        assert.deepEqual(
          { comments: await db.dailyComment.count(), notices: await db.dailyNotification.count() },
          before
        );
      }
    );
    await check(
      'concurrent comments claiming one staged image produce exactly one winner and one existing notification',
      async () => {
        const upload = await u(),
          otherPost = await service.create(body({ body: '并发认领目标' }), tokens[0]),
          before = { comments: await db.dailyComment.count(), notices: await db.dailyNotification.count() };
        const results = await Promise.allSettled(
          [a.id, otherPost.id].map((postId) =>
            service.comment(
              postId,
              command({ body: '并发认领', mentions: [], parentId: null, mediaIds: [upload.id] }),
              tokens[1]
            )
          )
        );
        const fulfilled = results.filter((item) => item.status === 'fulfilled'),
          rejected = results.filter((item) => item.status === 'rejected');
        assert.equal(fulfilled.length, 1);
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].reason.status, 403);
        const row = await db.dailyMedia.findUniqueOrThrow({ where: { id: upload.id } });
        assert.equal(row.commentId, fulfilled[0].value.id);
        assert.equal(await db.dailyComment.count(), before.comments + 1);
        assert.equal(await db.dailyNotification.count(), before.notices + 1);
      }
    );
    await check(
      'deleting a comment hides its attachment in list and revokes all variants and its descendants while preserving original bytes',
      async () => {
        const upload = await u(),
          result = await service.comment(
            a.id,
            command({ body: '删除图片评论', mentions: [], parentId: null, mediaIds: [upload.id] }),
            tokens[1]
          );
        const reply = await service.comment(
          a.id,
          command({ body: '保留子回复', mentions: [], parentId: result.id }),
          tokens[2]
        );
        await service.removeComment(result.id, command({ revision: 0 }), tokens[1]);
        const rows = (await service.comments(a.id, tokens[0])).items,
          view = rows.find((item) => item.id === result.id);
        assert.equal(view, undefined);
        assert.equal(
          rows.find((item) => item.id === reply.id),
          undefined
        );
        for (const variant of ['original', 'preview', 'thumbnail'])
          await assert.rejects(service.media(upload.id, variant, tokens[1]), (error) => error.status === 404);
        assert.deepEqual(await storage.read(upload.id, 'original'), image);
      }
    );
    await check(
      'legacy post image stays separate from comment images and editing post never removes comment media',
      async () => {
        const postImage = await u(),
          commentImage = await u(),
          post = await service.create(body({ mediaIds: [postImage.id] }), tokens[1]);
        const comment = await service.comment(
          post.id,
          command({ body: '评论配图', mentions: [], parentId: null, mediaIds: [commentImage.id] }),
          tokens[1]
        );
        assert.deepEqual(
          (await service.get(post.id, tokens[0])).media.map((item) => item.id),
          [postImage.id]
        );
        await service.update(
          post.id,
          { ...body({ body: '保留动态配图', mediaIds: [postImage.id] }), revision: 0 },
          tokens[1]
        );
        assert.equal(
          (await db.dailyMedia.findUniqueOrThrow({ where: { id: commentImage.id } })).removedAt,
          null
        );
        await service.update(
          post.id,
          { ...body({ body: '只删除动态配图', mediaIds: [] }), revision: 1 },
          tokens[1]
        );
        const retained = await db.dailyMedia.findUniqueOrThrow({ where: { id: commentImage.id } });
        assert.equal(retained.removedAt, null);
        assert.equal(retained.commentId, comment.id);
        assert.equal(retained.postId, post.id);
        assert.deepEqual((await service.get(post.id, tokens[0])).media, []);
        assert.deepEqual(
          (await service.comments(post.id, tokens[0])).items[0].media.map((item) => item.id),
          [commentImage.id]
        );
        assert.ok((await service.media(commentImage.id, 'preview', tokens[0])).bytes.length);
        await assert.rejects(
          service.update(post.id, { ...body({ mediaIds: [commentImage.id] }), revision: 2 }, tokens[1]),
          (error) => error.status === 403
        );
      }
    );
    await check(
      'comment composite FK rejects cross-post linkage and CHECK forbids attachment with no owning post',
      async () => {
        const upload = await u(),
          comment = await service.comment(
            a.id,
            command({ body: 'FK父评论', mentions: [], parentId: null }),
            tokens[1]
          );
        await assert.rejects(
          sql.query('UPDATE "DailyMedia" SET "commentId"=$1,"postId"=$2 WHERE id=$3', [
            comment.id,
            b.id,
            upload.id
          ]),
          (error) => error.code === '23503' && error.constraint === 'DailyMedia_commentId_postId_fkey'
        );
        await assert.rejects(
          sql.query('UPDATE "DailyMedia" SET "commentId"=$1,"postId"=NULL WHERE id=$2', [
            comment.id,
            upload.id
          ]),
          (error) => error.code === '23514' && error.constraint === 'DailyMedia_comment_post_check'
        );
        const row = await db.dailyMedia.findUniqueOrThrow({ where: { id: upload.id } });
        assert.equal(row.commentId, null);
        assert.equal(row.postId, null);
      }
    );
    await check(
      'removed parent post revokes attached comment bytes without deleting the original',
      async () => {
        const upload = await u(),
          post = await service.create(body(), tokens[0]);
        await service.comment(
          post.id,
          command({ body: '随动态撤下', mentions: [], parentId: null, mediaIds: [upload.id] }),
          tokens[1]
        );
        await service.remove(post.id, command({ revision: 0 }), tokens[0]);
        await assert.rejects(service.media(upload.id, 'preview', tokens[1]), (error) => error.status === 404);
        await assert.rejects(service.comments(post.id, tokens[1]), (error) => error.status === 404);
        assert.deepEqual(await storage.read(upload.id, 'original'), image);
      }
    );
    await check(
      'moderating image comment revokes bytes, hides media and creates no additional notification kind',
      async () => {
        const upload = await u(),
          comment = await service.comment(
            a.id,
            command({ body: '合成违规图片评论', mentions: [], parentId: null, mediaIds: [upload.id] }),
            tokens[1]
          );
        const notices = await db.dailyNotification.count();
        await service.moderate(
          a.id,
          command({ commentId: comment.id, revision: 0, reason: '合成审核原因' }),
          tokens[3]
        );
        const row = (await service.comments(a.id, tokens[0])).items.find((item) => item.id === comment.id);
        assert.equal(row, undefined);
        await assert.rejects(
          service.media(upload.id, 'original', tokens[1]),
          (error) => error.status === 404
        );
        assert.equal(await db.dailyNotification.count(), notices);
        assert.ok(
          (await db.dailyNotification.findMany({ select: { kind: true } })).every((item) =>
            ['COMMENT', 'MENTION'].includes(item.kind)
          )
        );
      }
    );
    await check('batch bounds, file size, unsafe formats rejected without creating media', async () => {
      for (const batchIndex of [-1, 10, 0.5])
        await assert.rejects(u({ batchIndex }), (e) => e.status === 400);
      await assert.rejects(
        service.upload(
          { batchId: randomUUID(), batchIndex: 0 },
          Buffer.alloc(30 * 1024 * 1024 + 1),
          'too-big.png',
          tokens[0]
        ),
        (e) => e.status === 400
      );
      await assert.rejects(
        service.upload(
          { batchId: randomUUID(), batchIndex: 0 },
          Buffer.from('<svg/>'),
          'unsafe.svg',
          tokens[0]
        ),
        (e) => e.status === 400
      );
    });
    await check(
      'GIF animation frames/delays retained in thumbnails/previews, original identical',
      async () => {
        const pixels = Buffer.alloc(2 * 4 * 4 * 3);
        pixels.fill(30, 0, 48);
        pixels.fill(180, 48);
        const gif = await sharp(pixels, { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } })
          .gif({ delay: [100, 200], loop: 0 })
          .toBuffer();
        const m = await service.upload(
          { batchId: randomUUID(), batchIndex: 0 },
          gif,
          'animated.gif',
          tokens[1]
        );
        for (const variant of ['preview', 'thumbnail']) {
          const result = await service.media(m.id, variant, tokens[1]),
            meta = await sharp(result.bytes, { animated: true }).metadata();
          assert.equal(meta.pages, 2);
          assert.deepEqual(meta.delay, [100, 200]);
        }
        assert.deepEqual((await service.media(m.id, 'original', tokens[1])).bytes, gif);
      }
    );
    await check(
      'post mentions notify only targets, edit only newly mentioned IDs, no full-site broadcast',
      async () => {
        const n = await db.dailyNotification.count(),
          p = await service.create(body({ body: '@竹影清 分享', mentions: [people[1].id] }), tokens[0]);
        assert.equal(await db.dailyNotification.count(), n + 1);
        await service.update(
          p.id,
          { ...body({ body: '@竹影清 @松果眠 修改', mentions: [people[1].id, people[2].id] }), revision: 0 },
          tokens[0]
        );
        assert.equal(await db.dailyNotification.count(), n + 2);
        await assert.rejects(
          service.create(body({ body: '无提及文字', mentions: [people[1].id] }), tokens[0]),
          (e) => e.status === 400
        );
      }
    );
    await check(
      'same-name mentions validate server identity, prevent stale or fabricated recipient',
      async () => {
        const p = [];
        for (const server of ['甲区', '乙区'])
          p.push(
            await db.account.create({
              data: {
                phone: 'synthetic-name-' + randomUUID(),
                passwordHash: 'NONLOGIN',
                displayName: '同名',
                gameRegion: '合成大区',
                gameServer: server,
                membership: 'FRIEND'
              }
            })
          );
        const x = await service.comment(
          a.id,
          command({ body: '@同名（乙区） 你好', mentions: [p[1].id], parentId: null }),
          tokens[0]
        );
        assert.equal(
          (await db.dailyNotification.findFirst({ where: { commentId: x.id } })).recipientId,
          p[1].id
        );
        await assert.rejects(
          service.comment(
            a.id,
            command({ body: '@同名（乙区）', mentions: [p[0].id, p[1].id], parentId: null }),
            tokens[0]
          ),
          (e) => e.status === 400
        );
      }
    );
    await check('cross-post reply rejected and anonymous detail/comments protected', async () => {
      const comment = await service.comment(
        a.id,
        command({ body: '原评论', mentions: [], parentId: null }),
        tokens[0]
      );
      await assert.rejects(
        service.comment(b.id, command({ body: '跨动态回复', mentions: [], parentId: comment.id }), tokens[1]),
        (e) => e.status === 400
      );
      await assert.rejects(service.get(a.id), (e) => e.status === 401);
      await assert.rejects(service.comments(a.id), (e) => e.status === 401);
    });
    await check('cursor pagination stable through edits/comments and same-time posts', async () => {
      for (let i = 0; i < 13; i++) await service.create(body({ body: '分页 ' + i }), tokens[0]);
      const first = await service.list(url, tokens[0]);
      assert.equal(first.items.length, 10);
      assert.ok(first.next);
      await service.comment(a.id, command({ body: '不顶帖', mentions: [], parentId: null }), tokens[0]);
      const second = await service.list(new URL('http://localhost/?before=' + first.next), tokens[0]);
      assert.ok(!second.items.some((p) => first.items.some((q) => q.id === p.id)));
      const all = [...first.items, ...second.items];
      for (let i = 1; i < all.length; i++)
        assert.ok(
          all[i - 1].createdAt > all[i].createdAt ||
            (all[i - 1].createdAt === all[i].createdAt && all[i - 1].id > all[i].id)
        );
      const author = await service.list(new URL('http://localhost/?author=' + people[1].id), tokens[0]);
      assert.ok(author.items.every((x) => x.author.id === people[1].id));
    });
    await check(
      'admin moderation needs reason, records actor/time/reason, never edits as author',
      async () => {
        await assert.rejects(
          service.moderate(c.id, command({ revision: 0, reason: '' }), tokens[3]),
          (e) => e.status === 400
        );
        await assert.rejects(
          service.moderate(c.id, command({ revision: 0, reason: '理由' }), tokens[1]),
          (e) => e.status === 403
        );
        await assert.rejects(
          service.update(c.id, { ...body(), revision: 0 }, tokens[3]),
          (e) => e.status === 403
        );
        await service.moderate(c.id, command({ revision: 0, reason: '合成违规原因' }), tokens[3]);
        const audit = await db.dailyAudit.findFirst({ where: { postId: c.id } });
        assert.equal(audit.actorId, people[3].id);
        assert.equal(audit.reason, '合成违规原因');
        assert.ok(audit.createdAt);
        await assert.rejects(service.get(c.id, tokens[0]), (e) => e.status === 404);
      }
    );
    await check('moderation audit remains accessible after removal, admin only', async () => {
      await assert.rejects(service.audits(c.id, tokens[0]), (e) => e.status === 403);
      const audit = await service.audits(c.id, tokens[3]);
      assert.equal(audit.items[0].reason, '合成违规原因');
      assert.equal(audit.items[0].actor.id, people[3].id);
      assert.ok(!('phone' in audit.items[0].actor));
    });
    await check('only author removes post, media access revoked while bytes retained', async () => {
      const media = await u(),
        p = await service.create(body({ mediaIds: [media.id] }), tokens[1]);
      await assert.rejects(
        service.remove(p.id, command({ revision: 0 }), tokens[0]),
        (e) => e.status === 403
      );
      const remove = command({ revision: 0 });
      await service.remove(p.id, remove, tokens[1]);
      await service.remove(p.id, remove, tokens[1]);
      await assert.rejects(service.media(media.id, 'original', tokens[1]), (e) => e.status === 404);
      assert.deepEqual(await storage.read(media.id, 'original'), image);
      await assert.rejects(
        service.comment(p.id, command({ body: '不能评论', mentions: [], parentId: null }), tokens[0]),
        (e) => e.status === 404
      );
    });
    await check('revoked session during image processing cannot commit upload', async () => {
      const t = randomBytes(32).toString('base64url'),
        session = await db.accountSession.create({
          data: { accountId: people[2].id, tokenHash: tokenDigest(t), expiresAt: new Date('2040-01-01') }
        });
      let ready, release;
      const wait = new Promise((r) => (release = r)),
        entered = new Promise((r) => (ready = r)),
        delayed = {
          put: async (...args) => {
            await storage.put(...args);
            ready();
            await wait;
          },
          read: (...a) => storage.read(...a),
          discardUncommitted: (...a) => storage.discardUncommitted(...a)
        };
      const upload = new DailyService(auth, delayed).upload(
        { batchId: randomUUID(), batchIndex: 0 },
        image,
        'race.png',
        t
      );
      const reject = assert.rejects(upload, (e) => e.status === 401);
      await entered;
      await db.accountSession.update({ where: { id: session.id }, data: { revokedAt: now } });
      release();
      await reject;
    });
    await check('session expiry waiting for post lock rolls back comment and notices', async () => {
      const t = randomBytes(32).toString('base64url');
      await db.accountSession.create({
        data: {
          accountId: people[1].id,
          tokenHash: tokenDigest(t),
          expiresAt: new Date(now.getTime() + 1000)
        }
      });
      const count = await db.dailyComment.count(),
        notices = await db.dailyNotification.count();
      await sql.query('BEGIN');
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['daily-post:' + a.id]);
      const op = service.comment(a.id, command({ body: '过期会话', mentions: [], parentId: null }), t),
        rejection = assert.rejects(op, (e) => e.status === 401);
      await new Promise((r) => setTimeout(r, 150));
      now = new Date(now.getTime() + 2000);
      await sql.query('COMMIT');
      await rejection;
      assert.equal(await db.dailyComment.count(), count);
      assert.equal(await db.dailyNotification.count(), notices);
    });

    // B-QC04 uses only synthetic rows created in this new, strictly guarded database.
    const replyInput = (parentId, extra = {}) =>
      command({ body: '本批级联测试回复', mentions: [], parentId, ...extra });
    await check(
      'cascade closes all depths and authors, preserves siblings/cross-post rows, historical notices, media bytes and one root audit on replay',
      async () => {
        const post = await service.create(body(), tokens[0]),
          other = await service.create(body(), tokens[0]);
        const root = await service.comment(post.id, replyInput(null), tokens[1]),
          child = await service.comment(post.id, replyInput(root.id), tokens[2]);
        const upload = await u(),
          leaf = await service.comment(post.id, replyInput(child.id, { mediaIds: [upload.id] }), tokens[1]);
        const branch = await service.comment(post.id, replyInput(root.id), tokens[0]),
          sibling = await service.comment(post.id, replyInput(null), tokens[2]);
        const foreign = await service.comment(other.id, replyInput(null), tokens[1]);
        const before = {
            notices: await db.dailyNotification.findMany({ orderBy: { id: 'asc' } }),
            rows: await db.dailyComment.count()
          },
          input = command({ revision: 0 });
        await assert.rejects(
          service.removeComment(root.id, command({ revision: 0 }), tokens[0]),
          (e) => e.status === 403
        );
        await assert.rejects(
          service.removeComment(root.id, command({ revision: 1 }), tokens[1]),
          (e) => e.status === 409
        );
        await service.removeComment(root.id, input, tokens[1]);
        const retry = await service.removeComment(root.id, input, tokens[1]);
        assert.equal(retry.replayed, true);
        await assert.rejects(
          service.removeComment(root.id, { ...input, revision: 1 }, tokens[1]),
          (e) => e.status === 409
        );
        const ids = [root.id, child.id, leaf.id, branch.id],
          stored = await db.dailyComment.findMany({ where: { id: { in: ids } } });
        assert.equal(stored.length, 4);
        assert.ok(stored.every((c) => c.removedAt && c.revision === 1));
        assert.equal(new Set(stored.map((c) => c.removedAt.toISOString())).size, 1);
        assert.deepEqual(
          (await service.comments(post.id, tokens[0])).items.map((c) => c.id),
          [sibling.id]
        );
        assert.equal((await service.get(post.id, tokens[0])).comments, 1);
        assert.equal((await service.get(other.id, tokens[0])).comments, 1);
        assert.equal(
          (await db.dailyComment.findUniqueOrThrow({ where: { id: foreign.id } })).removedAt,
          null
        );
        assert.equal(await db.dailyComment.count(), before.rows);
        assert.deepEqual(await db.dailyNotification.findMany({ orderBy: { id: 'asc' } }), before.notices);
        assert.equal(await db.dailyAudit.count({ where: { postId: post.id } }), 1);
        const audit = await db.dailyAudit.findFirstOrThrow({ where: { postId: post.id } });
        assert.equal(audit.commentId, root.id);
        assert.equal(audit.actorId, people[1].id);
        for (const variant of ['original', 'preview', 'thumbnail'])
          await assert.rejects(service.media(upload.id, variant, tokens[0]), (e) => e.status === 404);
        assert.deepEqual(await storage.read(upload.id, 'original'), image);
        assert.equal((await db.dailyMedia.findUniqueOrThrow({ where: { id: upload.id } })).removedAt, null);
        await assert.rejects(
          service.comment(post.id, replyInput(leaf.id), tokens[2]),
          (e) => e.status === 400
        );
      }
    );
    await check(
      'admin cascade keeps mandatory reason and author-only endpoint, removes all descendants and audits only the authorized root',
      async () => {
        const post = await service.create(body(), tokens[0]),
          root = await service.comment(post.id, replyInput(null), tokens[1]);
        const child = await service.comment(post.id, replyInput(root.id), tokens[2]),
          leaf = await service.comment(post.id, replyInput(child.id), tokens[0]);
        const before = await db.dailyNotification.count();
        await assert.rejects(
          service.removeComment(root.id, command({ revision: 0 }), tokens[3]),
          (e) => e.status === 403
        );
        await assert.rejects(
          service.moderate(post.id, command({ commentId: root.id, revision: 0, reason: '' }), tokens[3]),
          (e) => e.status === 400
        );
        await assert.rejects(
          service.moderate(
            post.id,
            command({ commentId: root.id, revision: 0, reason: '本批原因' }),
            tokens[2]
          ),
          (e) => e.status === 403
        );
        const input = command({ commentId: root.id, revision: 0, reason: '本批合成整支审核原因' });
        await service.moderate(post.id, input, tokens[3]);
        await service.moderate(post.id, input, tokens[3]);
        assert.deepEqual((await service.comments(post.id, tokens[0])).items, []);
        assert.equal((await service.get(post.id, tokens[0])).comments, 0);
        assert.equal(
          await db.dailyComment.count({
            where: { id: { in: [root.id, child.id, leaf.id] }, removedAt: { not: null } }
          }),
          3
        );
        const audits = (await service.audits(post.id, tokens[3])).items;
        assert.equal(audits.length, 1);
        assert.equal(audits[0].commentId, root.id);
        assert.equal(audits[0].reason, input.reason);
        assert.equal(audits[0].actor.id, people[3].id);
        assert.equal(await db.dailyNotification.count(), before);
      }
    );
    await check(
      'legacy tombstone ancestry is hidden from list/count/media and new reply targets without any historical writes',
      async () => {
        const post = await service.create(body(), tokens[0]),
          root = await service.comment(post.id, replyInput(null), tokens[1]),
          upload = await u();
        const child = await service.comment(
          post.id,
          replyInput(root.id, { mediaIds: [upload.id] }),
          tokens[1]
        );
        await db.dailyComment.update({ where: { id: root.id }, data: { removedAt: now } });
        const snapshot = await db.dailyComment.findMany({
            where: { postId: post.id },
            orderBy: { id: 'asc' }
          }),
          notices = await db.dailyNotification.findMany({
            where: { postId: post.id },
            orderBy: { id: 'asc' }
          });
        assert.deepEqual((await service.comments(post.id, tokens[0])).items, []);
        assert.equal((await service.get(post.id, tokens[0])).comments, 0);
        let page = await service.list(url, tokens[0]),
          listed = page.items.find((p) => p.id === post.id);
        while (!listed && page.next) {
          page = await service.list(new URL('http://localhost/?before=' + page.next), tokens[0]);
          listed = page.items.find((p) => p.id === post.id);
        }
        assert.ok(listed);
        assert.equal(listed.comments, 0);
        await assert.rejects(service.media(upload.id, 'original', tokens[0]), (e) => e.status === 404);
        await assert.rejects(
          service.comment(post.id, replyInput(child.id), tokens[2]),
          (e) => e.status === 400
        );
        assert.deepEqual(
          await db.dailyComment.findMany({ where: { postId: post.id }, orderBy: { id: 'asc' } }),
          snapshot
        );
        assert.deepEqual(
          await db.dailyNotification.findMany({ where: { postId: post.id }, orderBy: { id: 'asc' } }),
          notices
        );
        assert.deepEqual(await storage.read(upload.id, 'original'), image);
      }
    );
    // Test-only transaction proxy pauses after an actual PostgreSQL write while the production post lock remains held.
    function pauseAfter(model, method) {
      let entered, release;
      const reached = new Promise((r) => (entered = r)),
        gate = new Promise((r) => (release = r));
      let first = true;
      const delayed = Object.create(auth);
      delayed.transaction = (fn) =>
        auth.transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(target, key) {
                if (key !== model) return Reflect.get(target, key);
                return new Proxy(target[key], {
                  get(delegate, operation) {
                    if (operation !== method) return Reflect.get(delegate, operation);
                    return async (args) => {
                      const result = await delegate[operation](args);
                      if (first) {
                        first = false;
                        entered();
                        await gate;
                      }
                      return result;
                    };
                  }
                });
              }
            })
          )
        );
      return { service: new DailyService(delayed, storage), reached, release };
    }
    async function awaitGate(gate) {
      let timer;
      try {
        await Promise.race([
          gate.reached,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('production write gate not reached')), 3000);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    async function awaitPostWait() {
      for (let i = 0; i < 100; i++) {
        const rows = (
          await sql.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted")
        ).rows;
        if (rows[0].n > 0) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail('competing operation must wait on the real production post lock');
    }
    await check(
      'concurrent child creation wins first and parent deletion subsequently includes the newly committed child',
      async () => {
        const post = await service.create(body(), tokens[0]),
          root = await service.comment(post.id, replyInput(null), tokens[1]),
          gate = pauseAfter('dailyComment', 'create');
        const creating = gate.service.comment(post.id, replyInput(root.id), tokens[2]);
        await awaitGate(gate);
        const deleting = service.removeComment(root.id, command({ revision: 0 }), tokens[1]);
        try {
          await awaitPostWait();
        } finally {
          gate.release();
        }
        const [child] = await Promise.all([creating, deleting]);
        assert.ok((await db.dailyComment.findUniqueOrThrow({ where: { id: child.id } })).removedAt);
        assert.deepEqual((await service.comments(post.id, tokens[0])).items, []);
        assert.equal((await service.get(post.id, tokens[0])).comments, 0);
      }
    );
    await check(
      'concurrent parent deletion wins first and the waiting child is rejected without content/media/command/notification writes',
      async () => {
        const post = await service.create(body(), tokens[0]),
          root = await service.comment(post.id, replyInput(null), tokens[1]),
          gate = pauseAfter('dailyComment', 'updateMany'),
          input = replyInput(root.id);
        const before = {
          comments: await db.dailyComment.count(),
          notices: await db.dailyNotification.count()
        };
        const deleting = gate.service.removeComment(root.id, command({ revision: 0 }), tokens[1]);
        await awaitGate(gate);
        const creating = service.comment(post.id, input, tokens[2]),
          rejection = assert.rejects(creating, (e) => e.status === 400);
        try {
          await awaitPostWait();
        } finally {
          gate.release();
        }
        await Promise.all([deleting, rejection]);
        assert.equal(await db.dailyComment.count(), before.comments);
        assert.equal(await db.dailyNotification.count(), before.notices);
        assert.equal(await db.dailyCommand.count({ where: { submissionKey: input.submissionKey } }), 0);
      }
    );
    await check(
      'session expiry after a cascade write rolls back the entire branch, revision and audit together',
      async () => {
        const post = await service.create(body(), tokens[0]),
          root = await service.comment(post.id, replyInput(null), tokens[1]);
        await service.comment(post.id, replyInput(root.id), tokens[2]);
        const token = randomBytes(32).toString('base64url');
        await db.accountSession.create({
          data: {
            accountId: people[1].id,
            tokenHash: tokenDigest(token),
            expiresAt: new Date(now.getTime() + 1000)
          }
        });
        const before = await db.dailyComment.findMany({ where: { postId: post.id }, orderBy: { id: 'asc' } }),
          gate = pauseAfter('dailyComment', 'updateMany'),
          input = command({ revision: 0 });
        const op = gate.service.removeComment(root.id, input, token),
          rejection = assert.rejects(op, (e) => e.status === 401);
        await awaitGate(gate);
        now = new Date(now.getTime() + 2000);
        gate.release();
        await rejection;
        assert.deepEqual(
          await db.dailyComment.findMany({ where: { postId: post.id }, orderBy: { id: 'asc' } }),
          before
        );
        assert.equal(await db.dailyAudit.count({ where: { postId: post.id } }), 0);
        assert.equal(await db.dailyCommand.count({ where: { submissionKey: input.submissionKey } }), 0);
      }
    );
    await check('daily assets/notifications do not create album or QQ/SMS outbox rows', async () => {
      assert.equal(await db.activityOutbox.count(), 0);
      assert.equal(await db.teamNotification.count(), 0);
      assert.deepEqual(await albumSnapshot(), albumsBefore);
    });

    await check('numbered pagination validates page and preserves empty one-page boundary', async () => {
      const empty = await service.list(
        new URL('http://localhost/daily?page=99&author=' + randomUUID()),
        tokens[0]
      );
      assert.equal(empty.page, 1);
      assert.equal(empty.totalPages, 1);
      assert.equal(empty.total, 0);
      assert.deepEqual(empty.items, []);
      for (const page of ['0', '-1', '1.2', 'abc', '9007199254740992', ''])
        await assert.rejects(
          service.list(new URL('http://localhost/daily?page=' + page), tokens[0]),
          (e) => e.status === 400
        );
      await assert.rejects(
        service.list(new URL('http://localhost/daily?page=1&before=cursor'), tokens[0]),
        (e) => e.status === 400
      );
    });
    await check(
      'numbered pages use ten original-time ordered posts with deterministic ties and no overlap',
      async () => {
        const account = await db.account.create({
          data: {
            phone: 'synthetic-pages-' + randomUUID(),
            passwordHash: 'NONLOGIN-SYNTHETIC',
            membership: 'MEMBER',
            displayName: '分页合成用户'
          }
        });
        const pageToken = randomBytes(32).toString('base64url');
        await db.accountSession.create({
          data: {
            accountId: account.id,
            tokenHash: tokenDigest(pageToken),
            expiresAt: new Date('2040-01-01')
          }
        });
        const pageURL = (n) => new URL('http://localhost/daily?page=' + n + '&author=' + account.id),
          created = [];
        for (let i = 0; i < 21; i++) {
          now = new Date(now.getTime() + 1000);
          created.push((await service.create(body({ body: '分页 ' + i }), pageToken)).id);
        }
        const expected = [...created].reverse(),
          pages = await Promise.all([1, 2, 3].map((n) => service.list(pageURL(n), pageToken)));
        assert.deepEqual(
          pages.map((p) => p.items.length),
          [10, 10, 1]
        );
        assert.deepEqual(
          pages.flatMap((p) => p.items.map((p) => p.id)),
          expected
        );
        assert.ok(pages.every((p) => p.total === 21 && p.totalPages === 3 && p.next === null));
        const oldest = await service.get(created[0], pageToken),
          before = (await service.list(pageURL(1), pageToken)).items.map((p) => p.id);
        await assert.rejects(
          service.update(oldest.id, { ...body(), revision: oldest.revision }, tokens[3]),
          (e) => e.status === 403
        );
        const adminView = await service.get(oldest.id, tokens[3]);
        assert.equal(adminView.canEdit, false);
        assert.equal(adminView.canModerate, true);
        now = new Date(now.getTime() + 1000);
        const editInput = { ...body({ body: '修改不置顶' }), revision: oldest.revision };
        const edits = await Promise.all([
          service.update(oldest.id, editInput, pageToken),
          service.update(oldest.id, editInput, pageToken)
        ]);
        assert.equal(edits[0].id, edits[1].id);
        assert.equal((await service.get(oldest.id, pageToken)).revision, oldest.revision + 1);
        assert.equal((await service.get(oldest.id, pageToken)).createdAt, oldest.createdAt);
        assert.deepEqual(
          (await service.list(pageURL(1), pageToken)).items.map((p) => p.id),
          before
        );
        const last = pages[2].items[0];
        await service.remove(last.id, command({ revision: oldest.revision + 1 }), pageToken);
        const clamped = await service.list(pageURL(3), pageToken);
        assert.equal(clamped.page, 2);
        assert.equal(clamped.totalPages, 2);
        assert.equal(clamped.total, 20);
        assert.equal(clamped.items.length, 10);
        const retryBody = body({ body: '分页并发发布' }),
          duplicates = await Promise.all([
            service.create(retryBody, pageToken),
            service.create(retryBody, pageToken)
          ]);
        assert.equal(duplicates[0].id, duplicates[1].id);
        const after = await service.list(pageURL(3), pageToken);
        assert.equal(after.total, 21);
        assert.equal(after.items.length, 1);
        const reads = await Promise.all([
          service.list(pageURL(1), pageToken),
          service.create(body({ body: '并发读写' }), pageToken)
        ]);
        assert.ok([21, 22].includes(reads[0].total));
        assert.equal(reads[0].items.length, 10);
        assert.equal(new Set(reads[0].items.map((p) => p.id)).size, 10);
        const tieTime = new Date('2035-01-01');
        await db.dailyPost.updateMany({
          where: { authorId: account.id, removedAt: null },
          data: { createdAt: tieTime }
        });
        const tied = await service.list(pageURL(1), pageToken),
          ordered = await db.dailyPost.findMany({
            where: { authorId: account.id, removedAt: null },
            orderBy: { id: 'desc' },
            take: 10,
            select: { id: true }
          });
        assert.deepEqual(
          tied.items.map((p) => p.id),
          ordered.map((p) => p.id)
        );
      }
    );
  } finally {
    sql.release();
    await testDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
