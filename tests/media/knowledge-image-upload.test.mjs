// 知识库图片上传：重放、并发、会话过期回滚、回执恢复，以及回执文件的路径安全。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, symlink, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountError } from '@artzoo/domain';
import { KnowledgeImageService } from '../../apps/web/server/knowledge/images.ts';
import {
  KnowledgeImageUploadReceipts,
  reconcileKnowledgeImageUpload
} from '../../apps/web/server/knowledge/image-upload-receipts.ts';
import { LocalPhotoStorage } from '../../apps/web/server/media/photo-storage.ts';

const key = () => ({ batchId: randomUUID(), batchIndex: 0 }),
  a = Buffer.from('synthetic-a'),
  b = Buffer.from('synthetic-b');
const conflict = (e) => e.code === 'CONFLICT' && e.status === 409;
const barrier = (count) => {
  let seen = 0,
    release;
  const ready = new Promise((r) => (release = r));
  return async () => {
    if (++seen === count) release();
    await ready;
  };
};
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'artzoo-audit-media-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '/artzoo-audit-media-'));
    await rm(directory, { recursive: true, force: true });
  });
  const receipts = new KnowledgeImageUploadReceipts(join(directory, 'receipts')),
    store = new LocalPhotoStorage(join(directory, 'original'), join(directory, 'derived'));
  const actor = {
    id: randomUUID(),
    accountId: randomUUID(),
    account: { phone: 'synthetic-only' },
    expiresAt: new Date(Date.now() + 60000)
  };
  let rows = new Map(),
    tail = Promise.resolve(),
    calls = 0,
    expired = false,
    processes = 0,
    puts = 0,
    discards = 0,
    lastId;
  const uncertain = new Error('synthetic transaction outcome unknown');
  const table = (map) => ({
    findUnique: async ({ where }) =>
      where.id
        ? (map.get(where.id) ?? null)
        : ([...map.values()].find((row) =>
            Object.entries(where.uploaderId_batchId_batchIndex).every(([k, v]) => row[k] === v)
          ) ?? null),
    create: async ({ data }) => {
      map.set(data.id, data);
      if (options.expireAfterCreate) expired = true;
      return data;
    }
  });
  const db = { knowledgeImage: table(rows) };
  const auth = {
    db,
    now: () => new Date(),
    requireAccount: async () => {
      if (expired) throw new AccountError('UNAUTHENTICATED', 'synthetic expiry', 401);
      return actor;
    },
    transaction: async (fn) => {
      const call = ++calls,
        previous = tail;
      let release;
      tail = new Promise((r) => (release = r));
      await previous;
      try {
        if (call === 2 && options.failBeforeCallback) throw uncertain;
        const draft = new Map(rows),
          tx = {
            // 替身：知识库图片尚未进入"待清理"流程（真实数据库中由 MediaRetirementIntent 判定）。
            $queryRaw: async (strings) =>
              strings.join('?').includes('orphan:attachment-fence') ? [{ found: false }] : [],
            knowledgeImage: table(draft)
          },
          result = await fn(tx);
        if (call === 2 && options.rollbackAfterCallback) throw uncertain;
        rows = draft;
        db.knowledgeImage = table(rows);
        if (call === 2 && options.failAfterCommit) throw uncertain;
        return result;
      } finally {
        release();
      }
    }
  };
  const ports = {
    process: async (input, name) => {
      processes++;
      if (!name.endsWith('.png')) throw new AccountError('VALIDATION_ERROR', 'synthetic format guard', 400);
      await options.processGate?.();
      return {
        original: input,
        preview: input,
        thumbnail: input,
        mime: 'image/png',
        width: input.length,
        height: 1,
        frames: 1
      };
    },
    put: async (id, out) => {
      puts++;
      lastId = id;
      await store.put(id, out);
    },
    read: store.read.bind(store),
    discardUncommitted: async (id) => {
      discards++;
      if (options.failCleanup) throw new Error('synthetic cleanup failure');
      await store.discardUncommitted(id);
    }
  };
  const images = new KnowledgeImageService(auth, ports, receipts);
  return {
    images,
    auth,
    ports,
    store,
    receipts,
    directory,
    uncertain,
    get lastId() {
      return lastId;
    },
    get rows() {
      return rows;
    },
    get counters() {
      return { processes, puts, discards };
    },
    expire: () => (expired = true),
    files: async () => {
      let count = 0;
      for (const sub of ['original', 'derived'])
        count += (await readdir(join(directory, sub)).catch(() => [])).length;
      return count;
    },
    receiptNames: () => readdir(join(directory, 'receipts')).catch(() => [])
  };
}
test('first upload has 3 files/1 row; replay and different digest never decode or allocate media', async (t) => {
  const f = await fixture(t),
    slot = key(),
    first = await f.images.upload(slot, a, 'a.png');
  assert.equal(first.replayed, false);
  assert.equal(await f.files(), 3);
  assert.equal(f.rows.size, 1);
  const again = await f.images.upload(slot, a, 'a.png');
  assert.equal(again.id, first.id);
  assert.equal(again.replayed, true);
  await assert.rejects(() => f.images.upload(slot, b, 'b.png'), conflict);
  assert.equal(await f.files(), 3);
  assert.equal(f.rows.size, 1);
  assert.deepEqual(f.counters, { processes: 1, puts: 1, discards: 0 });
  assert.deepEqual(await f.receiptNames(), []);
});
test('changed replay filename keeps shared format rejection and creates no new media', async (t) => {
  const f = await fixture(t),
    slot = key();
  await f.images.upload(slot, a, 'a.png');
  await assert.rejects(
    () => f.images.upload(slot, a, 'a.pdf'),
    (e) => e.code === 'VALIDATION_ERROR'
  );
  assert.equal(await f.files(), 3);
  assert.equal(f.counters.puts, 1);
});
test('changed replay filename rechecks session after decoding', async (t) => {
  const f = await fixture(t),
    slot = key();
  await f.images.upload(slot, a, 'a.png');
  const process = f.ports.process;
  f.ports.process = async (...args) => {
    const out = await process(...args);
    f.expire();
    return out;
  };
  await assert.rejects(
    () => f.images.upload(slot, a, 'renamed.png'),
    (e) => e.status === 401
  );
  assert.equal(await f.files(), 3);
  assert.equal(f.rows.size, 1);
});
test('same digest race commits 1 row and removes only losing UUID files', async (t) => {
  const f = await fixture(t, { processGate: barrier(2) }),
    slot = key();
  const results = await Promise.all([f.images.upload(slot, a, 'a.png'), f.images.upload(slot, a, 'a.png')]);
  assert.equal(results[0].id, results[1].id);
  assert.deepEqual(results.map((r) => r.replayed).sort(), [false, true]);
  assert.equal(await f.files(), 3);
  assert.equal(f.rows.size, 1);
  assert.equal(f.counters.discards, 1);
  assert.deepEqual(await f.receiptNames(), []);
  assert.deepEqual(await f.store.read(results[0].id, 'original'), a);
});
test('different digest race returns 409 with 3 files/1 row after confirmed rollback', async (t) => {
  const f = await fixture(t, { processGate: barrier(2) }),
    slot = key();
  const results = await Promise.allSettled([
    f.images.upload(slot, a, 'a.png'),
    f.images.upload(slot, b, 'b.png')
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(conflict(results.find((r) => r.status === 'rejected').reason));
  assert.equal(await f.files(), 3);
  assert.equal(f.rows.size, 1);
  assert.equal(f.counters.discards, 1);
  assert.deepEqual(await f.receiptNames(), []);
  const winner = [...f.rows.values()][0];
  assert.equal(
    createHash('sha256')
      .update(await f.store.read(winner.id, 'original'))
      .digest('hex'),
    winner.digest
  );
});
test('final session expiry rolls back row and removes all three newly created files', async (t) => {
  const f = await fixture(t, { expireAfterCreate: true });
  await assert.rejects(
    () => f.images.upload(key(), a, 'a.png'),
    (e) => e.status === 401
  );
  assert.equal(f.rows.size, 0);
  assert.equal(await f.files(), 0);
  assert.equal(f.counters.discards, 1);
  assert.deepEqual(await f.receiptNames(), []);
});
for (const mode of ['failBeforeCallback', 'rollbackAfterCallback'])
  test(mode + ' retains exact pending receipt and never treats missing SELECT as rollback', async (t) => {
    const f = await fixture(t, { [mode]: true });
    await assert.rejects(
      () => f.images.upload(key(), a, 'a.png'),
      (e) => e === f.uncertain
    );
    assert.equal(f.rows.size, 0);
    assert.equal(await f.files(), 3);
    assert.equal(f.counters.discards, 0);
    const receipt = await f.receipts.inspect(f.lastId);
    assert.equal(receipt.record.imageId, f.lastId);
    assert.equal(receipt.record.variants.length, 3);
    assert.deepEqual(Object.keys(receipt.record).sort(), [
      'digest',
      'imageId',
      'schemaVersion',
      'state',
      'variants'
    ]);
    assert.equal((await reconcileKnowledgeImageUpload(f.receipts, f.auth.db, f.lastId)).state, 'pending');
    assert.equal((await f.receiptNames()).length, 1);
    assert.equal(await f.files(), 3);
  });
test('COMMIT succeeded but result was lost: reconcile settles only matching receipt and preserves originals', async (t) => {
  const f = await fixture(t, { failAfterCommit: true });
  await assert.rejects(
    () => f.images.upload(key(), a, 'a.png'),
    (e) => e === f.uncertain
  );
  assert.equal(f.rows.size, 1);
  assert.equal(await f.files(), 3);
  assert.equal(f.counters.discards, 0);
  assert.equal((await reconcileKnowledgeImageUpload(f.receipts, f.auth.db, f.lastId)).state, 'committed');
  assert.deepEqual(await f.receiptNames(), []);
  assert.deepEqual(await f.store.read(f.lastId, 'original'), a);
});
test('reconcile never settles a mismatched digest/size reference', async (t) => {
  const f = await fixture(t, { failAfterCommit: true });
  await assert.rejects(() => f.images.upload(key(), a, 'a.png'));
  const row = f.rows.get(f.lastId);
  row.digest = '0'.repeat(64);
  assert.equal((await reconcileKnowledgeImageUpload(f.receipts, f.auth.db, f.lastId)).state, 'pending');
  assert.equal((await f.receiptNames()).length, 1);
  assert.equal(await f.files(), 3);
});
test('cleanup failure preserves original conflict and exact rollback receipt', async (t) => {
  const f = await fixture(t, { processGate: barrier(2), failCleanup: true }),
    slot = key();
  const results = await Promise.allSettled([
    f.images.upload(slot, a, 'a.png'),
    f.images.upload(slot, b, 'b.png')
  ]);
  assert.ok(conflict(results.find((r) => r.status === 'rejected').reason));
  assert.equal(f.rows.size, 1);
  assert.equal(await f.files(), 6);
  const names = await f.receiptNames();
  assert.equal(names.length, 1);
  assert.match(await readFile(join(f.directory, 'receipts', names[0]), 'utf8'), /rollback-confirmed/);
});
test('receipt creation fails closed on existing paths, symlinks and hardlinks', async (t) => {
  const f = await fixture(t),
    imageId = randomUUID(),
    record = {
      schemaVersion: 1,
      imageId,
      digest: 'a'.repeat(64),
      variants: ['original', 'preview', 'thumbnail'].map((variant) => ({ variant, bytes: 1 }))
    };
  const receipt = await f.receipts.create(record);
  await receipt.close();
  const path = join(f.directory, 'receipts', imageId + '.jsonl'),
    before = await readFile(path);
  await assert.rejects(
    () => f.receipts.create(record),
    (e) => e.code === 'EEXIST'
  );
  assert.deepEqual(await readFile(path), before);
  const hard = join(f.directory, 'hard');
  await link(path, hard);
  await assert.rejects(() => f.receipts.inspect(imageId), /Unsafe/);
  await rm(hard);
  const other = randomUUID(),
    otherPath = join(f.directory, 'receipts', other + '.jsonl');
  await symlink(path, otherPath);
  await assert.rejects(() => f.receipts.create({ ...record, imageId: other }));
  await assert.rejects(() => f.receipts.inspect(other));
  const outside = join(f.directory, 'outside');
  await writeFile(outside, 'synthetic retained');
  const linkedDirectory = join(f.directory, 'linked');
  await symlink(join(f.directory, 'receipts'), linkedDirectory);
  await assert.rejects(
    () => new KnowledgeImageUploadReceipts(linkedDirectory).create({ ...record, imageId: randomUUID() }),
    /Unsafe/
  );
  assert.equal(await readFile(outside, 'utf8'), 'synthetic retained');
  assert.deepEqual(await readFile(path), before);
});
