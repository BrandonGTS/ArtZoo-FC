import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { loadSmsSender } from '../../apps/web/server/auth/sms-config.ts';
import { assertOwnerCliContext } from '../../apps/web/server/auth/owner-cli-policy.ts';
import { initializeSuperAdministrator } from '../../apps/web/server/auth/initialize-super-admin.ts';
import { mainlandChinaPhone, authConfig } from '../../apps/web/server/auth/ports.ts';
import { MemoryDb } from './support/memory-db.mjs';

const config = {
  ARTZOO_SMS_PROVIDER: 'aliyun-pnvs',
  ARTZOO_SMS_ACCESS_KEY_ID: 'syntheticId',
  ARTZOO_SMS_ACCESS_KEY_SECRET: 'syntheticSecret!$#',
  ARTZOO_SMS_SIGN_NAME: '测试签名',
  ARTZOO_SMS_REGISTER_TEMPLATE_CODE: '100001',
  ARTZOO_SMS_RESET_TEMPLATE_CODE: '100003'
};
const neverSend = async () => {
  throw Error('Unexpected transport invocation');
};
test('SMS absent/explicitly unconfigured stays unavailable without credentials or network', async () => {
  for (const env of [{}, { ARTZOO_SMS_PROVIDER: 'unconfigured' }]) {
    const sms = loadSmsSender(env, neverSend);
    assert.deepEqual(authConfig(mainlandChinaPhone, sms).sms, { mode: 'unconfigured', available: false });
    await assert.rejects(
      () => sms.send({}),
      (error) => error.code === 'SMS_UNAVAILABLE'
    );
  }
});
test('SMS complete configuration exposes only availability and sends only on explicit send', async () => {
  let calls = 0;
  const sms = loadSmsSender(config, async (url) => {
    calls++;
    assert.deepEqual(JSON.parse(new URL(url).searchParams.get('TemplateParam')), {
      code: '123456',
      min: '5'
    });
    return Response.json({ Code: 'OK', Success: true });
  });
  assert.equal(calls, 0);
  const publicConfig = JSON.stringify(authConfig(mainlandChinaPhone, sms));
  for (const key of Object.keys(config)) assert.equal(publicConfig.includes(config[key]), false);
  await sms.send({ phone: '+8613800000001', code: '123456', purpose: 'REGISTER' });
  assert.equal(calls, 1);
});
test('SMS missing fields, implicit credentials, unknown modes and mock modes fail closed', () => {
  const cases = Object.keys(config).map((key) => ({ ...config, [key]: '' }));
  cases.push({ ...config, ARTZOO_SMS_PROVIDER: 'unconfigured' });
  for (const NODE_ENV of ['production', 'development', 'test'])
    cases.push({ ...config, NODE_ENV, ARTZOO_SMS_PROVIDER: 'mock' });
  cases.push({ ...config, ARTZOO_SMS_PROVIDER: 'other' });
  for (const env of cases)
    assert.throws(
      () => loadSmsSender(env, neverSend),
      (error) => error.code === 'SMS_UNAVAILABLE' && !JSON.stringify(error).includes('synthetic')
    );
});
test('SMS values reject whitespace/control characters, invalid template and oversized values without leaking them', () => {
  const cases = Object.keys(config)
    .filter((key) => key !== 'ARTZOO_SMS_PROVIDER')
    .flatMap((key) =>
      [' leading', 'trailing ', 'line\nsecret', '\0secret', 'x'.repeat(300)].map((value) => ({
        ...config,
        [key]: value
      }))
    );
  cases.push({ ...config, ARTZOO_SMS_REGISTER_TEMPLATE_CODE: 'not-a-template' });
  for (const env of cases)
    assert.throws(
      () => loadSmsSender(env, neverSend),
      (error) =>
        error.code === 'SMS_UNAVAILABLE' && error.message === '短信配置不完整或无效，请由本机操作者检查配置'
    );
});
test('SMS unknown provider, swapped and other gifted templates are rejected', () => {
  const cases = [
    { ...config, ARTZOO_SMS_PROVIDER: 'aliyun' },
    { ...config, ARTZOO_SMS_REGISTER_TEMPLATE_CODE: 'SMS_123456' },
    { ...config, ARTZOO_SMS_REGISTER_TEMPLATE_CODE: '100003', ARTZOO_SMS_RESET_TEMPLATE_CODE: '100001' },
    { ...config, ARTZOO_SMS_RESET_TEMPLATE_CODE: '100002' }
  ];
  for (const env of cases)
    assert.throws(
      () => loadSmsSender(env, neverSend),
      (error) =>
        error.code === 'SMS_UNAVAILABLE' && error.message === '短信配置不完整或无效，请由本机操作者检查配置'
    );
});
const local = {
  argv: [],
  stdinTTY: true,
  stdoutTTY: true,
  environment: { ARTZOO_DEPLOYMENT_ENV: 'local', ARTZOO_PUBLIC_ORIGIN: 'http://localhost:3100' }
};
test('owner CLI requires exact local origin, two TTYs, no arguments and no SSH session', () => {
  assert.doesNotThrow(() => assertOwnerCliContext(local));
  const cases = [
    { ...local, argv: ['synthetic-password'] },
    { ...local, stdinTTY: false },
    { ...local, stdoutTTY: false }
  ];
  for (const [key, value] of [
    ['ARTZOO_DEPLOYMENT_ENV', 'production'],
    ['ARTZOO_DEPLOYMENT_ENV', ''],
    ['ARTZOO_PUBLIC_ORIGIN', 'http://192.168.1.2:3100'],
    ['ARTZOO_PUBLIC_ORIGIN', 'http://localhost:3100/'],
    ['SSH_CONNECTION', 'synthetic'],
    ['SSH_CLIENT', 'synthetic'],
    ['SSH_TTY', 'synthetic']
  ]) {
    cases.push({ ...local, environment: { ...local.environment, [key]: value } });
  }
  for (const context of cases) assert.throws(() => assertOwnerCliContext(context));
});
test('actual CLI rejects piped input/arguments before database access and does not echo input or environment', () => {
  for (const args of [[], ['synthetic-secret-argument']]) {
    const child = spawnSync(
      process.execPath,
      ['--import', './scripts/auth-cli-loader.mjs', './apps/web/server/auth/owner-init-cli.mjs', ...args],
      {
        cwd: new URL('../../', import.meta.url),
        env: {
          PATH: process.env.PATH,
          ...local.environment,
          PGHOST: 'synthetic.invalid',
          PGUSER: 'synthetic',
          PGDATABASE: 'synthetic',
          PGPASSWORD: 'synthetic-secret-db'
        },
        input: 'synthetic-secret-input\n',
        encoding: 'utf8',
        timeout: 10000
      }
    );
    assert.equal(child.status, 1);
    assert.match(child.stderr, /初始化未完成/);
    assert.equal(child.stdout, '');
    assert.equal((child.stdout + child.stderr).includes('synthetic'), false);
    assert.equal(child.stderr.includes('Prisma'), false);
  }
});
const ownerInput = {
  phone: '+8613800000011',
  membership: 'MEMBER',
  password: 'synthetic!7',
  confirmPassword: 'synthetic!7',
  confirmation: 'INITIALIZE_CONFIRMED_OWNER'
};
test('owner initialization in memory creates one administrator and audit atomically, rejects a repeat', async () => {
  const db = new MemoryDb();
  const result = await initializeSuperAdministrator(db, mainlandChinaPhone, ownerInput);
  assert.equal(db.rows.account.length, 1);
  assert.equal(db.rows.accountAudit.length, 1);
  assert.equal(db.rows.account[0].adminRole, 'SUPER_ADMIN');
  assert.equal(db.rows.accountAudit[0].actorId, result.accountId);
  assert.notEqual(db.rows.account[0].passwordHash, ownerInput.password);
  await assert.rejects(
    () => initializeSuperAdministrator(db, mainlandChinaPhone, { ...ownerInput, phone: '+8613800000012' }),
    (error) => error.code === 'CONFLICT'
  );
  assert.equal(db.rows.account.length, 1);
  assert.equal(db.rows.accountAudit.length, 1);
});
test('owner initialization never overwrites or elevates an existing account', async () => {
  const db = new MemoryDb();
  await db.account.create({
    data: {
      phone: ownerInput.phone,
      membership: 'FRIEND',
      adminRole: 'NONE',
      passwordHash: 'synthetic-existing-hash'
    }
  });
  const before = structuredClone(db.rows);
  await assert.rejects(
    () => initializeSuperAdministrator(db, mainlandChinaPhone, ownerInput),
    (error) => error.code === 'CONFLICT'
  );
  assert.deepEqual(db.rows, before);
});
test('owner invalid confirmation, identity and password mismatch do not create anything', async () => {
  for (const patch of [
    { confirmation: 'no' },
    { membership: 'SUPER_ADMIN' },
    { confirmPassword: 'different!7' }
  ]) {
    const db = new MemoryDb();
    await assert.rejects(() =>
      initializeSuperAdministrator(db, mainlandChinaPhone, { ...ownerInput, ...patch })
    );
    assert.equal(db.rows.account.length, 0);
    assert.equal(db.rows.accountAudit.length, 0);
  }
});
test('owner audit failure rolls back the synthetic account', async () => {
  const db = new MemoryDb();
  db.fail = 'accountAudit.create';
  await assert.rejects(() => initializeSuperAdministrator(db, mainlandChinaPhone, ownerInput));
  assert.equal(db.rows.account.length, 0);
  assert.equal(db.rows.accountAudit.length, 0);
});
