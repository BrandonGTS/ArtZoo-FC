// 相册照片删除后删掉本地文件（真实 PostgreSQL + 真实本地目录）：
// 上传配额开着时，按上传时记下的存储组件核对后删除，并把容量还给配额；
// 配额关着时，按照片 ID 直接删除三个文件。两种情况下封面照片都保留文件，
// 删除失败的照片留在"待删除"里，重试后删除；未删除的照片永远不会被删文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createTestDatabase } from '../_shared/database.mjs';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { tokenDigest } from '../../apps/web/server/auth/crypto.ts';
import { unavailableSms, mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import { AlbumService } from '../../apps/web/server/albums/service.ts';
import { LocalPhotoStorage } from '../../apps/web/server/albums/storage.ts';
import { initializeMediaBudgetBaseline } from '../../packages/db/src/media-budget.ts';
const sharp = createRequire(new URL('../../apps/web/package.json', import.meta.url))('sharp');

// 配额开着时，存储层要求媒体目录的每一级上级目录都不能被其他用户写入，系统临时目录（/tmp）不满足。
// 所以测试目录放在仓库的 .local/ 下（已被 .gitignore 忽略）；也可以用 ARTZOO_TEST_MEDIA_ROOT 指定。
function mediaRoot() {
  const base =
    process.env.ARTZOO_TEST_MEDIA_ROOT ?? fileURLToPath(new URL('../../.local/test-media', import.meta.url));
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(base, 'album-removal-'));
}

test('相册照片删除后删掉本地文件（数据库）', async (t) => {
  const testDb = await createTestDatabase();
  const db = testDb.db;
  const dir = mediaRoot();
  const previousBudget = process.env.ARTZOO_MEDIA_BUDGET_ENABLED;
  const check = (name, fn) => t.test(name, fn);
  try {
    const tokens = [],
      ids = [];
    for (let i = 0; i < 2; i++) {
      const account = await db.account.create({
        data: {
          phone: 'synthetic-album-removal-' + i,
          passwordHash: 'NONLOGIN-SYNTHETIC',
          membership: 'MEMBER',
          adminRole: 'NONE',
          displayName: '合成删除人' + i
        }
      });
      ids.push(account.id);
      const token = randomBytes(32).toString('base64url');
      await db.accountSession.create({
        data: { accountId: account.id, tokenHash: tokenDigest(token), expiresAt: new Date('2035-01-01') }
      });
      tokens.push(token);
    }
    const auth = new AccountService(db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      environment: 'test'
    });
    // 可以让"删文件"失败一次的本地存储，用来验证失败后留在待删除、重试后删除。
    class FlakyStorage extends LocalPhotoStorage {
      failNext = 0;
      async removeDeleted(id) {
        if (this.failNext > 0) {
          this.failNext--;
          throw Error('SYNTHETIC_REMOVE_FAILURE');
        }
        return super.removeDeleted(id);
      }
    }
    const storage = new FlakyStorage(join(dir, 'original'), join(dir, 'derived')),
      service = new AlbumService(auth, storage);
    const image = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#335577' } })
      .png()
      .toBuffer();
    const album = (name = '合成删除相册') =>
      service.create({ name, description: '', primary: 'DAILY', uploadMode: 'AUTHOR' }, tokens[0]);
    const upload = (albumId) =>
      service.upload(albumId, { batchId: randomUUID(), batchIndex: 0 }, image, 'synthetic.png', tokens[0]);
    const remove = async (photoId) => {
      const row = await db.albumPhoto.findUniqueOrThrow({ where: { id: photoId } });
      return service.updatePhoto(
        photoId,
        { action: 'remove', revision: row.revision, intent: 'SELF' },
        tokens[0]
      );
    };
    const budget = (on) => {
      if (on) process.env.ARTZOO_MEDIA_BUDGET_ENABLED = '1';
      else delete process.env.ARTZOO_MEDIA_BUDGET_ENABLED;
    };

    await check('budget off: deleting a photo removes its three files and reports complete', async () => {
      budget(false);
      const a = await album(),
        p = await upload(a.id);
      assert.equal(await storage.storedExists(p.id), true);
      assert.equal(await db.mediaStoredComponent.count(), 0);
      const result = await remove(p.id);
      assert.equal(result.storageReclamation.status, 'complete');
      assert.equal(result.storageReclamation.completed, 1);
      assert.equal(await storage.storedExists(p.id), false);
      const marker = await db.albumAudit.count({
        where: { photoId: p.id, action: 'PHOTO_PERMANENT_REMOVAL_REQUESTED' }
      });
      assert.equal(marker, 1);
      // 查看进度：文件已经不在，没有待处理项。
      const status = await service.update(a.id, { action: 'storage-removal-status' }, tokens[0]);
      assert.equal(status.storageReclamation.status, 'complete');
    });

    await check('budget off: a photo that is still another live album cover keeps its files', async () => {
      budget(false);
      const a = await album(),
        other = await album('合成封面相册'),
        p = await upload(a.id);
      await db.album.update({ where: { id: other.id }, data: { coverPhotoId: p.id } });
      const result = await remove(p.id);
      assert.equal(result.storageReclamation.status, 'retained');
      assert.equal(await storage.storedExists(p.id), true);
    });

    await check('budget off: a failed file removal stays pending, then retry removes it once', async () => {
      budget(false);
      const a = await album(),
        p = await upload(a.id);
      storage.failNext = 1;
      const result = await remove(p.id);
      assert.equal(result.storageReclamation.status, 'pending');
      assert.deepEqual(result.storageReclamation.targets, [p.id]);
      assert.equal(await storage.storedExists(p.id), true);
      const status = await service.update(a.id, { action: 'storage-removal-status' }, tokens[0]);
      assert.deepEqual(status.storageReclamation.targets, [p.id]);
      const body = {
        action: 'retry-storage-removal',
        photoIds: [p.id],
        removalAuthorizations: result.storageReclamation.authorizations
      };
      const retried = await service.update(a.id, body, tokens[0]);
      assert.equal(retried.storageReclamation.status, 'complete');
      assert.equal(await storage.storedExists(p.id), false);
      // 再重试一次也不报错（文件不存在视为已删除）。
      assert.equal((await service.update(a.id, body, tokens[0])).storageReclamation.status, 'complete');
    });

    await check('deleting the whole album removes the files of every photo in it', async () => {
      budget(false);
      const a = await album(),
        first = await upload(a.id),
        second = await upload(a.id);
      const row = await db.album.findUniqueOrThrow({ where: { id: a.id } });
      const result = await service.update(
        a.id,
        { action: 'remove', revision: row.revision, intent: 'SELF' },
        tokens[0]
      );
      assert.equal(result.storageReclamation.status, 'complete');
      assert.equal(await storage.storedExists(first.id), false);
      assert.equal(await storage.storedExists(second.id), false);
    });

    await check('a live photo is never removed: retry and direct removal are refused', async () => {
      budget(false);
      const a = await album(),
        p = await upload(a.id);
      await assert.rejects(
        service.update(a.id, { action: 'retry-storage-removal', photoIds: [p.id] }, tokens[0]),
        (e) => e.status === 404
      );
      assert.equal(await storage.storedExists(p.id), true);
    });

    await check('budget on: files are verified, removed, and their bytes credited back', async () => {
      // 新站空库：配额基线是 0 字节。开启配额前必须先初始化基线，否则上传会被拒绝。
      await db.$transaction((tx) =>
        initializeMediaBudgetBaseline(tx, {
          bytes: 0n,
          fingerprint: createHash('sha256').update('synthetic-empty-site').digest('hex'),
          now: new Date()
        })
      );
      budget(true);
      const a = await album(),
        p = await upload(a.id);
      const components = await db.mediaStoredComponent.findMany({
        where: { receiptScope: 'album-photo', objectKey: 'album-photo:' + p.id }
      });
      assert.equal(components.length, 3);
      const result = await remove(p.id);
      assert.equal(result.storageReclamation.status, 'complete');
      assert.equal(await storage.storedExists(p.id), false);
      const ids3 = components.map((c) => c.id);
      assert.equal(
        await db.mediaRetirementIntent.count({ where: { componentId: { in: ids3 }, state: 'ACKNOWLEDGED' } }),
        3
      );
      assert.equal(await db.mediaStorageCredit.count({ where: { componentId: { in: ids3 } } }), 3);
    });

    await check(
      'budget on: a failed removal stays pending, then retry removes and credits once',
      async () => {
        budget(true);
        const a = await album(),
          p = await upload(a.id);
        const original = storage.boundPhotoNamespaces.bind(storage);
        let fail = true;
        storage.boundPhotoNamespaces = async (scope) => {
          const ns = await original(scope);
          if (!fail) return ns;
          fail = false;
          return {
            ...ns,
            original: { ...ns.original, remove: async () => Promise.reject(Error('SYNTHETIC')) }
          };
        };
        try {
          const result = await remove(p.id);
          assert.equal(result.storageReclamation.status, 'pending');
          const retried = await service.update(
            a.id,
            {
              action: 'retry-storage-removal',
              photoIds: [p.id],
              removalAuthorizations: result.storageReclamation.authorizations
            },
            tokens[0]
          );
          assert.equal(retried.storageReclamation.status, 'complete');
          assert.equal(await storage.storedExists(p.id), false);
        } finally {
          storage.boundPhotoNamespaces = original;
        }
      }
    );
  } finally {
    if (previousBudget === undefined) delete process.env.ARTZOO_MEDIA_BUDGET_ENABLED;
    else process.env.ARTZOO_MEDIA_BUDGET_ENABLED = previousBudget;
    rmSync(dir, { recursive: true, force: true });
    await testDb.close();
  }
});
