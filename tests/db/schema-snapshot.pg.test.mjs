// 数据库结构快照检查：跑完全部迁移后的结构，必须和 packages/db/prisma/schema-snapshot.txt 完全一致。
// 任何迁移改动（包括 schema.prisma 写不出来的检查约束、带条件的唯一索引、触发器、函数、初始数据）
// 都会让这个测试失败，提醒同时更新快照：pnpm db:snapshot --write
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../_shared/database.mjs';
import { savedSnapshot, schemaSnapshot, snapshotDiff } from '../_shared/schema-snapshot.mjs';

test('running all migrations on an empty database produces exactly the saved schema snapshot', async () => {
  const saved = savedSnapshot();
  assert.ok(saved, '缺少 packages/db/prisma/schema-snapshot.txt，请先运行 pnpm db:snapshot --write 生成');
  const testDb = await createTestDatabase();
  try {
    const diff = snapshotDiff(saved, await schemaSnapshot(testDb.pool));
    if (diff.length)
      assert.fail('\n' + diff.join('\n') + '\n\n有意修改结构时，运行 pnpm db:snapshot --write 更新快照。');
  } finally {
    await testDb.close();
  }
});

test('the snapshot is stable: two fresh databases produce identical text', async () => {
  const one = await createTestDatabase(),
    two = await createTestDatabase();
  try {
    assert.equal(await schemaSnapshot(one.pool), await schemaSnapshot(two.pool));
  } finally {
    await one.close();
    await two.close();
  }
});
