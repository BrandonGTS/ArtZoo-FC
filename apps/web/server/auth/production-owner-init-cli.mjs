import { assertProductionOwnerCliContext } from './production-owner-cli-policy.ts';
let db;
try {
  assertProductionOwnerCliContext({
    argv: process.argv.slice(2),
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    environment: process.env
  });
  const { getDatabase, assertLocalQcDatabaseAllowed } = await import('@artzoo/db');
  const { mainlandChinaPhone } = await import('./ports.ts');
  const { runOwnerInitialization } = await import('./owner-initialization-console.ts');
  db = getDatabase();
  const identity = await db.$queryRaw`SELECT current_database() AS database, current_user AS role`;
  if (identity.length !== 1 || identity[0].database !== 'artzoo_prod' || identity[0].role !== 'artzoo_app')
    throw new Error('Database identity mismatch');
  await assertLocalQcDatabaseAllowed(db);
  if (await db.account.count({ where: { adminRole: 'SUPER_ADMIN' } }))
    throw Object.assign(new Error(), { code: 'CONFLICT' });
  process.stdout.write(
    '仅用于已核对的香港 ArtZoo 正式站 https://artzoo-fc.cn，将创建用户本人首位 SUPER_ADMIN 并记录生产审计。不会覆盖或提权已有账号。\n'
  );
  await runOwnerInitialization(db, mainlandChinaPhone, 'production-console');
  process.stdout.write('正式站首位超级管理员已创建，请回到 https://artzoo-fc.cn/login 登录。\n');
} catch (error) {
  const messages = {
    CONFLICT: '初始化被拒绝：已有超级管理员或该手机号已有账号，未覆盖或提权。',
    VALIDATION_ERROR: '输入无效或两次密码不一致，初始化未完成。',
    FORBIDDEN: '未确认本人初始化，操作已取消。'
  };
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  process.stderr.write(
    (Object.hasOwn(messages, code)
      ? messages[code]
      : '生产初始化未完成：请核查直接控制台TTY、固定生产来源和数据库、迁移；不要提交口令或诊断秘密。') + '\n'
  );
  process.exitCode = 1;
} finally {
  if (db) {
    try {
      await db.$disconnect();
    } catch {
      process.stderr.write('数据库连接关闭失败，请检查服务状态。\n');
      process.exitCode = 1;
    }
  }
}
