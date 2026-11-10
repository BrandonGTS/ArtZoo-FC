import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertProductionOwnerCliContext } from '../../apps/web/server/auth/production-owner-cli-policy.ts';
import { assertOwnerCliContext } from '../../apps/web/server/auth/owner-cli-policy.ts';
import { initializeSuperAdministrator } from '../../apps/web/server/auth/initialize-super-admin.ts';
import { mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import { MemoryDb } from './support/memory-db.mjs';
const environment = {
  ARTZOO_OWNER_INITIALIZATION: 'production-console',
  ARTZOO_DEPLOYMENT_ENV: 'production',
  ARTZOO_PUBLIC_ORIGIN: 'https://artzoo-fc.cn',
  PGHOST: 'postgres',
  PGPORT: '5432',
  PGUSER: 'artzoo_app',
  PGDATABASE: 'artzoo_prod',
  PGPASSWORD: 'public-test-value'
};
const context = { argv: [], stdinTTY: true, stdoutTTY: true, environment };
test('production console requires exact production deployment, target and two TTYs', () => {
  assert.doesNotThrow(() => assertProductionOwnerCliContext(context));
  for (const key of Object.keys(environment))
    assert.throws(() =>
      assertProductionOwnerCliContext({ ...context, environment: { ...environment, [key]: '' } })
    );
  for (const patch of [{ argv: ['public-test-value'] }, { stdinTTY: false }, { stdoutTTY: false }])
    assert.throws(() => assertProductionOwnerCliContext({ ...context, ...patch }));
  for (const [key, value] of [
    ['ARTZOO_DEPLOYMENT_ENV', 'local'],
    ['ARTZOO_PUBLIC_ORIGIN', 'http://artzoo-fc.cn'],
    ['ARTZOO_PUBLIC_ORIGIN', 'https://www.artzoo-fc.cn'],
    ['ARTZOO_PUBLIC_ORIGIN', 'https://artzoo-fc.cn/'],
    ['PGDATABASE', 'artzoo_dev'],
    ['PGUSER', 'artzoo_dev'],
    ['PGHOST', 'localhost'],
    ['PGPORT', '5433'],
    ['DATABASE_URL', 'public-test-value'],
    ['SSH_CONNECTION', 'present'],
    ['SSH_CLIENT', 'present'],
    ['SSH_TTY', 'present']
  ])
    assert.throws(() =>
      assertProductionOwnerCliContext({ ...context, environment: { ...environment, [key]: value } })
    );
});
test('production authorization does not permit the original local initializer', () => {
  assert.throws(() => assertOwnerCliContext(context));
  assert.throws(() =>
    assertProductionOwnerCliContext({
      ...context,
      environment: { ARTZOO_DEPLOYMENT_ENV: 'local', ARTZOO_PUBLIC_ORIGIN: 'http://localhost:3100' }
    })
  );
});
test('actual production CLI refuses piped input before DB access and redacts all values', () => {
  for (const argv of [[], ['public-sensitive-argument']]) {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        './scripts/auth-cli-loader.mjs',
        './apps/web/server/auth/production-owner-init-cli.mjs',
        ...argv
      ],
      {
        cwd: new URL('../../', import.meta.url),
        env: { PATH: process.env.PATH, ...environment },
        input: 'public-sensitive-input\n',
        encoding: 'utf8',
        timeout: 10000
      }
    );
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /生产初始化未完成/);
    for (const text of ['public-sensitive', 'public-test-value', 'Prisma', 'Stack', 'PGPASSWORD'])
      assert.equal(child.stderr.includes(text), false);
  }
});
const input = {
  phone: '+8613800000091',
  membership: 'MEMBER',
  password: 'public!Test7',
  confirmPassword: 'public!Test7',
  confirmation: 'INITIALIZE_CONFIRMED_OWNER'
};
test('production initialization records truthful production audit with original transaction semantics', async () => {
  const db = new MemoryDb();
  await initializeSuperAdministrator(db, mainlandChinaPhone, input, 'production-console');
  assert.equal(db.rows.account.length, 1);
  assert.equal(db.rows.account[0].adminRole, 'SUPER_ADMIN');
  assert.equal(db.rows.accountAudit[0].reason, '用户本人通过受控生产控制台初始化流程指定');
  await assert.rejects(
    () =>
      initializeSuperAdministrator(
        db,
        mainlandChinaPhone,
        { ...input, phone: '+8613800000092' },
        'production-console'
      ),
    (e) => e.code === 'CONFLICT'
  );
  assert.equal(db.rows.account.length, 1);
  assert.equal(db.rows.accountAudit.length, 1);
});
test('production never overwrites existing account and audit failure rolls back', async () => {
  const existing = new MemoryDb();
  await existing.account.create({
    data: { phone: input.phone, membership: 'MEMBER', adminRole: 'NONE', passwordHash: 'public-old-fixture' }
  });
  const before = structuredClone(existing.rows);
  await assert.rejects(() =>
    initializeSuperAdministrator(existing, mainlandChinaPhone, input, 'production-console')
  );
  assert.deepEqual(existing.rows, before);
  const failing = new MemoryDb();
  failing.fail = 'accountAudit.create';
  await assert.rejects(() =>
    initializeSuperAdministrator(failing, mainlandChinaPhone, input, 'production-console')
  );
  assert.equal(failing.rows.account.length, 0);
  assert.equal(failing.rows.accountAudit.length, 0);
});
test('unrecognized audit context and invalid input have no side effects', async () => {
  for (const patch of [
    { confirmation: 'no' },
    { confirmPassword: 'different7' },
    { membership: 'SUPER_ADMIN' }
  ]) {
    const db = new MemoryDb();
    await assert.rejects(() =>
      initializeSuperAdministrator(db, mainlandChinaPhone, { ...input, ...patch }, 'production-console')
    );
    assert.equal(db.rows.account.length, 0);
  }
  const db = new MemoryDb();
  await assert.rejects(() => initializeSuperAdministrator(db, mainlandChinaPhone, input, 'unknown'));
  assert.equal(db.rows.account.length, 0);
});
