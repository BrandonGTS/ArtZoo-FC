import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeSuperAdministrator } from '../../apps/web/server/auth/initialize-super-admin.ts';
import { mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import { MemoryDb } from './support/memory-db.mjs';
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
