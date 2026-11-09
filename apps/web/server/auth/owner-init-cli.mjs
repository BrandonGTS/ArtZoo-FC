import { assertOwnerCliContext } from './owner-cli-policy.ts';

let db;
try {
  assertOwnerCliContext({
    argv: process.argv.slice(2),
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    environment: process.env
  });
  const { getDatabase } = await import('@artzoo/db');
  const { mainlandChinaPhone } = await import('./ports.ts');
  const { runOwnerInitialization } = await import('./owner-initialization-console.ts');
  db = getDatabase();
  // Fail before personal input when the checked local database is unavailable.
  await db.$queryRaw`SELECT 1::int AS ok`;
  process.stdout.write(
    '仅用于已核对的家庭 ArtZoo Next 本地开发库。将创建用户本人 SUPER_ADMIN，并记录审计；不会覆盖或提权已有账号。\n'
  );
  await runOwnerInitialization(db, mainlandChinaPhone);
  process.stdout.write('本人超级管理员已创建。请回到 http://localhost:3100 登录。\n');
} catch (error) {
  // Never print the raw error/stack: driver failures may contain connection details.
  const messages = {
    CONFLICT: '初始化被拒绝：已有超级管理员或该手机号已有账号，未覆盖或提权。',
    VALIDATION_ERROR: '输入无效或两次密码不一致，初始化未完成。',
    FORBIDDEN: '未确认本人初始化，操作已取消。'
  };
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  process.stderr.write(
    (Object.hasOwn(messages, code)
      ? messages[code]
      : '初始化未完成。请检查本地 TTY、无参数调用、local 来源、数据库迁移及连接；不要提交密码或诊断秘密。') +
      '\n'
  );
  process.exitCode = 1;
} finally {
  if (db) {
    try {
      await db.$disconnect();
    } catch {
      process.stderr.write('数据库连接关闭失败，请检查本地服务状态。\n');
      process.exitCode = 1;
    }
  }
}
