// 抽奖列表与奖品图片：用内存替身代替数据库，图片写进临时目录。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { validateLottery, selectWinners } from '../../packages/domain/src/lottery-contract.ts';
import { LotteryService } from '../../apps/web/server/lottery/service.ts';
import { assertLotteryImages, lotteryStorage } from '../../apps/web/server/lottery/media.ts';
import { processPhoto } from '../../apps/web/server/media/photo-processor.ts';
const web = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const sharp = web('sharp');
const owner = randomUUID(),
  image = randomUUID(),
  imageUrl = `/api/lotteries/media/${owner}/${image}`;
const unfencedImageTx = {
  $queryRaw: async (strings, ...values) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    assert.equal(
      sql,
      '/*lottery-orphan:attachment-fence*/ SELECT EXISTS( SELECT 1 FROM "MediaRetirementIntent" i JOIN "MediaStoredComponent" c ON c.id=i."componentId" JOIN "MediaUploadReceipt" r ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey" WHERE c.namespace=\'lottery-image\' AND c.policy=\'PHOTO_VARIANT\' AND c."objectKey"=ANY(?::text[]) AND r.scope=\'lottery-image\' AND r."accountId"=? AND r.state=\'COMMITTED\' AND r."objectIdentity"=c."objectKey" AND r."attemptId"=c.generation ) AS found'
    );
    assert.equal(values[1], owner);
    assert.equal(values[0].length, 1);
    assert.match(values[0][0], new RegExp('^lottery:' + owner + ':[a-f0-9-]{36}$'));
    return [{ found: false }];
  }
};
const input = {
  idempotencyKey: randomUUID(),
  title: 'Synthetic prize',
  kind: 'ORDINARY',
  mode: 'MANUAL',
  audience: 'MEMBER',
  month: null,
  minDays: null,
  prizes: [{ name: 'One', quantity: 2 }],
  drawAt: '2035-01-01T20:00:00+08:00'
};
test('optional image is backward compatible; unsafe sources are rejected and winners retain name semantics', () => {
  assert.deepEqual(validateLottery(input, new Date()).prizes, input.prizes);
  const prizes = [{ name: 'One', quantity: 2, imageUrl }];
  assert.deepEqual(validateLottery({ ...input, prizes }, new Date()).prizes, prizes);
  for (const value of [
    'https://external.invalid/private',
    '//external.invalid/image',
    'data:image/png;base64,AAA',
    '/api/wishes/media/' + image,
    imageUrl + '?token=private',
    '/api/lotteries/media/../../secret'
  ]) {
    assert.throws(() =>
      validateLottery({ ...input, prizes: [{ name: 'One', quantity: 2, imageUrl: value }] }, new Date())
    );
  }
  assert.deepEqual(
    selectWinners(
      [{ id: owner, displayName: 'Synthetic', membership: 'MEMBER', active: true }],
      prizes,
      () => 0
    ),
    [{ accountId: owner, gameNickname: 'Synthetic', prize: 'One' }]
  );
});
test('stored originals and thumbnails survive; only the owner can attach uploads', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'artzoo-lottery-qc-'));
  process.env.ARTZOO_LOTTERY_ORIGINAL_DIR = join(folder, 'original');
  process.env.ARTZOO_LOTTERY_DERIVED_DIR = join(folder, 'derived');
  try {
    const source = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#436B4E' } })
      .png()
      .toBuffer();
    const output = await processPhoto(source, 'synthetic.png'),
      store = lotteryStorage(owner);
    await store.put(image, output);
    assert.deepEqual(await store.read(image, 'original'), source);
    assert.ok((await store.read(image, 'thumbnail')).length > 0);
    assert.ok((await store.read(image, 'preview')).length > 0);
    await assertLotteryImages([{ imageUrl }], owner, unfencedImageTx);
    await assert.rejects(
      () => assertLotteryImages([{ imageUrl }], randomUUID(), unfencedImageTx),
      (error) => error.status === 403
    );
    await assert.rejects(
      () =>
        assertLotteryImages(
          [{ imageUrl: `/api/lotteries/media/${owner}/${randomUUID()}` }],
          owner,
          unfencedImageTx
        ),
      (error) => error.status === 400
    );
    await assertLotteryImages([{}], owner, unfencedImageTx);
  } finally {
    delete process.env.ARTZOO_LOTTERY_ORIGINAL_DIR;
    delete process.env.ARTZOO_LOTTERY_DERIVED_DIR;
    await rm(folder, { recursive: true, force: true });
  }
});
test('categories page in fives, clamp at the end, preserve cancelled state and issue no writes', async () => {
  const now = new Date(),
    actor = {
      id: randomUUID(),
      accountId: owner,
      expiresAt: new Date(+now + 60000),
      account: { phone: 'synthetic-not-a-phone' }
    };
  const rows = Array.from({ length: 14 }, (_, i) => ({
    id: randomUUID(),
    creatorId: owner,
    ...input,
    drawAt: new Date(input.drawAt),
    createdAt: new Date(+now - i),
    state: i < 7 ? 'OPEN' : i < 12 ? 'DRAWN' : 'CANCELLED',
    result: null
  }));
  let reads = 0;
  const tx = {
    $queryRaw: async (strings, ...values) => {
      reads++;
      const sql = strings.join('?');
      assert.ok(sql.includes('WHERE'));
      assert.ok(sql.includes("\"state\" IN ('DRAWN','CANCELLED')"));
      const search = values[0],
        category = values[1];
      assert.equal(search, '');
      assert.ok(values.slice(1, 4).every((v) => v === category));
      const filtered = rows.filter(
        (row) => category === 'all' || (category === 'ongoing' ? row.state === 'OPEN' : row.state !== 'OPEN')
      );
      if (sql.includes('count(*)')) return [{ total: filtered.length }];
      const [limit, offset] = values.slice(-2);
      assert.equal(limit, 5);
      assert.ok(sql.includes('ORDER BY "createdAt" DESC,"id" DESC'));
      return filtered.slice(offset, offset + limit);
    },
    lotteryEntry: { findMany: async () => [] },
    account: {
      findUnique: async () => ({ id: owner, displayName: 'Synthetic', membership: 'MEMBER' }),
      findMany: async () => [{ id: owner, displayName: 'Synthetic' }]
    },
    $executeRaw: () => assert.fail('read-only list must never write')
  };
  const auth = { db: tx, now: () => now, requireAccount: async () => actor, transaction: (fn) => fn(tx) };
  const service = new LotteryService(auth, { accountActive: async () => true });
  const before = structuredClone(rows);
  for (const category of ['ongoing', 'completed', 'all']) {
    const first = await service.list('synthetic-token', 1, category),
      last = await service.list('synthetic-token', 999, category);
    assert.equal(first.pageSize, 5);
    assert.equal(first.items.length, 5);
    assert.equal(first.total, category === 'all' ? 14 : 7);
    assert.equal(last.page, category === 'all' ? 3 : 2);
    assert.equal(last.items.length, category === 'all' ? 4 : 2);
    if (category === 'ongoing') assert.ok(first.items.every((row) => row.state === 'OPEN'));
    if (category === 'completed') assert.ok(last.items.every((row) => row.state === 'CANCELLED'));
  }
  assert.deepEqual(rows, before);
  const beforeInvalid = reads;
  for (const page of [0, -1, '1.5', '1;SELECT 1'])
    await assert.rejects(
      () => service.list('synthetic-token', page, 'ongoing'),
      (error) => error.status === 400
    );
  await assert.rejects(
    () => service.list('synthetic-token', 1, 'invalid'),
    (error) => error.status === 400
  );
  assert.equal(reads, beforeInvalid);
});
