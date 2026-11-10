import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { hashSecret, tokenDigest, verifySecret } from '../../apps/web/server/auth/crypto.ts';
import { mainlandChinaPhone, unavailableSms } from '../../apps/web/server/auth/ports.ts';
import { MemoryDb } from './support/memory-db.mjs';
const oldValue = 'synthetic-old-password',
  newValue = 'synthetic-new-password';
const oldHash = await hashSecret(oldValue);
async function fixture() {
  const db = new MemoryDb();
  let now = Date.parse('2030-01-01T00:00:00Z');
  const expires = now + 1000;
  const account = await db.account.create({
    data: {
      phone: '+8613800000099',
      passwordHash: oldHash,
      membership: 'MEMBER',
      adminRole: 'NONE',
      createdAt: new Date(now)
    }
  });
  const token = 'x'.repeat(43);
  for (const t of [token, 'y'.repeat(43)])
    await db.accountSession.create({
      data: {
        tokenHash: tokenDigest(t),
        accountId: account.id,
        createdAt: new Date(now),
        expiresAt: new Date(expires)
      }
    });
  const auth = new AccountService(db, {
    environment: 'test',
    phone: mainlandChinaPhone,
    sms: unavailableSms,
    now: () => new Date(now)
  });
  return {
    db,
    auth,
    token,
    account,
    expire() {
      now = expires + 1;
    },
    body: { currentPassword: oldValue, password: newValue, confirmPassword: newValue }
  };
}
const rejected = (e) => e.code === 'UNAUTHENTICATED' && e.status === 401;
async function unchanged(f) {
  assert.equal(f.db.rows.account[0].passwordVersion, 0);
  assert.equal(f.db.rows.account[0].passwordHash, oldHash);
  assert.ok(f.db.rows.accountSession.every((s) => s.revokedAt === null));
  assert.equal(await verifySecret(oldValue, f.db.rows.account[0].passwordHash), true);
}
test('normal change revokes both devices and takes account before session lock', async () => {
  const f = await fixture();
  assert.deepEqual(await f.auth.changePassword(f.body, f.token), { changed: true, requiresLogin: true });
  assert.equal(f.db.rows.account[0].passwordVersion, 1);
  assert.equal(await verifySecret(newValue, f.db.rows.account[0].passwordHash), true);
  assert.ok(f.db.rows.accountSession.every((s) => s.revokedAt));
  const locks = f.db.locks.filter((x) => [f.account.id, f.db.rows.accountSession[0].id].includes(x));
  assert.deepEqual(locks, [f.account.id, f.db.rows.accountSession[0].id]);
});
for (const stage of ['account-write', 'last-session-write', 'final-active-read'])
  test(`expiry during ${stage} rolls back password/version and every session`, async () => {
    const f = await fixture();
    if (stage === 'account-write') {
      const fn = f.db.account.update;
      f.db.account.update = async (args) => {
        const r = await fn(args);
        f.expire();
        return r;
      };
    }
    if (stage === 'last-session-write') {
      const fn = f.db.accountSession.updateMany;
      f.db.accountSession.updateMany = async (args) => {
        const r = await fn(args);
        f.expire();
        return r;
      };
    }
    if (stage === 'final-active-read') {
      const fn = f.db.accountSession.updateMany;
      let after = false;
      f.db.accountSession.updateMany = async (args) => {
        const r = await fn(args);
        after = true;
        return r;
      };
      const query = f.db.$queryRaw.bind(f.db);
      f.db.$queryRaw = async (strings, ...values) => {
        const r = await query(strings, ...values);
        if (after) f.expire();
        return r;
      };
    }
    await assert.rejects(() => f.auth.changePassword(f.body, f.token), rejected);
    await unchanged(f);
  });
test('account deactivated after password write is rejected with full rollback', async () => {
  const f = await fixture();
  let active = true;
  const query = f.db.$queryRaw.bind(f.db);
  f.db.$queryRaw = async (strings, ...values) => {
    const text = strings.join('');
    if (text.includes('to_regclass')) return [{ available: true }];
    if (text.includes('"active" FROM "LotteryAccountStatus"')) return [{ active }];
    return query(strings, ...values);
  };
  const update = f.db.account.update;
  f.db.account.update = async (args) => {
    const r = await update(args);
    active = false;
    return r;
  };
  await assert.rejects(() => f.auth.changePassword(f.body, f.token), rejected);
  await unchanged(f);
});
test('incorrect original password leaves password/version and other sessions untouched', async () => {
  const f = await fixture();
  await assert.rejects(
    () => f.auth.changePassword({ ...f.body, currentPassword: 'wrong' }, f.token),
    (e) => e.code === 'INVALID_CREDENTIALS'
  );
  await unchanged(f);
});
test('session revocation storage failure rolls back earlier password write', async () => {
  const f = await fixture();
  f.db.fail = 'accountSession.updateMany';
  await assert.rejects(() => f.auth.changePassword(f.body, f.token));
  await unchanged(f);
});
const countBucket = (db, key) => db.rows.accountRateEvent.filter((e) => e.key === tokenDigest(key)).length;
test('peek consumes neither source nor global bucket, and rejected consumption changes neither', async () => {
  const db = new MemoryDb(),
    auth = new AccountService(db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      writeSourceLimit: 2,
      now: () => new Date('2030-01-01')
    });
  await Promise.all(Array.from({ length: 12 }, () => auth.checkWriteSource('test-source')));
  assert.equal(db.rows.accountRateEvent.length, 0);
  await auth.limitWriteSource('test-source');
  await auth.checkWriteSource('test-source');
  assert.equal(countBucket(db, 'write:test-source'), 1);
  assert.equal(countBucket(db, 'write-global'), 1);
  assert.equal(db.rows.accountRateEvent.length, 2);
  await auth.limitWriteSource('test-source');
  const before = structuredClone(db.rows.accountRateEvent);
  for (const action of [
    () => auth.checkWriteSource('test-source'),
    () => auth.limitWriteSource('test-source')
  ])
    await assert.rejects(
      action,
      (e) => e.code === 'RATE_LIMITED' && e.status === 429 && e.retryAfterSeconds === 900
    );
  assert.deepEqual(db.rows.accountRateEvent, before);
  assert.equal(countBucket(db, 'write:test-source'), 2);
  assert.equal(countBucket(db, 'write-global'), 2);
  assert.equal(db.rows.accountRateEvent.length, 4);
});
test('exhausted global bucket rejects a new source without partial source consumption', async () => {
  const db = new MemoryDb(),
    auth = new AccountService(db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      writeSourceLimit: 10,
      writeGlobalLimit: 1,
      now: () => new Date('2030-01-01')
    });
  await auth.limitWriteSource('source-a');
  const before = structuredClone(db.rows.accountRateEvent);
  await assert.rejects(
    () => auth.limitWriteSource('source-b'),
    (e) => e.code === 'RATE_LIMITED' && e.status === 429
  );
  assert.deepEqual(db.rows.accountRateEvent, before);
  assert.equal(countBucket(db, 'write:source-a'), 1);
  assert.equal(countBucket(db, 'write:source-b'), 0);
  assert.equal(countBucket(db, 'write-global'), 1);
});
test('parser attempt limit is separate per actor and does not spend legal write allowance', async () => {
  const db = new MemoryDb(),
    auth = new AccountService(db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      writeSourceLimit: 2,
      now: () => new Date('2030-01-01')
    });
  await auth.limitWriteParsing('source', 'actor-a');
  await auth.limitWriteParsing('source', 'actor-a');
  await assert.rejects(
    () => auth.limitWriteParsing('source', 'actor-a'),
    (e) => e.code === 'RATE_LIMITED'
  );
  await auth.limitWriteParsing('source', 'actor-b');
  await auth.checkWriteSource('source');
  assert.equal(db.rows.accountRateEvent.filter((x) => x.key === tokenDigest('write:source')).length, 0);
  await auth.limitWriteSource('source');
  assert.equal(db.rows.accountRateEvent.filter((x) => x.key === tokenDigest('write:source')).length, 1);
});
test('consume remains atomic when concurrent requests pass the non-consuming check', async () => {
  const db = new MemoryDb(),
    auth = new AccountService(db, { phone: mainlandChinaPhone, sms: unavailableSms, writeSourceLimit: 2 });
  await Promise.all(Array.from({ length: 5 }, () => auth.checkWriteSource('source')));
  const r = await Promise.allSettled(Array.from({ length: 5 }, () => auth.limitWriteSource('source')));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 2);
  assert.equal(countBucket(db, 'write:source'), 2);
  assert.equal(countBucket(db, 'write-global'), 2);
  assert.equal(db.rows.accountRateEvent.length, 4);
});
