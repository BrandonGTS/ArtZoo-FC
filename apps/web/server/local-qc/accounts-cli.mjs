import { assertQcCliContext } from './core.ts';
// Check before database access or accepting private input. Never accept values via args/env.
assertQcCliContext({
  argv: process.argv.slice(2),
  stdinTTY: Boolean(process.stdin.isTTY),
  stdoutTTY: Boolean(process.stdout.isTTY),
  environment: process.env
});
const { getDatabase } = await import('@artzoo/db');
const { validatePassword } = await import('@artzoo/domain');
const { QC_ACTORS, preflightQcAccounts, provisionLocalQcAccounts } = await import('./core.ts');
const { readHiddenLine } = await import('./hidden-input.ts');
const { mainlandChinaPhone } = await import('../auth/ports.ts');
const { hashSecret } = await import('../auth/crypto.ts');
const db = getDatabase(),
  inputs = [];
try {
  const state = await preflightQcAccounts(db);
  console.log('目标：家庭本地 localhost:3100 / artzoo_dev，命名空间 artzoo-local-qc-v1。');
  if (state.bindings) {
    console.log(
      JSON.stringify({
        created: false,
        bindings: state.bindings,
        message: '四个账号已存在；不重置密码、不改身份。'
      })
    );
  } else {
    console.log('将新增四个标记为[虚构QC-V1]的账号；不会发短信、创建会话或授予管理权限。');
    console.log('请输入四个由你控制、未注册的手机号和各自口令。所有输入均不回显，不记录。');
    console.log(
      '账号属于正常本地用户；之后新建的自动/月度抽奖可能纳入这些账号。48小时QC结束后请自行决定停用。'
    );
    const confirmation = await readHiddenLine(
      '确认手机号均由你控制，并同意本地新增：输入 CREATE_FOUR_LOCAL_QC_ACCOUNTS：',
      { maxLength: 60, accepts: /^[A-Z_]$/ }
    );
    if (confirmation !== 'CREATE_FOUR_LOCAL_QC_ACCOUNTS') throw Error('cancelled');
    for (const actor of QC_ACTORS) {
      let phone = '',
        password = '',
        repeated = '';
      try {
        phone = mainlandChinaPhone.normalize(
          await readHiddenLine(`${actor.slot} 手机号（不回显）：`, { maxLength: 20, accepts: /^[+0-9]$/ })
        );
        password = await readHiddenLine(`${actor.slot} 口令（6–30位可打印ASCII，不回显）：`, {
          maxLength: 30,
          accepts: /^[\x20-\x7e]$/
        });
        repeated = await readHiddenLine(`${actor.slot} 再输入口令：`, {
          maxLength: 30,
          accepts: /^[\x20-\x7e]$/
        });
        validatePassword(password, repeated);
        inputs.push({ slot: actor.slot, phone, passwordHash: await hashSecret(password) });
      } finally {
        phone = '';
        password = '';
        repeated = '';
      }
    }
    const result = await provisionLocalQcAccounts(db, inputs, { confirmation });
    console.log(JSON.stringify(result));
    console.log(
      '四个账号管理权限均为NONE。请用你现有SUPER在原管理页面仅给admin槽位授予ADMIN，再运行qc:import。'
    );
  }
} catch {
  process.stderr.write(
    '未完成：已取消、输入不符，或安全前检/目标/状态不允许。不会覆盖现有账号；未输出私密输入。\n'
  );
  process.exitCode = 1;
} finally {
  for (const input of inputs) {
    input.phone = '';
    input.passwordHash = '';
  }
  inputs.length = 0;
  await db.$disconnect();
}
