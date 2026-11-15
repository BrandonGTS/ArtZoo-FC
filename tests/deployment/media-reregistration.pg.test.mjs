import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, rename, readFile, writeFile, symlink, link, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTestDatabase } from '../_shared/database.mjs';
import { seedRegistration } from './registration-fixture.mjs';
import { initializeEmptyMediaBaseline } from '../../packages/media/dist/media-baseline.js';
import { reregisterMediaIdentity } from '../../packages/media/dist/media-reregistration.js';
import { BoundNamespace } from '../../packages/media/dist/stock-bound-io.js';
import {
  prepareAlbumPhotoRemoval,
  retireAlbumPhotoRemovals
} from '../../packages/media/dist/stock-retirement.js';

test('offline registration: all namespaces, atomic rejection and real album deletion credit', async (t) => {
  const target = await createTestDatabase(),
    db = target.db;
  const base = resolve('.local/registration');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(base, 'test-')),
    roots = ['original', 'derived', 'avatars'].map((n) => join(dir, n));
  try {
    for (const root of roots) await mkdir(root, { mode: 0o700 });
    await initializeEmptyMediaBaseline(db, { database: target.name, roots });
    const fixture = await seedRegistration(db, roots);
    const run = () => reregisterMediaIdentity(db, { database: target.name, roots });
    const snapshot = async () =>
      Promise.all([
        db.mediaBudgetState.findMany(),
        db.mediaStoredComponent.findMany({ orderBy: { id: 'asc' } }),
        db.mediaRetirementIntent.findMany(),
        db.mediaStorageCredit.findMany(),
        db.mediaUploadReceipt.findMany({ orderBy: { operationKey: 'asc' } })
      ]);
    const reject = async () => {
      const before = await snapshot();
      await assert.rejects(run);
      assert.deepEqual(await snapshot(), before);
    };
    await t.test(
      'same bytes at new inodes and rebuilt root rebind all active identities, repeat is inert',
      async () => {
        for (const path of fixture.files) {
          await rename(path, path + '.held');
          await writeFile(path, await readFile(path + '.held'), { mode: 0o600 });
        }
        await rename(roots[2], roots[2] + '.held');
        await mkdir(roots[2], { mode: 0o700 });
        for (const path of fixture.files.filter((p) => p.startsWith(roots[2] + '/')))
          await writeFile(path, await readFile(path.replace(roots[2], roots[2] + '.held')), { mode: 0o600 });
        const before = (await snapshot())[0],
          result = await run();
        assert.equal(result.checked, 24);
        assert.equal(result.updated, 24);
        assert.equal(result.database, 1);
        assert.equal(result.baselineChanged, true);
        const after = (await snapshot())[0];
        assert.deepEqual({ ...after[0], baselineFingerprint: before[0].baselineFingerprint }, before[0]);
        const all = await snapshot();
        assert.equal((await run()).updated, 0);
        assert.deepEqual(await snapshot(), all);
      }
    );
    const path = fixture.files[0],
      bytes = await readFile(path);
    for (const kind of ['content', 'missing', 'symlink', 'hardlink', 'permissions'])
      await t.test(kind + ' rejects the entire operation', async () => {
        await rename(path, path + '.original');
        if (kind === 'content') await writeFile(path, Buffer.alloc(bytes.length, 43), { mode: 0o600 });
        if (kind === 'symlink') await symlink(path + '.original', path);
        if (kind === 'hardlink') await link(path + '.original', path);
        if (kind === 'permissions') {
          await writeFile(path, bytes, { mode: 0o600 });
          await chmod(path, 0o666);
        }
        await reject();
        await rm(path, { force: true });
        await rename(path + '.original', path);
      });
    await t.test('PREPARED is refused without adopting or deleting its evidence', async () => {
      const row = fixture.rows[0];
      await db.mediaRetirementIntent.create({
        data: {
          id: 'e'.repeat(64),
          componentId: row.id,
          identityFingerprint: row.storageIdentityFingerprint,
          authorityFingerprint: 'd'.repeat(64),
          state: 'PREPARED',
          createdAt: new Date()
        }
      });
      await reject();
      await db.mediaRetirementIntent.deleteMany();
    });
    await t.test('replacement during scanning rejects without partial registration', async () => {
      const inspect = BoundNamespace.prototype.inspect;
      let calls = 0;
      BoundNamespace.prototype.inspect = async function (...args) {
        const ticket = await inspect.apply(this, args);
        if (++calls === 24) {
          await rename(path, path + '.raced');
          await writeFile(path, bytes, { mode: 0o600 });
        }
        return ticket;
      };
      try {
        await reject();
      } finally {
        BoundNamespace.prototype.inspect = inspect;
      }
      await run();
    });
    for (const failure of [
      "RAISE EXCEPTION 'synthetic'",
      'PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW'
    ])
      await t.test('late SQL failure or disconnect rolls back identity updates', async () => {
        for (const path of fixture.files) {
          await rename(path, path + '.rollback');
          await writeFile(path, await readFile(path + '.rollback'), { mode: 0o600 });
        }
        await target.pool.query(
          `CREATE FUNCTION reject_registration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${failure}; END $$; CREATE TRIGGER reject_registration BEFORE UPDATE ON "MediaBudgetState" FOR EACH ROW EXECUTE FUNCTION reject_registration();`
        );
        await reject();
        await target.pool.query(
          'DROP TRIGGER reject_registration ON "MediaBudgetState"; DROP FUNCTION reject_registration();'
        );
        await run();
      });
    await t.test('concurrent writer lock is rejected and original state survives', async () => {
      const c = await target.pool.connect();
      await c.query('BEGIN');
      await c.query('LOCK TABLE "MediaStoredComponent" IN ROW EXCLUSIVE MODE');
      try {
        await reject();
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });
    await t.test(
      'real album deletion credits once and completed history stays unchanged on registration',
      async () => {
        const p = fixture.albumPhoto;
        await db.albumPhoto.update({ where: { id: p.id }, data: { removedAt: new Date() } });
        await db.$transaction((tx) => prepareAlbumPhotoRemoval(tx, p.id, p.albumId));
        const ns = {
          original: new BoundNamespace(join(roots[0], 'albums'), 'album-photo'),
          derived: new BoundNamespace(join(roots[1], 'albums'), 'album-photo')
        };
        const remove = () => retireAlbumPhotoRemovals(db, ns, [p.id], () => new Date());
        assert.equal((await remove()).status, 'complete');
        const amount = (await db.mediaBudgetState.findUnique({ where: { id: 'global' } })).creditedBytes;
        assert.equal(amount, 384n);
        assert.equal((await remove()).status, 'complete');
        assert.equal(
          (await db.mediaBudgetState.findUnique({ where: { id: 'global' } })).creditedBytes,
          amount
        );
        const history = await db.mediaStorageCredit.findMany();
        assert.equal((await run()).credited, 3);
        assert.deepEqual(await db.mediaStorageCredit.findMany(), history);
        for (const part of ['original', 'preview', 'thumbnail'])
          await assert.rejects(
            readFile(join(roots[part === 'original' ? 0 : 1], 'albums', p.id + '.' + part)),
            { code: 'ENOENT' }
          );
      }
    );
  } finally {
    await target.close();
    await rm(dir, { recursive: true, force: true });
  }
});
