import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, symlink, chmod, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../_shared/database.mjs';
import { initializeEmptyMediaBaseline } from '../../packages/media/src/media-baseline.ts';
import { lockEmptyMediaBaselineTarget, initializeMediaBudgetBaseline } from '../../packages/db/src/index.ts';

test('empty media baseline: real PostgreSQL, trusted disk and transactional rejection', async (t) => {
  const target = await createTestDatabase(),
    db = target.db;
  const base =
    process.env.ARTZOO_TEST_MEDIA_ROOT ?? fileURLToPath(new URL('../../.local/test-media', import.meta.url));
  await mkdir(base, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(base, 'baseline-'));
  const roots = ['original', 'derived', 'avatars'].map((name) => join(dir, name));
  const run = () => initializeEmptyMediaBaseline(db, { database: target.name, roots });
  const state = () => db.mediaBudgetState.findUnique({ where: { id: 'global' } });
  const clear = () => db.mediaBudgetState.deleteMany();
  const unchanged = async (operation, pattern) => {
    const before = await state();
    await assert.rejects(operation, pattern);
    assert.deepEqual(await state(), before);
  };
  try {
    for (const root of roots) await mkdir(root, { mode: 0o700 });
    await t.test('empty directories initialize once; duplicate preserves timestamp and usage', async () => {
      await mkdir(join(roots[0], 'knowledge', '.upload-receipts'), { recursive: true, mode: 0o700 });
      assert.equal(await run(), 'initialized');
      const first = await state();
      assert.equal(first.baselineBytes, 0n);
      assert.match(first.baselineFingerprint, /^[a-f0-9]{64}$/);
      assert.equal(await run(), 'already-initialized');
      assert.deepEqual(await state(), first);
      await db.mediaBudgetState.update({
        where: { id: 'global' },
        data: { committedBytes: 19n, reservedBytes: 7n, creditedBytes: 3n }
      });
      await db.mediaDailyBudget.create({
        data: { accountId: 'synthetic', day: '2026-01-01', committedBytes: 19n, reservedBytes: 7n }
      });
      await writeFile(join(roots[2], 'later-upload'), 'synthetic');
      const used = await state();
      assert.equal(await run(), 'already-initialized');
      assert.deepEqual(await state(), used);
      assert.equal((await db.mediaDailyBudget.findFirst()).committedBytes, 19n);
      await rm(join(roots[2], 'later-upload'));
      await db.mediaDailyBudget.deleteMany();
      await clear();
    });
    await t.test('wrong target and conflicting baseline are refused without changes', async () => {
      await unchanged(
        () => initializeEmptyMediaBaseline(db, { database: 'wrong', roots }),
        /TARGET_MISMATCH/
      );
      await db.$transaction((tx) =>
        initializeMediaBudgetBaseline(tx, { bytes: 0n, fingerprint: 'a'.repeat(64), now: new Date() })
      );
      await unchanged(run, /BASELINE_ALREADY_SET/);
      await clear();
    });
    for (const key of ['baselineBytes', 'committedBytes', 'reservedBytes']) {
      await t.test('nonzero uninitialized ' + key + ' is refused', async () => {
        await db.mediaBudgetState.create({ data: { id: 'global', [key]: 1n } });
        await unchanged(run, /STATE_NOT_EMPTY/);
        await clear();
      });
    }
    await t.test('zero daily history and terminal upload receipt are not an empty ledger', async () => {
      await db.mediaDailyBudget.create({ data: { accountId: 'synthetic', day: '2026-01-01' } });
      await unchanged(run, /DATABASE_NOT_EMPTY/);
      await db.mediaDailyBudget.deleteMany();
      await db.mediaUploadReceipt.create({
        data: {
          scope: 'daily',
          operationKey: randomUUID(),
          fingerprint: 'a'.repeat(64),
          rawBytes: 1n,
          storedBytes: 0n,
          state: 'FAILED',
          settledAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });
      await unchanged(run, /DATABASE_NOT_EMPTY/);
      await db.mediaUploadReceipt.deleteMany();
    });
    const account = await db.account.create({
      data: {
        phone: 'synthetic-baseline',
        membership: 'MEMBER',
        adminRole: 'NONE',
        passwordHash: 'NONLOGIN-SYNTHETIC',
        displayName: 'synthetic'
      }
    });
    const media = {
      ownerId: account.id,
      batchId: randomUUID(),
      batchIndex: 0,
      fingerprint: 'a'.repeat(64),
      mime: 'image/webp',
      width: 1,
      height: 1,
      frames: 1
    };
    for (const model of ['dailyMedia', 'wishMedia']) {
      await t.test(model + ' business record without files or budget is refused', async () => {
        const row = await db[model].create({ data: media });
        await unchanged(run, /DATABASE_NOT_EMPTY/);
        await db[model].delete({ where: { id: row.id } });
      });
    }
    const album = await db.album.create({
      data: { creatorId: account.id, name: 'synthetic', primary: 'DAILY', uploadMode: 'AUTHOR' }
    });
    await t.test('removed album photo and orphan comment media are still previous media use', async () => {
      const photo = await db.albumPhoto.create({
        data: {
          albumId: album.id,
          uploaderId: account.id,
          batchId: randomUUID(),
          batchIndex: 0,
          digest: 'a'.repeat(64),
          originalName: 'synthetic',
          mime: 'image/webp',
          bytes: 1,
          width: 1,
          height: 1,
          removedAt: new Date()
        }
      });
      await unchanged(run, /DATABASE_NOT_EMPTY/);
      await db.albumPhoto.delete({ where: { id: photo.id } });
      const comment = await db.albumCommentMedia.create({ data: { ...media, albumId: album.id } });
      await unchanged(run, /DATABASE_NOT_EMPTY/);
      await db.albumCommentMedia.delete({ where: { id: comment.id } });
    });
    await t.test('lottery with embedded media is refused', async () => {
      const lottery = await db.lottery.create({
        data: {
          id: randomUUID(),
          creatorId: account.id,
          idempotencyKey: randomUUID(),
          fingerprint: 'a'.repeat(64),
          title: 'synthetic',
          kind: 'ORDINARY',
          mode: 'MANUAL',
          audience: 'MEMBER_FRIEND',
          prizes: [{ imageUrl: '/api/lotteries/media/synthetic' }],
          drawAt: new Date('2035-01-01')
        }
      });
      await unchanged(run, /DATABASE_NOT_EMPTY/);
      await db.lottery.delete({ where: { id: lottery.id } });
    });
    await t.test('official image record without disk files is refused', async () => {
      const event = await db.officialEvent.create({
        data: {
          id: randomUUID(),
          sourceKey: 'synthetic',
          externalId: 'synthetic',
          sourceUrl: 'https://example.invalid',
          sourceTitle: 'synthetic',
          sourceText: 'synthetic',
          requestFingerprint: 'a'.repeat(64)
        }
      });
      const row = await db.officialEventImage.create({
        data: {
          id: randomUUID(),
          eventId: event.id,
          sourceUrl: 'https://example.invalid/image',
          sourcePageUrl: 'https://example.invalid',
          sourceKind: 'MANUAL',
          fingerprint: 'a'.repeat(64),
          mime: 'image/webp',
          width: 1,
          height: 1,
          frames: 1,
          originalBytes: 1
        }
      });
      await unchanged(run, /DATABASE_NOT_EMPTY/);
      await target.pool.query('TRUNCATE TABLE "OfficialEventImage" CASCADE');
    });
    await t.test('avatar record without disk files is refused', async () => {
      const row = await db.avatarAsset.create({
        data: { accountId: account.id, width: 1, height: 1, bytes: 1, smallBytes: 1 }
      });
      await unchanged(run, /DATABASE_NOT_EMPTY/);
      await db.avatarAsset.delete({ where: { id: row.id } });
    });
    await t.test('knowledge record without disk files is refused', async () => {
      const row = await db.knowledgeImage.create({
        data: {
          uploaderId: account.id,
          batchId: randomUUID(),
          batchIndex: 0,
          digest: 'a'.repeat(64),
          originalName: 'synthetic',
          mime: 'image/webp',
          bytes: 1,
          width: 1,
          height: 1,
          frames: 1
        }
      });
      await unchanged(run, /DATABASE_NOT_EMPTY/);
      await db.knowledgeImage.delete({ where: { id: row.id } });
    });
    await t.test('database-resident icon is refused even when all directories are empty', async () => {
      const category = await db.resourceCategory.create({ data: { name: 'synthetic-baseline' } });
      const row = await db.resourceLink.create({
        data: {
          categoryId: category.id,
          name: 'synthetic',
          purpose: 'synthetic',
          url: 'https://example.invalid',
          iconBytes: Buffer.from([1])
        }
      });
      await unchanged(run, /DATABASE_NOT_EMPTY/);
      await db.resourceLink.delete({ where: { id: row.id } });
    });
    for (const root of roots) {
      await t.test(
        'file (including zero-byte/hidden) in ' + root.split('/').at(-1) + ' is refused',
        async () => {
          const file = join(root, '.unexpected');
          await writeFile(file, '');
          await unchanged(run, /STORAGE_NOT_EMPTY/);
          await rm(file);
        }
      );
    }
    await t.test('nested knowledge journal is refused', async () => {
      const file = join(roots[0], 'knowledge', '.upload-receipts', 'journal.jsonl');
      await writeFile(file, '{}');
      await unchanged(run, /STORAGE_NOT_EMPTY/);
      await rm(file);
    });
    await t.test('nested symlink and untrusted ancestor permissions are refused', async () => {
      const link = join(roots[1], 'link');
      await symlink(roots[2], link);
      await unchanged(run, /STORAGE_NOT_EMPTY/);
      await rm(link);
      await chmod(dir, 0o777);
      try {
        await unchanged(run, /UNTRUSTED_ROOT/);
      } finally {
        await chmod(dir, 0o700);
      }
    });
    await t.test(
      'missing, symlinked and unwritable root are refused without creating a baseline',
      async () => {
        await rename(roots[2], roots[2] + '-saved');
        await unchanged(run, /ENOENT/);
        await symlink(roots[2] + '-saved', roots[2]);
        await unchanged(run, /UNTRUSTED_ROOT/);
        await rm(roots[2]);
        await rename(roots[2] + '-saved', roots[2]);
        await chmod(roots[2], 0o500);
        try {
          await unchanged(run, /EACCES/);
        } finally {
          await chmod(roots[2], 0o700);
        }
      }
    );
    await t.test('unwritable empty child is refused before first upload', async () => {
      const child = join(roots[1], 'locked');
      await mkdir(child, { mode: 0o500 });
      try {
        await unchanged(run, /EACCES/);
      } finally {
        await chmod(child, 0o700);
        await rm(child, { recursive: true });
      }
    });
    await t.test('same path with replaced media mount conflicts with existing fingerprint', async () => {
      await run();
      await rename(roots[2], roots[2] + '-saved');
      await mkdir(roots[2], { mode: 0o700 });
      await unchanged(run, /BASELINE_ALREADY_SET/);
      await rm(roots[2], { recursive: true });
      await rename(roots[2] + '-saved', roots[2]);
      await clear();
    });
    await t.test(
      'active writer or competing initializer is rejected; retry succeeds after release',
      async () => {
        const connection = await target.pool.connect();
        try {
          await connection.query('BEGIN');
          await connection.query('LOCK TABLE "AvatarAsset" IN ROW EXCLUSIVE MODE');
          await unchanged(run);
        } finally {
          await connection.query('ROLLBACK');
          connection.release();
        }
        await db.$transaction(async (tx) => {
          await lockEmptyMediaBaselineTarget(tx, target.name);
          await unchanged(run);
        });
        assert.equal(await run(), 'initialized');
        await clear();
      }
    );
    await t.test('failure after baseline update rolls back; concurrent disk change is detected', async () => {
      // Real DB trigger rejects the update, proving state insertion and initialization roll back together.
      await target.pool.query(
        `CREATE FUNCTION reject_baseline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`
      );
      await target.pool.query(
        'CREATE TRIGGER reject_baseline BEFORE UPDATE ON "MediaBudgetState" FOR EACH ROW EXECUTE FUNCTION reject_baseline()'
      );
      try {
        await unchanged(run);
      } finally {
        await target.pool.query('DROP TRIGGER reject_baseline ON "MediaBudgetState"');
        await target.pool.query('DROP FUNCTION reject_baseline()');
      }
      // Intercept only transaction control in this test; every query still uses the real PostgreSQL transaction.
      const wrapped = {
        $transaction: (fn, options) =>
          db.$transaction(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(object, key) {
                    if (key === '$executeRaw')
                      return async (...args) => {
                        const result = await object.$executeRaw(...args);
                        if (args[0][0].includes('/*media-budget:baseline*/'))
                          await writeFile(join(roots[0], 'racing-writer'), 'synthetic');
                        return result;
                      };
                    return Reflect.get(object, key);
                  }
                })
              ),
            options
          )
      };
      await unchanged(
        () => initializeEmptyMediaBaseline(wrapped, { database: target.name, roots }),
        /STORAGE_NOT_EMPTY|STORAGE_CHANGED/
      );
      await rm(join(roots[0], 'racing-writer'));
      assert.equal(await run(), 'initialized');
    });
  } finally {
    await target.close();
    await rm(dir, { recursive: true, force: true });
  }
});
