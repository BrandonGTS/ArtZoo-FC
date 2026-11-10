// 数据库测试的共用工具：每个测试文件拿到一个全新的空数据库，跑完全部迁移，用完即删。
//
// 只允许连接本机的一次性 PostgreSQL（127.0.0.1 / localhost / ::1），
// 连接地址来自环境变量 ARTZOO_TEST_DATABASE_URL，例如：
//   postgres://postgres:postgres@127.0.0.1:55432/postgres
// 新建的数据库名一律以 artzoo_test_ 开头，测试结束后强制删除。
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const requireDb = createRequire(new URL('../../packages/db/package.json', import.meta.url));
const { Pool } = requireDb('pg');
const { PrismaPg } = requireDb('@prisma/adapter-pg');
const migrations = new URL('../../packages/db/prisma/migrations/', import.meta.url);
const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function adminConfig() {
  const raw = process.env.ARTZOO_TEST_DATABASE_URL;
  if (!raw) throw new Error('缺少 ARTZOO_TEST_DATABASE_URL');
  const url = new URL(raw);
  if (!LOCAL.has(url.hostname)) throw new Error('测试数据库只能在本机：' + url.hostname);
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username || 'postgres'),
    password: decodeURIComponent(url.password || ''),
    database: url.pathname.slice(1) || 'postgres'
  };
}

export async function createTestDatabase() {
  const config = adminConfig();
  const name = 'artzoo_test_' + randomBytes(6).toString('hex');
  const admin = new Pool({ ...config, max: 1 });
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const pool = new Pool({
    ...config,
    database: name,
    max: 12,
    connectionTimeoutMillis: 5000,
    application_name: 'artzoo-test'
  });
  pool.on('error', () => {});
  for (const dir of readdirSync(migrations, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    try {
      await pool.query(readFileSync(new URL(`${dir}/migration.sql`, migrations), 'utf8'));
    } catch (error) {
      throw new Error(`迁移 ${dir} 执行失败：${error.message}`);
    }
  }
  const { PrismaClient } = await import('../../packages/db/src/generated/prisma/client.ts');
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });

  return {
    name,
    pool,
    db,
    connection: { ...config, database: name },
    async close() {
      await db.$disconnect().catch(() => {});
      await pool.end().catch(() => {});
      const cleanup = new Pool({ ...config, max: 1 });
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.end();
    }
  };
}
