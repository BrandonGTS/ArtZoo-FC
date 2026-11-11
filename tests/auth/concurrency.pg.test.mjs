// 在真实 PostgreSQL 上验证内存替身证明不了的行为：
// 并发下的限流与短信日预算、事务回滚、锁等待后的权限复查、改密/重置后会话全部失效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import { hashSecret, tokenDigest, opaqueToken, verifySecret } from '../../apps/web/server/auth/crypto.ts';
import { GAME_SERVER_REGIONS } from '../../packages/domain/src/account-contract.ts';
import { createTestDatabase } from '../_shared/database.mjs';

test('账号：并发限流、短信预算、权限与会话（真实 PostgreSQL）', async (t) => {
  const testDb = await createTestDatabase();
  const { db, pool } = testDb;
  t.after(() => testDb.close());
  let now = new Date('2030-01-01T00:00:00.000Z'),
    sequence = 0;
  const phone = () => '+86139' + String(++sequence).padStart(8, '0');
  const defaultHash = await hashSecret('synthetic!8');
  async function account(role = 'NONE', passwordHash = defaultHash) {
    return db.account.create({
      data: {
        phone: phone(),
        passwordHash,
        membership: 'MEMBER',
        adminRole: role,
        displayName: 'tester-' + sequence,
        createdAt: now
      }
    });
  }
  async function session(account) {
    const token = opaqueToken();
    await db.accountSession.create({
      data: {
        tokenHash: tokenDigest(token),
        accountId: account.id,
        createdAt: now,
        expiresAt: new Date(+now + 30 * 86400000)
      }
    });
    return token;
  }
  function service(options = {}, database = db) {
    const inbox = [];
    const sms = {
      mode: 'mock',
      available: true,
      async send(value) {
        inbox.push(value);
      }
    };
    return {
      inbox,
      sms,
      instance: new AccountService(database, {
        phone: mainlandChinaPhone,
        sms,
        environment: 'test',
        now: () => new Date(now),
        smsResponseDelay: async () => {},
        ...options
      })
    };
  }
  const check = (name, fn) => t.test(name, fn);
  const fulfilled = (values) => values.filter((value) => value.status === 'fulfilled').length;
  const expect = (code) => (error) => error?.code === code;
  const actorA = await account(),
    actorB = await account(),
    tokenA = await session(actorA),
    tokenB = await session(actorB);
  const since = () => new Date(+now - 900000);
  const rateCount = (key) =>
    db.accountRateEvent.count({ where: { key: tokenDigest(key), createdAt: { gt: since() } } });
  const quotaErrors = (results) =>
    assert.ok(
      results
        .filter((r) => r.status === 'rejected')
        .every(
          (r) => r.reason.code === 'RATE_LIMITED' && r.reason.status === 429 && r.reason.retryAfterSeconds > 0
        )
    );
  await check('concurrent-account-quota-no-partial-IP-or-global-reservations', async () => {
    const s = service({ writeAccountLimit: 2, writeSourceLimit: 100, writeGlobalLimit: 100 }).instance;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => s.limitWriteSource('ip:account-' + i, tokenA))
    );
    assert.equal(fulfilled(results), 2);
    quotaErrors(results);
    assert.equal(await rateCount('write-account:' + actorA.id), 2);
    assert.equal(await rateCount('write-global'), 2);
    assert.equal(await db.accountRateEvent.count({ where: { createdAt: { gt: since() } } }), 6);
    await s.limitWriteSource('ip:other-account', tokenB);
    assert.equal(await rateCount('write-account:' + actorB.id), 1);
  });
  now = new Date(+now + 16 * 60000);
  await check('concurrent-IP-quota-no-partial-account-or-global-reservations', async () => {
    const s = service({ writeAccountLimit: 100, writeSourceLimit: 2, writeGlobalLimit: 100 }).instance;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => s.limitWriteSource('ip:shared', i % 2 ? tokenA : tokenB))
    );
    assert.equal(fulfilled(results), 2);
    quotaErrors(results);
    assert.equal(await rateCount('write:ip:shared'), 2);
    assert.equal(await rateCount('write-global'), 2);
    assert.equal(await db.accountRateEvent.count({ where: { createdAt: { gt: since() } } }), 6);
  });
  now = new Date(+now + 16 * 60000);
  await check('concurrent-global-quota-atomically-bounds-all-write-buckets', async () => {
    const s = service({ writeAccountLimit: 100, writeSourceLimit: 100, writeGlobalLimit: 3 }).instance;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => s.limitWriteSource('ip:global-' + i, i % 2 ? tokenA : tokenB))
    );
    assert.equal(fulfilled(results), 3);
    quotaErrors(results);
    assert.equal(await rateCount('write-global'), 3);
    assert.equal(await db.accountRateEvent.count({ where: { createdAt: { gt: since() } } }), 9);
  });
  now = new Date('2030-01-02T08:00:00Z');
  await check('reset-unknown-virtual-code-and-registered-delivery-have-identical-metadata', async () => {
    const { instance: s, inbox } = service(),
      missing = phone();
    const virtual = await s.sendCode({ phone: missing, purpose: 'RESET_PASSWORD' });
    assert.equal(inbox.length, 0);
    const record = await db.verificationCode.findFirst({ where: { phone: missing } });
    assert.ok(record.invalidatedAt);
    assert.equal(+record.expiresAt, +record.createdAt);
    assert.equal(record.deliveredAt, null);
    await assert.rejects(
      () =>
        s.resetPassword({
          phone: missing,
          code: '123456',
          password: 'newpass8',
          confirmPassword: 'newpass8'
        }),
      expect('CODE_INVALID')
    );
    const real = await s.sendCode({ phone: actorA.phone, purpose: 'RESET_PASSWORD' });
    assert.deepEqual(real, virtual);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].purpose, 'RESET_PASSWORD');
    const active = await db.verificationCode.findFirst({ where: { phone: actorA.phone } });
    assert.ok(active.deliveredAt);
    assert.equal(await verifySecret(inbox[0].code, active.codeHash), true);
  });
  now = new Date('2030-01-03T08:00:00Z');
  await check('daily-SMS-reservations-concurrently-enforce-small-global-budget', async () => {
    const accounts = await Promise.all(Array.from({ length: 8 }, () => account()));
    const { instance: s, inbox } = service({ smsDailyLimit: 3 });
    const results = await Promise.allSettled(
      accounts.map((a) => s.sendCode({ phone: a.phone, purpose: 'RESET_PASSWORD' }))
    );
    assert.equal(fulfilled(results), 3);
    assert.equal(inbox.length, 3);
    assert.ok(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => r.reason.code === 'SMS_UNAVAILABLE' && r.reason.status === 503)
    );
    assert.equal(
      await db.verificationCode.count({
        where: { createdAt: { gte: new Date('2030-01-02T16:00:00Z'), lt: new Date('2030-01-03T16:00:00Z') } }
      }),
      3
    );
  });
  await check('SMS-budget-resets-at-Beijing-natural-midnight', async () => {
    const one = await account(),
      two = await account(),
      { instance: s, inbox } = service({ smsDailyLimit: 1 });
    now = new Date('2030-01-10T15:59:59Z');
    await s.sendCode({ phone: one.phone, purpose: 'RESET_PASSWORD' });
    await assert.rejects(
      () => s.sendCode({ phone: two.phone, purpose: 'RESET_PASSWORD' }),
      expect('SMS_UNAVAILABLE')
    );
    now = new Date('2030-01-10T16:00:00Z');
    await s.sendCode({ phone: two.phone, purpose: 'RESET_PASSWORD' });
    assert.equal(inbox.length, 2);
  });
  now = new Date('2030-01-11T08:00:00Z');
  const admin = await account('ADMIN'),
    superAdmin = await account('SUPER_ADMIN'),
    target = await account(),
    adminToken = await session(admin);
  const command = {
    membership: 'FRIEND',
    expectedMembership: 'MEMBER',
    reason: 'synthetic PG permission test'
  };
  await check('ADMIN-self-and-super-target-forbidden-other-target-audited', async () => {
    const s = service().instance;
    for (const id of [admin.id, superAdmin.id])
      await assert.rejects(() => s.changeMembership(id, command, adminToken), expect('FORBIDDEN'));
    assert.equal(await db.accountAudit.count({ where: { actorId: admin.id } }), 0);
    await s.changeMembership(target.id, command, adminToken);
    assert.equal((await db.account.findUnique({ where: { id: target.id } })).membership, 'FRIEND');
    const audit = await db.accountAudit.findMany({ where: { actorId: admin.id } });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].targetAccountId, target.id);
    assert.equal(audit[0].beforeMembership, 'MEMBER');
    assert.equal(audit[0].afterMembership, 'FRIEND');
  });
  await check('real-PG-transaction-rolls-back-membership-on-audit-failure', async () => {
    const other = await account();
    const failing = new Proxy(db, {
      get(object, key) {
        if (key === '$transaction')
          return (action, options) =>
            object.$transaction(
              (tx) =>
                action(
                  new Proxy(tx, {
                    get(inner, property) {
                      if (property === 'accountAudit')
                        return new Proxy(inner.accountAudit, {
                          get(model, operation) {
                            if (operation === 'create')
                              return async () => {
                                throw new Error('SyntheticAuditFailure');
                              };
                            return Reflect.get(model, operation);
                          }
                        });
                      return Reflect.get(inner, property);
                    }
                  })
                ),
              options
            );
        return Reflect.get(object, key);
      }
    });
    await assert.rejects(
      () => service({}, failing).instance.changeMembership(other.id, command, adminToken),
      (error) => error.name === 'Error'
    );
    assert.equal((await db.account.findUnique({ where: { id: other.id } })).membership, 'MEMBER');
    assert.equal(await db.accountAudit.count({ where: { targetAccountId: other.id } }), 0);
  });
  await check('real-lock-wait-revalidates-ADMIN-revocation-before-membership-write', async () => {
    const s = service().instance,
      other = await account(),
      holder = await pool.connect();
    let begun = false;
    try {
      await holder.query('BEGIN');
      begun = true;
      await holder.query('SELECT "id" FROM "Account" WHERE "id"=$1 FOR NO KEY UPDATE', [admin.id]);
      const outcome = s.changeMembership(other.id, command, adminToken).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const { rows } = await pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='artzoo-test' AND wait_event_type='Lock' AND query LIKE '%FOR NO KEY UPDATE%'"
        );
        if (rows[0].n > 0) {
          blocked = true;
          break;
        }
        await pause(20);
      }
      assert.ok(blocked, 'must observe real PostgreSQL row-lock waiting');
      await holder.query('UPDATE "Account" SET "adminRole"=$2 WHERE "id"=$1', [admin.id, 'NONE']);
      await holder.query('COMMIT');
      begun = false;
      const result = await outcome;
      assert.equal(result.error?.code, 'FORBIDDEN');
      assert.equal((await db.account.findUnique({ where: { id: other.id } })).membership, 'MEMBER');
      assert.equal(await db.accountAudit.count({ where: { targetAccountId: other.id } }), 0);
    } finally {
      if (begun) await holder.query('ROLLBACK');
      holder.release();
    }
  });
  now = new Date('2030-01-12T08:00:00Z');
  const short = await account('NONE', await hashSecret('six!66')),
    old6 = await account('NONE', await hashSecret('first!88')),
    old7 = await account('NONE', await hashSecret('second!8'));
  const auth = service();
  let sixLogin, sevenLogin;
  await check('passwords-shorter-than-eight-characters-never-authenticate', async () => {
    for (const password of ['six!66', 'seven!7'])
      await assert.rejects(
        () => auth.instance.login({ phone: short.phone, password }, 'ip:short'),
        expect('INVALID_CREDENTIALS')
      );
    assert.equal(await db.accountSession.count({ where: { accountId: short.id } }), 0);
    sixLogin = await auth.instance.login({ phone: old6.phone, password: 'first!88' }, 'ip:first');
    sevenLogin = await auth.instance.login({ phone: old7.phone, password: 'second!8' }, 'ip:second');
    assert.equal(sixLogin.snapshot.user.id, old6.id);
    assert.equal(sevenLogin.snapshot.user.id, old7.id);
  });
  await check(
    'eight-character-registration-validates-and-consumes-invitation-and-code-atomically',
    async () => {
      const newPhone = phone(),
        invite = opaqueToken();
      const invitation = await db.invitation.create({
        data: {
          tokenHash: tokenDigest(invite),
          tokenCiphertext: 'synthetic',
          membership: 'MEMBER',
          createdById: superAdmin.id,
          createdAt: now,
          expiresAt: new Date(+now + 86400000)
        }
      });
      await auth.instance.sendCode({ phone: newPhone, purpose: 'REGISTER', invitationToken: invite });
      const code = auth.inbox.at(-1).code,
        region = GAME_SERVER_REGIONS[0];
      const body = {
        phone: newPhone,
        displayName: 'PG-new-' + sequence,
        gameRegion: region.region,
        gameServer: region.servers[0],
        invitationToken: invite,
        code
      };
      for (const password of ['six!66', 'seven!7'])
        await assert.rejects(
          () => auth.instance.register({ ...body, password, confirmPassword: password }),
          expect('VALIDATION_ERROR')
        );
      await auth.instance.register({ ...body, password: 'newpass8', confirmPassword: 'newpass8' });
      const created = await db.account.findUnique({ where: { phone: newPhone } });
      assert.equal(await verifySecret('newpass8', created.passwordHash), true);
      assert.equal((await db.invitation.findUnique({ where: { id: invitation.id } })).usedById, created.id);
      assert.ok((await db.verificationCode.findFirst({ where: { phone: newPhone } })).consumedAt);
    }
  );
  await check('eight-character-reset-revokes-all-old-sessions-and-retains-version-protection', async () => {
    const second = await session(old6);
    await auth.instance.sendCode({ phone: old6.phone, purpose: 'RESET_PASSWORD' });
    const code = auth.inbox.at(-1).code;
    for (const password of ['six!66', 'seven!7'])
      await assert.rejects(
        () => auth.instance.resetPassword({ phone: old6.phone, code, password, confirmPassword: password }),
        expect('VALIDATION_ERROR')
      );
    await auth.instance.resetPassword({
      phone: old6.phone,
      code,
      password: 'resetpw8',
      confirmPassword: 'resetpw8'
    });
    assert.equal((await db.account.findUnique({ where: { id: old6.id } })).passwordVersion, 1);
    for (const token of [sixLogin.token, second])
      assert.equal((await auth.instance.session(token)).user, null);
    await assert.rejects(
      () => auth.instance.login({ phone: old6.phone, password: 'first!88' }, 'ip:old-six'),
      expect('INVALID_CREDENTIALS')
    );
    assert.equal(
      (await auth.instance.login({ phone: old6.phone, password: 'resetpw8' }, 'ip:new-six')).snapshot.user.id,
      old6.id
    );
  });
  await check('eight-character-password-change-revokes-all-old-sessions', async () => {
    const second = await session(old7);
    for (const password of ['six!66', 'seven!7'])
      await assert.rejects(
        () =>
          auth.instance.changePassword(
            { currentPassword: 'second!8', password, confirmPassword: password },
            sevenLogin.token
          ),
        expect('VALIDATION_ERROR')
      );
    await auth.instance.changePassword(
      { currentPassword: 'second!8', password: 'changep8', confirmPassword: 'changep8' },
      sevenLogin.token
    );
    assert.equal((await db.account.findUnique({ where: { id: old7.id } })).passwordVersion, 1);
    for (const token of [sevenLogin.token, second])
      assert.equal((await auth.instance.session(token)).user, null);
    assert.equal(
      (await auth.instance.login({ phone: old7.phone, password: 'changep8' }, 'ip:new-seven')).snapshot.user
        .id,
      old7.id
    );
  });
});
