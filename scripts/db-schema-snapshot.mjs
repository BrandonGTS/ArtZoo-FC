// 数据库结构快照：检查或更新 packages/db/prisma/schema-snapshot.txt。
//
//   pnpm db:snapshot             检查：跑完全部迁移后的结构是否和保存的快照一致
//   pnpm db:snapshot --write     更新：把当前迁移的结果写入快照文件
//
// 需要 ARTZOO_TEST_DATABASE_URL 指向本机的一次性 PostgreSQL（和 pnpm test:pg 相同）。
// 脚本会新建一个临时空库、跑完全部迁移、生成快照，然后删除这个临时库，不会碰任何其他数据库。
// 改了迁移之后，先运行 --write 更新快照，再把迁移和快照放在同一个提交里。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '../tests/_shared/database.mjs';
import {
  SNAPSHOT_FILE,
  savedSnapshot,
  schemaSnapshot,
  snapshotDiff
} from '../tests/_shared/schema-snapshot.mjs';

const write = process.argv.includes('--write');
if (!process.env.ARTZOO_TEST_DATABASE_URL) {
  console.error('需要 ARTZOO_TEST_DATABASE_URL（指向一次性的测试 PostgreSQL，绝不能是正式库）。');
  process.exit(1);
}
const testDb = await createTestDatabase();
let current;
try {
  current = await schemaSnapshot(testDb.pool);
} finally {
  await testDb.close();
}
const path = fileURLToPath(SNAPSHOT_FILE);
if (write) {
  writeFileSync(path, current);
  console.log(`已写入 ${path}（${current.split('\n').length} 行）。`);
} else {
  const diff = snapshotDiff(savedSnapshot(), current);
  if (!diff.length) console.log('结构快照一致。');
  else {
    console.log('结构快照不一致：\n' + diff.join('\n'));
    console.log('\n如果这些变化是有意的，运行 pnpm db:snapshot --write 更新快照，并和迁移一起提交。');
    process.exit(1);
  }
}
