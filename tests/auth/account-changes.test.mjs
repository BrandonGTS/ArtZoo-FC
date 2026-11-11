import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import {
  canChangeAccountMembership,
  validatePassword,
  ACCOUNT_RULES
} from '../../packages/domain/src/account-contract.ts';
import { authConfig, mainlandChinaPhone, unavailableSms } from '../../apps/web/server/auth/ports.ts';
import { hashSecret, tokenDigest, verifySecret } from '../../apps/web/server/auth/crypto.ts';
import { MemoryDb } from './support/memory-db.mjs';

const NOW = new Date('2026-11-04T00:00:00Z');
function fixture() {
  const db = new MemoryDb();
  let time = +NOW;
  const service = new AccountService(db, {
    phone: mainlandChinaPhone,
    sms: unavailableSms,
    now: () => new Date(time)
  });
  const account = (adminRole = 'NONE', passwordHash = 'synthetic-hash') =>
    db.account.create({
      data: {
        phone: '+86138000' + String(db.sequence).padStart(5, '0'),
        passwordHash,
        membership: 'MEMBER',
        adminRole,
        createdAt: NOW
      }
    });
  const session = async (a) => {
    const token = String(db.sequence).padStart(43, 'T');
    await db.accountSession.create({
      data: {
        tokenHash: tokenDigest(token),
        accountId: a.id,
        createdAt: NOW,
        expiresAt: new Date(+NOW + 86400000)
      }
    });
    return token;
  };
  return {
    db,
    service,
    account,
    session,
    advance(ms) {
      time += ms;
    }
  };
}
const command = { membership: 'FRIEND', expectedMembership: 'MEMBER', reason: 'isolated policy test' };
const denied = (e) => e.code === 'FORBIDDEN' && e.status === 403;

test('new-password boundaries are 8–30 ASCII without trim, public config agrees', () => {
  assert.equal(ACCOUNT_RULES.passwordMin, 8);
  assert.equal(authConfig(mainlandChinaPhone, unavailableSms).password.minLength, 8);
  for (const value of ['12345678', ' space  ', 'a'.repeat(30)])
    assert.equal(validatePassword(value, value), value);
  for (const value of ['123456', '1234567', 'a'.repeat(31), '中文abcdef', 'a\nbcdefgh'])
    assert.throws(
      () => validatePassword(value, value),
      (e) => e.code === 'VALIDATION_ERROR'
    );
  assert.throws(
    () => validatePassword(' space  ', 'space  '),
    (e) => Boolean(e.fieldErrors.confirmPassword)
  );
});

for (const role of ['NONE', 'ADMIN', 'SUPER_ADMIN'])
  for (const self of [true, false])
    for (const targetRole of ['NONE', 'ADMIN', 'SUPER_ADMIN']) {
      test(`membership ${role} -> ${targetRole}, self=${self}`, async () => {
        const f = fixture(),
          actor = await f.account(role),
          target = self ? actor : await f.account(targetRole),
          token = await f.session(actor);
        // A row has one actual role: self combinations always use the actor role.
        const allowed =
          role === 'SUPER_ADMIN' || (role === 'ADMIN' && !self && target.adminRole !== 'SUPER_ADMIN');
        assert.equal(canChangeAccountMembership(actor, target), allowed);
        if (allowed) {
          const changed = await f.service.changeMembership(target.id, command, token);
          assert.equal(changed.account.membership, 'FRIEND');
          assert.equal(f.db.rows.accountAudit.length, 1);
          assert.equal(f.db.rows.accountAudit[0].actorId, actor.id);
        } else {
          await assert.rejects(() => f.service.changeMembership(target.id, command, token), denied);
          assert.equal(f.db.rows.account.find((a) => a.id === target.id).membership, 'MEMBER');
          assert.equal(f.db.rows.accountAudit.length, 0);
        }
      });
    }
test('missing session, missing target and stale membership reject without audit', async () => {
  const f = fixture(),
    actor = await f.account('ADMIN'),
    target = await f.account(),
    token = await f.session(actor);
  await assert.rejects(
    () => f.service.changeMembership(target.id, command),
    (e) => e.code === 'UNAUTHENTICATED'
  );
  await assert.rejects(
    () => f.service.changeMembership('missing', command, token),
    (e) => e.code === 'NOT_FOUND'
  );
  await assert.rejects(
    () => f.service.changeMembership(target.id, { ...command, expectedMembership: 'FRIEND' }, token),
    (e) => e.code === 'CONFLICT'
  );
  assert.equal(f.db.rows.accountAudit.length, 0);
});
test('role/session changes while waiting for locks are rechecked before mutation', async () => {
  for (const mode of ['actor-role', 'target-role', 'session-expiry']) {
    const f = fixture(),
      actor = await f.account('ADMIN'),
      target = await f.account(),
      token = await f.session(actor);
    const query = f.db.$queryRaw.bind(f.db);
    let applied = false;
    f.db.$queryRaw = async (strings, ...values) => {
      const result = await query(strings, ...values);
      if (!applied && strings.join('').includes('AccountSession')) {
        applied = true;
        if (mode === 'actor-role') f.db.rows.account.find((a) => a.id === actor.id).adminRole = 'NONE';
        if (mode === 'target-role')
          f.db.rows.account.find((a) => a.id === target.id).adminRole = 'SUPER_ADMIN';
        if (mode === 'session-expiry') f.advance(86400000);
      }
      return result;
    };
    await assert.rejects(
      () => f.service.changeMembership(target.id, command, token),
      (e) => e.code === 'FORBIDDEN' || e.code === 'UNAUTHENTICATED'
    );
    assert.ok(applied);
    assert.equal(f.db.rows.accountAudit.length, 0);
    assert.equal(f.db.rows.account.find((a) => a.id === target.id).membership, 'MEMBER');
  }
});
test('membership and audit roll back together on storage failure', async () => {
  const f = fixture(),
    actor = await f.account('ADMIN'),
    target = await f.account(),
    token = await f.session(actor);
  f.db.fail = 'accountAudit.create';
  await assert.rejects(
    () => f.service.changeMembership(target.id, command, token),
    /injected storage failure/
  );
  assert.equal(f.db.rows.account.find((a) => a.id === target.id).membership, 'MEMBER');
  assert.equal(f.db.rows.accountAudit.length, 0);
});
for (const password of ['six!66', 'seven!7'])
  test(`stored ${password.length}-character password never logs in`, async () => {
    const f = fixture(),
      actor = await f.account('NONE', await hashSecret(password));
    await assert.rejects(
      () => f.service.login({ phone: actor.phone, password }, 'synthetic-source'),
      (e) => e.code === 'INVALID_CREDENTIALS'
    );
    assert.equal(f.db.rows.accountSession.length, 0);
  });
test('all three new-password entry points reject six/seven characters before writing', async () => {
  const f = fixture(),
    old = 'six!66',
    actor = await f.account('NONE', await hashSecret(old)),
    token = await f.session(actor);
  for (const password of ['six!66', 'seven!7']) {
    const body = {
      password,
      confirmPassword: password,
      phone: actor.phone,
      currentPassword: old,
      code: '123456',
      invitationToken: 'I'.repeat(43),
      displayName: 'test',
      gameRegion: '陆行鸟',
      gameServer: '红玉海'
    };
    // register validates game server before the password; use a real catalog pair.
    const { GAME_SERVER_REGIONS } = await import('../../packages/domain/src/account-contract.ts');
    body.gameRegion = GAME_SERVER_REGIONS[0].region;
    body.gameServer = GAME_SERVER_REGIONS[0].servers[0];
    for (const run of [
      () => f.service.register(body),
      () => f.service.resetPassword(body),
      () => f.service.changePassword(body, token)
    ])
      await assert.rejects(run, (e) => e.code === 'VALIDATION_ERROR' && Boolean(e.fieldErrors.password));
  }
  assert.equal(f.db.rows.account[0].passwordVersion, 0);
  assert.equal(f.db.rows.accountSession[0].revokedAt, null);
  assert.equal(f.db.rows.verificationCode.length, 0);
});
test('new 8-character change retains version increment and revokes all old sessions', async () => {
  const f = fixture(),
    old = 'six!66',
    actor = await f.account('NONE', await hashSecret(old)),
    first = await f.session(actor);
  await f.session(actor);
  const result = await f.service.changePassword(
    { currentPassword: old, password: 'newpass8', confirmPassword: 'newpass8' },
    first
  );
  assert.deepEqual(result, { changed: true, requiresLogin: true });
  assert.equal(f.db.rows.account[0].passwordVersion, 1);
  assert.equal(await verifySecret('newpass8', f.db.rows.account[0].passwordHash), true);
  assert.ok(f.db.rows.accountSession.every((s) => s.revokedAt));
  await assert.rejects(
    () => f.service.login({ phone: actor.phone, password: old }, 'old'),
    (e) => e.code === 'INVALID_CREDENTIALS'
  );
  assert.equal(
    (await f.service.login({ phone: actor.phone, password: 'newpass8' }, 'new')).snapshot.user.id,
    actor.id
  );
});
