import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import type { PrismaClient } from '@artzoo/db';
import type { PhonePolicy } from './ports';
import { initializeSuperAdministrator, type OwnerInitializationContext } from './initialize-super-admin';

async function hiddenPassword(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stdout.isTTY)
    throw new Error('Initialization requires a local interactive terminal');
  process.stdout.write(prompt);
  emitKeypressEvents(input);
  const previousRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    function finish(error?: Error) {
      input.off('keypress', onKey);
      input.setRawMode(previousRaw);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
      value = '';
    }
    function onKey(character: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        finish(new Error('Initialization cancelled'));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish();
        return;
      }
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        return;
      }
      if (!key.ctrl && !key.meta && character && /^[\x20-\x7e]+$/.test(character)) value += character;
      if (value.length > 30) finish(new Error('Password exceeds 30 characters; initialization cancelled'));
    }
    input.on('keypress', onKey);
  });
}

/** Explicit local call only; no top-level execution, no CLI arguments or environment password. */
export async function runOwnerInitialization(
  db: PrismaClient,
  phonePolicy: PhonePolicy,
  auditContext: OwnerInitializationContext = 'local-console'
): Promise<{ accountId: string }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Initialization requires a local interactive terminal');
  if (!phonePolicy.ready)
    throw new Error('Confirm and implement the phone region policy before initialization');
  process.stdout.write(
    '此操作将授予用户本人最高管理职责 SUPER_ADMIN；公开注册不会授予此权限。取消请按 Ctrl+C。\n'
  );
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let phone: string, membership: string, confirmation: string;
  try {
    phone = await prompt.question('用户本人手机号：');
    membership = await prompt.question('参与身份（MEMBER 或 FRIEND）：');
    confirmation = await prompt.question('确认这是用户本人首位超管，输入 INITIALIZE_CONFIRMED_OWNER：');
  } finally {
    prompt.close();
  }
  if (confirmation !== 'INITIALIZE_CONFIRMED_OWNER') throw new Error('Initialization cancelled');
  let password = '',
    confirmPassword = '';
  try {
    password = await hiddenPassword('设置密码（输入不显示）：');
    confirmPassword = await hiddenPassword('再次输入密码（输入不显示）：');
    return await initializeSuperAdministrator(
      db,
      phonePolicy,
      { phone, membership, password, confirmPassword, confirmation },
      auditContext
    );
  } finally {
    password = '';
    confirmPassword = '';
  }
}
