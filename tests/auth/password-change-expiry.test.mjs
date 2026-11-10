import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { hashSecret, tokenDigest } from '../../apps/web/server/auth/crypto.ts';
import { mainlandChinaPhone, unavailableSms } from '../../apps/web/server/auth/ports.ts';
import { MemoryDb } from './support/memory-db.mjs';
// The historical reproduction must now reject and roll back the repaired password transaction.
test('password change rejects expiry during account UPDATE and rolls back password/version/sessions', async () => {
  const db = new MemoryDb();
  let now = Date.parse('2030-01-01T00:00:00Z');
  const before = await hashSecret('synthetic-old-password');
  const account = await db.account.create({
    data: {
      phone: '+8613800000099',
      passwordHash: before,
      membership: 'MEMBER',
      adminRole: 'NONE',
      createdAt: new Date(now)
    }
  });
  const token = 'x'.repeat(43),
    expires = now + 1000;
  await db.accountSession.create({
    data: {
      tokenHash: tokenDigest(token),
      accountId: account.id,
      createdAt: new Date(now),
      expiresAt: new Date(expires)
    }
  });
  const update = db.account.update;
  db.account.update = async (args) => {
    now = expires + 1;
    return update(args);
  };
  const auth = new AccountService(db, {
    environment: 'test',
    phone: mainlandChinaPhone,
    sms: unavailableSms,
    now: () => new Date(now)
  });
  await assert.rejects(
    () =>
      auth.changePassword(
        {
          currentPassword: 'synthetic-old-password',
          password: 'synthetic-new-password',
          confirmPassword: 'synthetic-new-password'
        },
        token
      ),
    (e) => e.code === 'UNAUTHENTICATED' && e.status === 401
  );
  assert.equal(now > expires, true);
  assert.equal(db.rows.account[0].passwordVersion, 0);
  assert.equal(db.rows.account[0].passwordHash, before);
  assert.ok(db.rows.accountSession.every((s) => s.revokedAt === null));
});
