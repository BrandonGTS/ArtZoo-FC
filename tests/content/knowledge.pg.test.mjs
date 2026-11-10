// 知识库：发布、编辑、协作、评论、通知与管理的数据库测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createTestDatabase } from '../_shared/database.mjs';
import { KNOWLEDGE_SECTIONS } from '../../apps/web/components/knowledge/category-options.ts';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { tokenDigest } from '../../apps/web/server/auth/crypto.ts';
import { mainlandChinaPhone, unavailableSms } from '../../apps/web/server/auth/ports.ts';
import { KnowledgeService } from '../../apps/web/server/knowledge/service.ts';
async function fixedCategorySnapshot(db) {
  return Object.fromEntries(
    await Promise.all(
      [
        'knowledgeCategory',
        'knowledgeArticle',
        'knowledgeVersion',
        'knowledgeContribution',
        'knowledgeComment',
        'knowledgeNotification',
        'knowledgeAudit',
        'knowledgeImage'
      ].map(async (model) => [
        model,
        await db[model].findMany({
          orderBy:
            model === 'knowledgeContribution' ? [{ articleId: 'asc' }, { accountId: 'asc' }] : { id: 'asc' }
        })
      ])
    )
  );
}

test('知识库：发布、编辑、协作、评论与管理（数据库）', async (t) => {
  const testDb = await createTestDatabase();
  const db = testDb.db,
    auth = new AccountService(db, { phone: mainlandChinaPhone, sms: unavailableSms, environment: 'test' }),
    service = new KnowledgeService(auth),
    tokens = [],
    ids = [];
  const check = (name, fn) => t.test(name, fn);
  const reject = (fn, code) => assert.rejects(fn, (e) => e.code === code);
  let cat, a, initialVersion, authorVersion, commentId;
  const meta = (body = '正文第一版', mode = 'COMMUNITY') => ({
    title: '练习笔记',
    body,
    categoryId: cat.id,
    jobs: ['白魔法师'],
    playstyles: ['练习'],
    gameVersions: ['7.x'],
    editMode: mode,
    submissionKey: randomUUID()
  });
  const edit = async (body, token = tokens[0], extra = {}) => {
    const row = await service.detail(a.id, token);
    return service.edit(
      a.id,
      {
        title: row.title,
        categoryId: row.category.id,
        jobs: row.jobs,
        playstyles: row.playstyles,
        gameVersions: row.gameVersions,
        editMode: row.editMode,
        body,
        expectedRevision: row.revision,
        ...extra
      },
      token
    );
  };
  try {
    for (let i = 0; i < 5; i++) {
      const account = await db.account.create({
        data: {
          phone: 'knowledge-synthetic-' + randomUUID(),
          passwordHash: 'NONLOGIN-ISOLATED',
          displayName: ['作者', '朋友', '管理员', '旁观者', '同名'][i],
          gameRegion: '陆行鸟',
          gameServer: '拉诺西亚',
          membership: i === 1 ? 'FRIEND' : 'MEMBER',
          adminRole: i === 2 ? 'ADMIN' : 'NONE'
        }
      });
      ids.push(account.id);
      const token = randomBytes(32).toString('base64url');
      tokens.push(token);
      await db.accountSession.create({
        data: {
          accountId: account.id,
          tokenHash: tokenDigest(token),
          expiresAt: new Date(Date.now() + 3600000)
        }
      });
    }
    await check('anonymous cannot list/detail/categories/create', async () => {
      for (const run of [
        () => service.list(new URL('http://test')),
        () => service.categories(),
        () => service.detail(randomUUID()),
        () => service.create({})
      ])
        await assert.rejects(run);
    });
    await check(
      'fixed category writes reject for member and admin without business changes; isolated fixture supplies existing section',
      async () => {
        const before = await fixedCategorySnapshot(db);
        for (const token of [tokens[0], tokens[2]])
          for (const body of [
            { label: '经验', active: true },
            { id: randomUUID(), label: '改名', active: true, expectedRevision: 9 }
          ])
            await reject(() => service.saveCategory(body, token), 'FORBIDDEN');
        assert.deepEqual(await fixedCategorySnapshot(db), before);
        cat = await db.knowledgeCategory.upsert({
          where: { label: KNOWLEDGE_SECTIONS[0] },
          create: { label: KNOWLEDGE_SECTIONS[0] },
          update: {}
        });
      }
    );
    await check('friend can publish with replay protection and private data absent', async () => {
      const input = meta();
      const created = await service.create(input, tokens[1]);
      assert.equal((await service.create(input, tokens[1])).replayed, true);
      await reject(() => service.create({ ...input, body: '不一致' }, tokens[1]), 'CONFLICT');
      const view = await service.detail(created.id, tokens[0]);
      assert.equal(view.author.id, ids[1]);
      assert.ok(!JSON.stringify(view).includes('password'));
      assert.ok(!JSON.stringify(view).includes('phone'));
    });
    await check('create atomically records initial body and one contribution', async () => {
      a = await service.create(meta(), tokens[0]);
      const versions = await service.history(a.id, new URL('http://test'), tokens[0]);
      assert.equal(versions.items.length, 1);
      initialVersion = versions.items[0];
      assert.equal(await db.knowledgeContribution.count({ where: { articleId: a.id } }), 1);
    });
    await check(
      'only author edits apply and no-op retains version count; synthetic legacy contribution keeps permanent protection',
      async () => {
        for (const actor of [1, 2, 3]) {
          const before = await fixedCategorySnapshot(db);
          await reject(() => edit('非作者不得保存', tokens[actor]), 'FORBIDDEN');
          assert.deepEqual(await fixedCategorySnapshot(db), before);
        }
        await edit('朋友正文', tokens[0]);
        assert.equal((await service.detail(a.id, tokens[0])).body, '朋友正文');
        assert.equal(await db.knowledgeVersion.count({ where: { articleId: a.id } }), 2);
        // Synthetic historical contribution predates author-only ordinary editing; never grant current PATCH permission.
        await db.knowledgeContribution.create({ data: { articleId: a.id, accountId: ids[1] } });
        const row = await service.detail(a.id, tokens[0]);
        assert.equal(row.hasOtherContributions, true);
        assert.equal(row.canDelete, false);
        authorVersion = (await service.history(a.id, new URL('http://test'), tokens[0])).items[0];
        assert.equal(authorVersion.editorId, ids[0]);
        await edit('朋友正文', tokens[0]);
        assert.equal(await db.knowledgeVersion.count({ where: { articleId: a.id } }), 2);
      }
    );
    await check(
      'non-author cannot history restore metadata edit or delete in any mode; legacy deletion protection persists',
      async () => {
        await reject(() => service.history(a.id, new URL('http://test'), tokens[1]), 'FORBIDDEN');
        await reject(
          () => service.restore(a.id, { versionId: initialVersion.id, expectedRevision: 1 }, tokens[1]),
          'FORBIDDEN'
        );
        const before = await fixedCategorySnapshot(db);
        await reject(() => edit('恶意', tokens[1], { editMode: 'AUTHOR' }), 'FORBIDDEN');
        assert.deepEqual(await fixedCategorySnapshot(db), before);
        await reject(() => service.remove(a.id, { expectedRevision: 1 }, tokens[1]), 'FORBIDDEN');
        const input = meta('朋友正文', 'AUTHOR');
        delete input.submissionKey;
        await edit(input.body, tokens[0], input);
        const closed = await fixedCategorySnapshot(db);
        await reject(() => edit('关闭后覆盖', tokens[1]), 'FORBIDDEN');
        assert.deepEqual(await fixedCategorySnapshot(db), closed);
        const protectedRevision = (await service.detail(a.id, tokens[0])).revision;
        await reject(
          () => service.remove(a.id, { expectedRevision: protectedRevision }, tokens[0]),
          'FORBIDDEN'
        );
      }
    );
    await check(
      'restore changes real body only; current permissions/tags and permanent protection persist',
      async () => {
        let row = await service.detail(a.id, tokens[0]);
        await service.restore(
          a.id,
          { versionId: initialVersion.id, expectedRevision: row.revision },
          tokens[0]
        );
        row = await service.detail(a.id, tokens[0]);
        assert.equal(row.body, '正文第一版');
        assert.equal(row.editMode, 'AUTHOR');
        assert.deepEqual(row.jobs, ['白魔法师']);
        assert.equal(row.hasOtherContributions, true);
        assert.equal(row.canDelete, false);
        assert.equal(await db.knowledgeVersion.count({ where: { articleId: a.id } }), 3);
        await reject(() => service.remove(a.id, { expectedRevision: row.revision }, tokens[0]), 'FORBIDDEN');
        await reject(
          () => service.restore(a.id, { versionId: authorVersion.id, expectedRevision: 0 }, tokens[0]),
          'CONFLICT'
        );
      }
    );
    await check('concurrent same-revision author requests never overwrite each other', async () => {
      const input = meta('重新开放');
      delete input.submissionKey;
      await edit(input.body, tokens[0], input);
      const row = await service.detail(a.id, tokens[0]);
      const results = await Promise.allSettled(
        [1, 3].map((i) =>
          service.edit(a.id, { ...input, body: '并发正文' + i, expectedRevision: row.revision }, tokens[0])
        )
      );
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'CONFLICT').length, 1);
    });
    await check(
      'author mode switch racing non-author edit serializes and preserves historical contribution protection',
      async () => {
        const row = await service.detail(a.id, tokens[0]);
        const input = meta(row.body, 'AUTHOR');
        delete input.submissionKey;
        const results = await Promise.allSettled([
          service.edit(a.id, { ...input, expectedRevision: row.revision }, tokens[0]),
          service.edit(a.id, { ...input, body: '竞态贡献', expectedRevision: row.revision }, tokens[1])
        ]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(results[0].status, 'fulfilled');
        assert.equal(results[1].status, 'rejected');
        assert.ok(['FORBIDDEN', 'CONFLICT'].includes(results[1].reason.code));
        assert.equal((await service.detail(a.id, tokens[0])).body, row.body);
        assert.equal(
          await db.knowledgeContribution.count({ where: { articleId: a.id, accountId: ids[1] } }),
          1
        );
      }
    );
    await check(
      'metadata-only save makes no body version; unknown public/HTML API fields rejected',
      async () => {
        const row = await service.detail(a.id, tokens[0]),
          count = await db.knowledgeVersion.count({ where: { articleId: a.id } }),
          input = meta(row.body, 'AUTHOR');
        delete input.submissionKey;
        input.title = '新标题笔记';
        await service.edit(a.id, { ...input, expectedRevision: row.revision }, tokens[0]);
        assert.equal(await db.knowledgeVersion.count({ where: { articleId: a.id } }), count);
        await reject(() => service.create({ ...meta(), public: true }, tokens[0]), 'VALIDATION_ERROR');
      }
    );
    await check(
      'category/job/playstyle/version/title filters combine and literal wildcard remains literal',
      async () => {
        const result = await service.list(
          new URL(
            'http://test?categoryId=' +
              cat.id +
              '&job=' +
              encodeURIComponent('白魔法师') +
              '&playstyle=' +
              encodeURIComponent('练习') +
              '&gameVersion=7.x&query=' +
              encodeURIComponent('新标题')
          ),
          tokens[1]
        );
        assert.ok(result.items.some((v) => v.id === a.id));
        assert.ok(result.filters.jobs.includes('白魔法师'));
        assert.ok(result.filters.playstyles.includes('练习'));
        assert.ok(result.filters.gameVersions.includes('7.x'));
        assert.equal((await service.list(new URL('http://test?query=%25'), tokens[0])).total, 0);
        assert.equal((await service.list(new URL('http://test?job=不存在'), tokens[0])).total, 0);
      }
    );
    await check('comment does not grant body contribution, self notifications excluded', async () => {
      const created = await service.create(meta('独编', 'AUTHOR'), tokens[0]);
      const c = await service.comment(
        created.id,
        { body: '自己的评论', parentId: null, mentions: [], submissionKey: randomUUID() },
        tokens[0]
      );
      assert.equal(await db.knowledgeNotification.count({ where: { commentId: c.id } }), 0);
      await service.comment(
        created.id,
        { body: '评论不算正文', parentId: null, mentions: [], submissionKey: randomUUID() },
        tokens[1]
      );
      assert.equal((await service.detail(created.id, tokens[0])).canDelete, true);
      await service.remove(created.id, { expectedRevision: 0 }, tokens[0]);
      await reject(() => service.detail(created.id, tokens[1]), 'NOT_FOUND');
      assert.equal(await db.knowledgeComment.count({ where: { articleId: created.id } }), 2);
    });
    await check('comment reply+mention notifications deduplicate and retry creates once', async () => {
      const first = await service.comment(
        a.id,
        { body: '评论', parentId: null, mentions: [], submissionKey: randomUUID() },
        tokens[1]
      );
      const input = {
        body: '@作者 @朋友 回复',
        parentId: first.id,
        mentions: [ids[0], ids[1], ids[1]],
        submissionKey: randomUUID()
      };
      const c = await service.comment(a.id, input, tokens[3]);
      commentId = c.id;
      assert.equal((await service.comment(a.id, input, tokens[3])).replayed, true);
      const notices = await db.knowledgeNotification.findMany({ where: { commentId: c.id } });
      assert.deepEqual(notices.map((n) => n.recipientId).sort(), [ids[0], ids[1]].sort());
      assert.equal(await db.activityOutbox.count({ where: { channel: 'QQ' } }), 0);
      await reject(
        () => service.comment(a.id, { ...input, body: '没有提及', submissionKey: randomUUID() }, tokens[3]),
        'VALIDATION_ERROR'
      );
    });
    await check('mention names with spaces and duplicate nicknames bind exact identities', async () => {
      await db.account.update({ where: { id: ids[4] }, data: { displayName: '同 名' } });
      await service.comment(
        a.id,
        { body: '@同 名 补充', mentions: [ids[4]], submissionKey: randomUUID() },
        tokens[0]
      );
      await db.account.update({
        where: { id: ids[4] },
        data: { displayName: '朋友', gameServer: '幻影群岛' }
      });
      await reject(
        () =>
          service.comment(
            a.id,
            { body: '@朋友 模糊提及', mentions: [ids[1]], submissionKey: randomUUID() },
            tokens[0]
          ),
        'VALIDATION_ERROR'
      );
      await service.comment(
        a.id,
        { body: '@朋友（拉诺西亚） 明确提及', mentions: [ids[1]], submissionKey: randomUUID() },
        tokens[0]
      );
    });
    await check('reply target scoped to same article and forged mention IDs reject', async () => {
      const other = await service.create(meta(), tokens[0]);
      await reject(
        () =>
          service.comment(
            other.id,
            { body: '回复', parentId: commentId, mentions: [], submissionKey: randomUUID() },
            tokens[0]
          ),
        'VALIDATION_ERROR'
      );
      await reject(
        () =>
          service.comment(
            a.id,
            { body: '@不存在', mentions: [randomUUID()], submissionKey: randomUUID() },
            tokens[0]
          ),
        'VALIDATION_ERROR'
      );
    });
    await check(
      'admin moderation requires reason, preserves data and records actor/time/reason',
      async () => {
        await reject(() => service.removeComment(a.id, commentId, {}, tokens[2]), 'VALIDATION_ERROR');
        await service.removeComment(a.id, commentId, { reason: '隔离违规评论处理' }, tokens[2]);
        const row = await service.detail(a.id, tokens[0]);
        await reject(
          () => service.remove(a.id, { expectedRevision: row.revision }, tokens[2]),
          'VALIDATION_ERROR'
        );
        const audits = await service.audits(a.id, tokens[2]);
        assert.ok(
          audits.items.some((v) => v.actorId === ids[2] && v.reason === '隔离违规评论处理' && v.createdAt)
        );
        await reject(() => service.audits(a.id, tokens[0]), 'FORBIDDEN');
      }
    );
    await check('disabled categories preserve existing selection but block new article', async () => {
      cat = await db.knowledgeCategory.update({
        where: { id: cat.id },
        data: { active: false, revision: { increment: 1 } }
      });
      assert.equal(
        (await service.categories(tokens[0])).items.some((item) => item.id === cat.id),
        false
      );
      await reject(() => service.create(meta(), tokens[0]), 'VALIDATION_ERROR');
      const row = await service.detail(a.id, tokens[0]),
        input = meta(row.body, 'AUTHOR');
      delete input.submissionKey;
      await service.edit(a.id, { ...input, expectedRevision: row.revision }, tokens[0]);
      cat = await db.knowledgeCategory.update({
        where: { id: cat.id },
        data: { active: true, revision: { increment: 1 } }
      });
    });
    await check(
      'admin restore requires reason and records audit without rolling permissions back',
      async () => {
        const row = await service.detail(a.id, tokens[2]);
        await reject(
          () =>
            service.restore(
              a.id,
              { versionId: initialVersion.id, expectedRevision: row.revision },
              tokens[2]
            ),
          'VALIDATION_ERROR'
        );
        await service.restore(
          a.id,
          { versionId: initialVersion.id, expectedRevision: row.revision, reason: '核实后恢复正文' },
          tokens[2]
        );
        const audit = (await service.audits(a.id, tokens[2])).items;
        assert.ok(
          audit.some(
            (v) => v.action === 'BODY_RESTORED' && v.actorId === ids[2] && v.reason === '核实后恢复正文'
          )
        );
      }
    );
    await check('revoked session and unknown payload cannot mutate article', async () => {
      await db.accountSession.updateMany({ where: { accountId: ids[4] }, data: { revokedAt: new Date() } });
      await reject(() => edit('失效会话', tokens[4]), 'UNAUTHENTICATED');
      await reject(
        () =>
          service.restore(
            a.id,
            { versionId: initialVersion.id, expectedRevision: 0, editMode: 'COMMUNITY' },
            tokens[0]
          ),
        'VALIDATION_ERROR'
      );
    });
  } finally {
    await testDb.close();
  }
});
