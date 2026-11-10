import { location, otherLocation, otherRegionLocation } from './support/game-location.mjs';
import { loadInvitationCipher } from '../../apps/web/server/auth/invitation-cipher.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import {
  validatePassword,
  AccountError,
  GAME_SERVER_REGIONS,
  validateGameServer
} from '../../packages/domain/src/account-contract.ts';
import { hashSecret, tokenDigest } from '../../apps/web/server/auth/crypto.ts';
import { unconfirmedPhone, unavailableSms, mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import { validateOrigin, readBody, failure, success } from '../../apps/web/server/auth/http.ts';
import { MemoryDb } from './support/memory-db.mjs';

const DAY = 86400000,
  START = Date.parse('2026-10-13T00:00:00.000Z');
const PASSWORD = 'test-only!7',
  PHONE = '+8613800000001';
const hashed = await hashSecret(PASSWORD);
function fixture(extra = {}) {
  const db = new MemoryDb(),
    inbox = [];
  let now = START;
  const sms = {
    mode: 'mock',
    available: true,
    async send(message) {
      inbox.push(message);
    }
  };
  const service = new AccountService(db, {
    invitationCipher: loadInvitationCipher({ ARTZOO_INVITATION_KEY: Buffer.alloc(32, 7).toString('base64') }),
    environment: 'test',
    phone: mainlandChinaPhone,
    sms,
    smsResponseDelay: async () => {},
    now: () => new Date(now),
    ...extra
  });
  const account = async (role = 'NONE', membership = 'MEMBER', phone = PHONE) =>
    db.account.create({
      data: { phone, passwordHash: hashed, membership, adminRole: role, createdAt: new Date(now) }
    });
  // Fixed, synthetic, in-memory-only cookie values. No persistent login credentials.
  const session = async (a) => {
    const token = 'T'.repeat(40) + String(db.sequence).padStart(3, '0');
    await db.accountSession.create({
      data: {
        tokenHash: tokenDigest(token),
        accountId: a.id,
        createdAt: new Date(now),
        expiresAt: new Date(now + 30 * DAY)
      }
    });
    return token;
  };
  const invite = async (membership = 'MEMBER') => {
    const a = await account('ADMIN', 'MEMBER', '+861390000' + String(db.sequence).padStart(4, '0'));
    const token = 'I'.repeat(40) + String(db.sequence).padStart(3, '0');
    const row = await db.invitation.create({
      data: {
        tokenHash: tokenDigest(token),
        membership,
        createdById: a.id,
        createdAt: new Date(now),
        expiresAt: new Date(now + DAY)
      }
    });
    return { token, row };
  };
  return {
    db,
    service,
    inbox,
    sms,
    account,
    session,
    invite,
    advance(ms) {
      now += ms;
    },
    time: () => now
  };
}
async function rejects(action, code, status) {
  await assert.rejects(action, (e) => {
    assert.equal(e.code, code);
    if (status) assert.equal(e.status, status);
    return true;
  });
}
async function registration(f, phone = PHONE, invitation) {
  const inv = invitation || (await f.invite());
  await f.service.sendCode({ phone, purpose: 'REGISTER', invitationToken: inv.token });
  return {
    inv,
    body: {
      phone,
      displayName: '测试玩家',
      ...location,
      invitationToken: inv.token,
      code: f.inbox.at(-1).code,
      password: PASSWORD,
      confirmPassword: PASSWORD
    }
  };
}
const wrong = (code) => (code === '000000' ? '000001' : '000000');
const fulfilled = (results) => results.filter((r) => r.status === 'fulfilled').length;

test('new password: 8 and 30 accepted; 6/7 and 31 rejected; no trimming; confirmation checked', () => {
  for (const p of ['12345678', 'a'.repeat(30), ' space  ', 'symbol!8'])
    assert.equal(validatePassword(p, p), p);
  for (const p of ['123456', '1234567', 'a'.repeat(31), '中文abcdef'])
    assert.throws(
      () => validatePassword(p, p),
      (e) => e.code === 'VALIDATION_ERROR'
    );
  assert.throws(
    () => validatePassword(' space  ', 'space  '),
    (e) => Boolean(e.fieldErrors.confirmPassword)
  );
});
test('invitation: expiration exact boundary and revoked state reject registration', async () => {
  for (const mode of ['expired', 'revoked']) {
    const f = fixture(),
      { inv, body } = await registration(f);
    if (mode === 'expired') f.advance(DAY);
    else f.db.rows.invitation[0].revokedAt = new Date(f.time());
    await rejects(
      () => f.service.register(body),
      mode === 'expired' ? 'INVITATION_EXPIRED' : 'INVITATION_REVOKED',
      410
    );
    assert.equal(f.db.rows.account.filter((a) => a.phone === PHONE).length, 0);
    assert.equal(f.db.rows.verificationCode[0].consumedAt, null);
  }
});
test('invitation: concurrent registration consumes only once and creates ordinary identity', async () => {
  const f = fixture(),
    { body } = await registration(f);
  const results = await Promise.allSettled([
    f.service.register(body),
    f.service.register({ ...body, adminRole: 'SUPER_ADMIN' })
  ]);
  assert.equal(fulfilled(results), 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'INVITATION_USED');
  assert.equal(f.db.rows.account.filter((a) => a.phone === PHONE).length, 1);
  assert.equal(f.db.rows.account.find((a) => a.phone === PHONE).adminRole, 'NONE');
  assert.ok(f.db.rows.invitation[0].usedAt);
  assert.ok(f.db.rows.verificationCode[0].consumedAt);
  assert.equal(f.db.rows.accountSession.length, 0);
  assert.ok(f.db.locks.some((k) => k.startsWith('invitation:')));
});
test('duplicate normalized phone: conflict leaves invitation and code unconsumed', async () => {
  const f = fixture();
  await f.account();
  const { body } = await registration(f, ' ' + PHONE + ' ');
  await rejects(() => f.service.register(body), 'PHONE_ALREADY_REGISTERED', 409);
  assert.equal(f.db.rows.invitation[0].usedAt, null);
  assert.equal(f.db.rows.verificationCode[0].consumedAt, null);
  assert.equal(f.db.rows.account.filter((a) => a.phone === PHONE).length, 1);
});
test('registration storage failure rolls back account, invitation and code consumption', async () => {
  const f = fixture(),
    { body } = await registration(f);
  f.db.fail = 'verificationCode.update';
  await assert.rejects(() => f.service.register(body), /injected storage failure/);
  assert.equal(f.db.rows.account.filter((a) => a.phone === PHONE).length, 0);
  assert.equal(f.db.rows.invitation[0].usedAt, null);
  assert.equal(f.db.rows.verificationCode[0].consumedAt, null);
});
test('code: six digits and 300-second expiry metadata, malformed inputs rejected', async () => {
  const f = fixture(),
    { body } = await registration(f);
  assert.match(f.inbox[0].code, /^\d{6}$/);
  assert.equal(+f.db.rows.verificationCode[0].expiresAt - f.time(), 300000);
  for (const code of ['12345', '1234567', 'abcdef', 123456])
    await rejects(() => f.service.register({ ...body, code }), 'VALIDATION_ERROR', 400);
  f.advance(300000);
  await rejects(() => f.service.register(body), 'CODE_EXPIRED', 400);
});
test('code: valid at 299999 ms and successful consumption cannot reset twice', async () => {
  const f = fixture();
  await f.account();
  await f.service.sendCode({ phone: PHONE, purpose: 'RESET_PASSWORD' });
  const body = { phone: PHONE, code: f.inbox[0].code, password: 'newpass!8', confirmPassword: 'newpass!8' };
  f.advance(299999);
  assert.deepEqual(await f.service.resetPassword(body), { reset: true, requiresLogin: true });
  await rejects(() => f.service.resetPassword(body), 'CODE_INVALID', 400);
});
test('code: resend at 59999 rejected, at 60000 allowed; new code replaces old record', async () => {
  const f = fixture(),
    { inv } = await registration(f);
  const first = f.db.rows.verificationCode[0];
  f.advance(59999);
  await rejects(
    () => f.service.sendCode({ phone: PHONE, purpose: 'REGISTER', invitationToken: inv.token }),
    'RATE_LIMITED',
    429
  );
  f.advance(1);
  await f.service.sendCode({ phone: PHONE, purpose: 'REGISTER', invitationToken: inv.token });
  assert.ok(f.db.rows.verificationCode[0].invalidatedAt);
  assert.equal(f.db.rows.verificationCode.length, 2);
  // Record replacement is deterministic even if a random generator happens to repeat six digits.
  assert.notEqual(first.id, f.db.rows.verificationCode[1].id);
});
test('code: five wrong attempts persist despite business rejection and then reject correct code', async () => {
  const f = fixture(),
    { body } = await registration(f);
  for (let i = 1; i <= 5; i++) {
    await rejects(
      () => f.service.register({ ...body, code: wrong(body.code) }),
      i === 5 ? 'CODE_EXHAUSTED' : 'CODE_INVALID'
    );
    assert.equal(f.db.rows.verificationCode[0].attempts, i);
  }
  await rejects(() => f.service.register(body), 'CODE_EXHAUSTED');
  assert.equal(f.db.rows.invitation[0].usedAt, null);
});
test('code binding: phone, purpose and invitation cannot be swapped', async () => {
  const f = fixture(),
    { body } = await registration(f),
    other = await f.invite();
  await rejects(() => f.service.register({ ...body, phone: '+8613800000002' }), 'CODE_INVALID');
  await rejects(() => f.service.register({ ...body, invitationToken: other.token }), 'CODE_INVALID');
  await rejects(() => f.service.resetPassword(body), 'CODE_INVALID');
});
test('SMS cross-purpose hourly/day limits, rolling boundaries and normalized keys', async () => {
  const f = fixture(),
    inv = await f.invite();
  await f.account();
  const send = (i) =>
    f.service.sendCode({
      phone: i % 2 ? PHONE : ' ' + PHONE + ' ',
      purpose: i % 2 ? 'RESET_PASSWORD' : 'REGISTER',
      invitationToken: inv.token
    });
  for (let i = 0; i < 5; i++) {
    if (i) f.advance(60000);
    await send(i);
  }
  f.advance(60000);
  await rejects(() => send(5), 'RATE_LIMITED', 429);
  f.advance(3300000); // exactly one hour after first send; first event falls out.
  await send(5);
  for (let i = 6; i < 10; i++) {
    f.advance(60000);
    await send(i);
  }
  f.advance(3600000);
  await rejects(() => send(10), 'RATE_LIMITED', 429);
  f.advance(DAY - (f.time() - START)); // first day event expires exactly.
  await f.service.sendCode({ phone: PHONE, purpose: 'RESET_PASSWORD' });
  assert.equal(f.inbox.length, 11);
});
test('SMS concurrent sends reserve one slot; failed provider delivery retains cooldown', async () => {
  const f = fixture();
  await f.account();
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => f.service.sendCode({ phone: PHONE, purpose: 'RESET_PASSWORD' }))
  );
  assert.equal(fulfilled(results), 1);
  assert.equal(f.inbox.length, 1);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'RATE_LIMITED'));
  f.advance(60000);
  f.sms.send = async () => {
    throw Error('provider internal secret');
  };
  await rejects(
    () => f.service.sendCode({ phone: PHONE, purpose: 'RESET_PASSWORD' }),
    'SMS_UNAVAILABLE',
    503
  );
  assert.equal(f.db.rows.verificationCode.length, 2);
  assert.ok(f.db.rows.verificationCode[1].invalidatedAt);
  await rejects(() => f.service.sendCode({ phone: PHONE, purpose: 'RESET_PASSWORD' }), 'RATE_LIMITED', 429);
});
test('SMS and phone unconfigured fail honestly; mock forbidden outside tests', async () => {
  const f = fixture({ phone: unconfirmedPhone });
  await rejects(
    () => f.service.sendCode({ phone: PHONE, purpose: 'RESET_PASSWORD' }),
    'PHONE_REGION_UNCONFIRMED',
    503
  );
  const g = fixture({ sms: unavailableSms });
  await rejects(
    () => g.service.sendCode({ phone: PHONE, purpose: 'RESET_PASSWORD' }),
    'SMS_UNAVAILABLE',
    503
  );
  assert.equal(g.db.rows.verificationCode.length, 0);
  assert.throws(() => fixture({ environment: 'production' }), /Mock SMS/);
});
test('all membership/admin combinations: absolute login plus 30 days, no sliding renewal', async () => {
  for (const membership of ['MEMBER', 'FRIEND'])
    for (const role of ['NONE', 'ADMIN', 'SUPER_ADMIN']) {
      const f = fixture();
      await f.account(role, membership);
      const login = await f.service.login({ phone: PHONE, password: PASSWORD }, 'test-source');
      assert.equal(+login.expiresAt, START + 30 * DAY);
      assert.equal(login.snapshot.capabilities.manageInvitations, role !== 'NONE');
      assert.equal(f.db.rows.accountSession[0].tokenHash, tokenDigest(login.token));
      f.advance(30 * DAY - 1);
      assert.ok((await f.service.session(login.token)).user);
      assert.equal(
        (await f.service.session(login.token)).expiresAt,
        new Date(START + 30 * DAY).toISOString()
      );
      f.advance(1);
      assert.equal((await f.service.session(login.token)).user, null);
    }
});
test('logout affects only current device and is idempotent', async () => {
  const f = fixture(),
    a = await f.account(),
    one = await f.session(a),
    two = await f.session(a);
  await f.service.logout(one);
  assert.equal((await f.service.session(one)).user, null);
  assert.ok((await f.service.session(two)).user);
  assert.deepEqual(await f.service.logout(one), { loggedOut: true });
  assert.deepEqual(await f.service.logout(), { loggedOut: true });
});
test('password reset revokes every device, consumes code and changes password', async () => {
  const f = fixture(),
    a = await f.account(),
    one = await f.session(a),
    two = await f.session(a);
  await f.service.sendCode({ phone: PHONE, purpose: 'RESET_PASSWORD' });
  await f.service.resetPassword({
    phone: PHONE,
    code: f.inbox[0].code,
    password: 'newpass!8',
    confirmPassword: 'newpass!8'
  });
  for (const token of [one, two]) assert.equal((await f.service.session(token)).user, null);
  await rejects(() => f.service.login({ phone: PHONE, password: PASSWORD }, 'test'), 'INVALID_CREDENTIALS');
  assert.ok((await f.service.login({ phone: PHONE, password: 'newpass!8' }, 'test')).snapshot.user);
});
test('password change requires current password and revokes all devices atomically', async () => {
  const f = fixture(),
    a = await f.account(),
    one = await f.session(a),
    two = await f.session(a);
  await rejects(
    () =>
      f.service.changePassword(
        { currentPassword: 'wrong!', password: 'newpass!8', confirmPassword: 'newpass!8' },
        one
      ),
    'INVALID_CREDENTIALS'
  );
  assert.ok((await f.service.session(two)).user);
  await f.service.changePassword(
    { currentPassword: PASSWORD, password: 'newpass!8', confirmPassword: 'newpass!8' },
    one
  );
  for (const token of [one, two]) assert.equal((await f.service.session(token)).user, null);
});
test('server permissions: anonymous 401, ordinary member/friend 403, admin and super admin allowed', async () => {
  const body = { membership: 'FRIEND', expiresAt: new Date(START + DAY).toISOString() };
  const f = fixture();
  await rejects(() => f.service.createInvitation(body), 'UNAUTHENTICATED', 401);
  for (const membership of ['MEMBER', 'FRIEND'])
    for (const role of ['NONE', 'ADMIN', 'SUPER_ADMIN']) {
      const g = fixture(),
        a = await g.account(role, membership),
        token = await g.session(a);
      if (role === 'NONE') {
        await rejects(
          () => g.service.createInvitation({ ...body, capabilities: { manageInvitations: true } }, token),
          'FORBIDDEN',
          403
        );
        for (const kind of ['invitations', 'accounts', 'audit'])
          await rejects(() => g.service.list(kind, new URL('http://localhost'), token), 'FORBIDDEN', 403);
        await rejects(
          () =>
            g.service.changeMembership(
              a.id,
              { membership: 'FRIEND', expectedMembership: membership, reason: 'test' },
              token
            ),
          'FORBIDDEN',
          403
        );
      } else assert.equal((await g.service.createInvitation(body, token)).invitation.membership, 'FRIEND');
    }
});
test('current identity is read per request; membership updates do not grant admin; audit records conflict', async () => {
  const f = fixture(),
    a = await f.account('ADMIN'),
    token = await f.session(a);
  const target = await f.account('NONE', 'MEMBER', '+8613800000002'),
    targetToken = await f.session(target);
  await f.service.changeMembership(
    target.id,
    {
      membership: 'FRIEND',
      expectedMembership: 'MEMBER',
      reason: '  test reason  ',
      adminRole: 'SUPER_ADMIN'
    },
    token
  );
  const s = await f.service.session(targetToken);
  assert.equal(s.user.membership, 'FRIEND');
  assert.equal(s.user.adminRole, 'NONE');
  const audit = f.db.rows.accountAudit[0];
  assert.equal(audit.actorId, a.id);
  assert.equal(audit.targetAccountId, target.id);
  assert.equal(audit.beforeMembership, 'MEMBER');
  assert.equal(audit.afterMembership, 'FRIEND');
  assert.equal(audit.reason, 'test reason');
  await rejects(
    () =>
      f.service.changeMembership(
        target.id,
        { membership: 'MEMBER', expectedMembership: 'MEMBER', reason: 'stale' },
        token
      ),
    'CONFLICT',
    409
  );
  assert.equal(f.db.rows.accountAudit.length, 1);
  await f.db.account.update({ where: { id: a.id }, data: { adminRole: 'NONE' } });
  assert.equal((await f.service.session(token)).capabilities.manageMembership, false);
  await rejects(() => f.service.list('accounts', new URL('http://localhost'), token), 'FORBIDDEN', 403);
});
test('invitation revoke is audited and idempotent; used/expired cannot claim revoked', async () => {
  const f = fixture(),
    a = await f.account('ADMIN'),
    token = await f.session(a);
  const made = await f.service.createInvitation(
    { membership: 'MEMBER', expiresAt: new Date(START + DAY).toISOString() },
    token
  );
  await f.service.revokeInvitation(made.invitation.id, { reason: '  test  ' }, token);
  await f.service.revokeInvitation(made.invitation.id, { reason: 'again' }, token);
  assert.equal(f.db.rows.accountAudit.length, 2);
  assert.equal(f.db.rows.accountAudit[1].reason, 'test');
  await rejects(() => f.service.invitation(made.invitePath.split('/').at(-1)), 'INVITATION_REVOKED', 410);
  for (const mode of ['used', 'expired']) {
    const g = fixture(),
      admin = await g.account('ADMIN'),
      t = await g.session(admin),
      inv = await g.invite();
    if (mode === 'used') g.db.rows.invitation[0].usedAt = new Date(START);
    else g.advance(DAY);
    await rejects(
      () => g.service.revokeInvitation(inv.row.id, { reason: 'test' }, t),
      mode === 'used' ? 'INVITATION_USED' : 'INVITATION_EXPIRED',
      410
    );
  }
});
test('login enumeration resistance and configurable phone/source rate limits', async () => {
  const f = fixture({ loginPhoneLimit: 2 });
  await f.account();
  let first;
  try {
    await f.service.login({ phone: PHONE, password: 'wrong!' }, 'a');
  } catch (e) {
    first = e;
  }
  let missing;
  try {
    await f.service.login({ phone: '+8613800000002', password: 'wrong!' }, 'a');
  } catch (e) {
    missing = e;
  }
  assert.deepEqual(
    [first.code, first.message, first.status],
    [missing.code, missing.message, missing.status]
  );
  await rejects(() => f.service.login({ phone: PHONE, password: 'wrong!' }, 'b'), 'INVALID_CREDENTIALS');
  await rejects(() => f.service.login({ phone: PHONE, password: PASSWORD }, 'c'), 'RATE_LIMITED', 429);
  const g = fixture({ loginSourceLimit: 1 });
  await rejects(() => g.service.login({ phone: PHONE, password: 'wrong!' }, 'shared'), 'INVALID_CREDENTIALS');
  await rejects(
    () => g.service.login({ phone: '+8613800000002', password: 'wrong!' }, 'shared'),
    'RATE_LIMITED',
    429
  );
});
test('source rate concurrency commits only limit reservations', async () => {
  const f = fixture({ writeSourceLimit: 2 });
  const results = await Promise.allSettled(
    Array.from({ length: 7 }, () => f.service.limitWriteSource('test-source'))
  );
  assert.equal(fulfilled(results), 2);
  assert.equal(f.db.rows.accountRateEvent.length, 4);
  f.advance(900000);
  await f.service.limitWriteSource('test-source');
});
test('public projections never expose phone, password hash, invitation hash or session token', async () => {
  const f = fixture(),
    a = await f.account('ADMIN'),
    token = await f.session(a),
    inv = await f.invite();
  const data = [
    await f.service.session(token),
    await f.service.invitation(inv.token),
    await f.service.list('accounts', new URL('http://localhost'), token),
    await f.service.list('invitations', new URL('http://localhost'), token)
  ];
  const serialized = JSON.stringify(data);
  for (const secret of [PHONE, hashed, token, inv.token, tokenDigest(inv.token)])
    assert.equal(serialized.includes(secret), false);
});
test('CSRF: same origin/json/custom header required even on localhost', () => {
  const headers = {
    origin: 'http://localhost:3100',
    'content-type': 'application/json',
    'x-artzoo-request': '1'
  };
  const req = (h) => new Request('http://localhost:3100/api/auth/login', { method: 'POST', headers: h });
  assert.doesNotThrow(() => validateOrigin(req(headers)));
  for (const h of [
    { ...headers, origin: 'https://evil.invalid' },
    { ...headers, origin: 'null' },
    { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    { ...headers, 'x-artzoo-request': '0' },
    { ...headers, 'sec-fetch-site': 'cross-site' }
  ]) {
    assert.throws(
      () => validateOrigin(req(h)),
      (e) => e.code === 'FORBIDDEN' && e.status === 403
    );
  }
  for (const key of Object.keys(headers)) {
    const h = { ...headers };
    delete h[key];
    assert.throws(
      () => validateOrigin(req(h)),
      (e) => e.code === 'FORBIDDEN'
    );
  }
});
test('HTTP body shape/size and error serialization protect secrets, no-store and Retry-After', async () => {
  for (const body of ['[]', 'null', '42', 'not-json', 'x'.repeat(8193)])
    await rejects(
      () => readBody(new Request('http://localhost', { method: 'POST', body })),
      'VALIDATION_ERROR',
      400
    );
  assert.deepEqual(
    await readBody(new Request('http://localhost', { method: 'POST', body: '{"phone":"test"}' })),
    { phone: 'test' }
  );
  const err = await failure(Error('password=private code=private token=private')).json();
  assert.deepEqual(err, {
    ok: false,
    error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后再试' }
  });
  const rate = failure(new AccountError('RATE_LIMITED', '稍后再试', 429, undefined, 60));
  assert.equal(rate.headers.get('retry-after'), '60');
  assert.equal(rate.headers.get('cache-control'), 'no-store');
  assert.equal(success({}).headers.get('cache-control'), 'no-store');
  const conflict = await failure({ code: 'P2002', meta: { secret: 'do not expose' } }).json();
  assert.equal(conflict.error.code, 'CONFLICT');
  assert.equal(JSON.stringify(conflict).includes('do not expose'), false);
});

test('two invitations racing for one normalized phone create one account and leave loser invitation intact', async () => {
  const f = fixture(),
    first = await registration(f),
    secondInv = await f.invite();
  f.advance(60000);
  const second = await registration(f, PHONE, secondInv);
  const results = await Promise.allSettled([f.service.register(first.body), f.service.register(second.body)]);
  assert.equal(fulfilled(results), 1);
  assert.equal(f.db.rows.account.filter((a) => a.phone === PHONE).length, 1);
  assert.equal(f.db.rows.invitation.filter((i) => i.usedAt).length, 1);
});
test('concurrent wrong guesses persist exactly five attempts, then block valid code', async () => {
  const f = fixture(),
    { body } = await registration(f);
  const results = await Promise.allSettled(
    Array.from({ length: 7 }, () => f.service.register({ ...body, code: wrong(body.code) }))
  );
  assert.equal(fulfilled(results), 0);
  assert.equal(f.db.rows.verificationCode[0].attempts, 5);
  await rejects(() => f.service.register(body), 'CODE_EXHAUSTED');
});
test('hourly and daily concurrent boundary sends never reserve beyond remaining quota', async () => {
  for (const count of [4, 9]) {
    const f = fixture();
    // Seed rate history only; matching schema fields, no alternate business implementation.
    for (let i = 0; i < count; i++)
      await f.db.verificationCode.create({
        data: {
          phone: PHONE,
          purpose: 'RESET_PASSWORD',
          codeHash: 'not-a-secret',
          createdAt: new Date(START - (count === 4 ? count - i : 120 - i) * 60000),
          expiresAt: new Date(START - 1),
          invalidatedAt: new Date(START - 1)
        }
      });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => f.service.sendCode({ phone: PHONE, purpose: 'RESET_PASSWORD' }))
    );
    assert.equal(fulfilled(results), 1);
    assert.equal(f.db.rows.verificationCode.length, count + 1);
  }
});
test('password reset storage failure rolls back password, every session and code consumption', async () => {
  const f = fixture(),
    a = await f.account(),
    token = await f.session(a);
  await f.service.sendCode({ phone: PHONE, purpose: 'RESET_PASSWORD' });
  f.db.fail = 'verificationCode.update';
  await assert.rejects(
    () =>
      f.service.resetPassword({
        phone: PHONE,
        code: f.inbox[0].code,
        password: 'newpass!8',
        confirmPassword: 'newpass!8'
      }),
    /injected storage failure/
  );
  assert.equal(f.db.rows.account[0].passwordVersion, 0);
  assert.equal(f.db.rows.account[0].passwordHash, hashed);
  assert.ok((await f.service.session(token)).user);
  assert.equal(f.db.rows.verificationCode[0].consumedAt, null);
});
test('production CSRF accepts only configured exact HTTPS origin', () => {
  const oldMode = process.env.NODE_ENV,
    oldOrigin = process.env.ARTZOO_PUBLIC_ORIGIN;
  try {
    process.env.NODE_ENV = 'production';
    process.env.ARTZOO_PUBLIC_ORIGIN = 'https://example.invalid';
    const request = (origin) =>
      new Request('http://internal.invalid/api/auth/login', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', 'x-artzoo-request': '1' }
      });
    assert.doesNotThrow(() => validateOrigin(request('https://example.invalid')));
    assert.throws(
      () => validateOrigin(request('http://internal.invalid')),
      (e) => e.code === 'FORBIDDEN'
    );
    delete process.env.ARTZOO_PUBLIC_ORIGIN;
    assert.throws(
      () => validateOrigin(request('https://example.invalid')),
      (e) => e.code === 'SERVICE_UNAVAILABLE'
    );
  } finally {
    if (oldMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldMode;
    if (oldOrigin === undefined) delete process.env.ARTZOO_PUBLIC_ORIGIN;
    else process.env.ARTZOO_PUBLIC_ORIGIN = oldOrigin;
  }
});

test('replacement code: prior record cannot be redeemed and latest record succeeds', async () => {
  const f = fixture(),
    { inv } = await registration(f);
  f.advance(60000);
  await f.service.sendCode({ phone: PHONE, purpose: 'REGISTER', invitationToken: inv.token });
  const latest = f.inbox.at(-1).code,
    old = wrong(latest);
  // Pin old record to a distinct synthetic value to avoid probabilistic random-code collision.
  await f.db.verificationCode.update({
    where: { id: f.db.rows.verificationCode[0].id },
    data: { codeHash: await hashSecret(old) }
  });
  const body = {
    phone: PHONE,
    displayName: '测试玩家',
    ...location,
    invitationToken: inv.token,
    password: PASSWORD,
    confirmPassword: PASSWORD
  };
  await rejects(() => f.service.register({ ...body, code: old }), 'CODE_INVALID');
  assert.deepEqual(await f.service.register({ ...body, code: latest }), {
    registered: true,
    requiresLogin: true
  });
  assert.equal(f.db.rows.verificationCode[0].consumedAt, null);
  assert.ok(f.db.rows.verificationCode[1].consumedAt);
});
test('one invitation with different phones racing still has one successful consumer', async () => {
  const f = fixture(),
    inv = await f.invite();
  const one = await registration(f, PHONE, inv),
    two = await registration(f, '+8613800000002', inv);
  const results = await Promise.allSettled([f.service.register(one.body), f.service.register(two.body)]);
  assert.equal(fulfilled(results), 1);
  assert.equal(f.db.rows.account.filter((a) => [PHONE, '+8613800000002'].includes(a.phone)).length, 1);
  assert.equal(f.db.rows.verificationCode.filter((c) => c.consumedAt).length, 1);
});

test('mainland equivalent spellings share uniqueness and resend quota', async () => {
  const f = fixture();
  await f.account();
  const inv = await f.invite(),
    r = await registration(f, '13800000001', inv);
  await rejects(
    () => f.service.sendCode({ phone: '0086 138-0000-0001', purpose: 'RESET_PASSWORD' }),
    'RATE_LIMITED',
    429
  );
  await rejects(
    () => f.service.register({ ...r.body, phone: '+86 13800000001' }),
    'PHONE_ALREADY_REGISTERED',
    409
  );
  assert.equal(f.db.rows.verificationCode[0].phone, PHONE);
});
test('service rejects non-mainland phone before sending or creating account', async () => {
  const f = fixture();
  for (const phone of ['+15550000001', '+85291234567', '+886912345678']) {
    await rejects(() => f.service.sendCode({ phone, purpose: 'RESET_PASSWORD' }), 'VALIDATION_ERROR', 400);
    await rejects(
      () => f.service.login({ phone, password: PASSWORD }, 'test-source'),
      'VALIDATION_ERROR',
      400
    );
  }
  assert.equal(f.inbox.length, 0);
  assert.equal(f.db.rows.account.length, 0);
});

test('game location: every advertised region/server pair is accepted', () => {
  for (const group of GAME_SERVER_REGIONS)
    for (const gameServer of group.servers)
      assert.deepEqual(validateGameServer(group.region, gameServer), {
        gameRegion: group.region,
        gameServer
      });
});
for (const [label, patch] of [
  ['missing region', { gameRegion: undefined }],
  ['missing server', { gameServer: undefined }],
  ['null pair', { gameRegion: null, gameServer: null }],
  ['empty pair', { gameRegion: '', gameServer: '' }],
  ['non-string region', { gameRegion: 42 }],
  ['non-string server', { gameServer: [] }],
  ['unknown region', { gameRegion: 'forged-region' }],
  ['unknown server', { gameServer: 'forged-server' }],
  ['cross-region pair', { gameRegion: otherRegionLocation.gameRegion }]
])
  test('game location rejects ' + label + ' without consuming invitation/code', async () => {
    const f = fixture(),
      { body } = await registration(f),
      before = structuredClone(f.db.rows);
    await assert.rejects(
      () => f.service.register({ ...body, ...patch }),
      (e) => e.code === 'VALIDATION_ERROR' && e.status === 400 && !!e.fieldErrors.gameLocation
    );
    assert.deepEqual(f.db.rows, before);
  });
test('registration stores selected location and exposes it in login/session summary', async () => {
  const f = fixture(),
    { body } = await registration(f);
  await f.service.register(body);
  const account = f.db.rows.account.find((a) => a.phone === PHONE);
  assert.equal(account.gameRegion, location.gameRegion);
  assert.equal(account.gameServer, location.gameServer);
  const auth = await f.service.login({ phone: PHONE, password: PASSWORD }, 'location-test');
  for (const user of [auth.snapshot.user, (await f.service.session(auth.token)).user]) {
    assert.equal(user.gameRegion, location.gameRegion);
    assert.equal(user.gameServer, location.gameServer);
  }
  assert.ok(f.db.locks.some((key) => key.startsWith('game-name:')));
});
test('same-server trimmed duplicate is field-specific 409 and preserves second invitation/code', async () => {
  const f = fixture(),
    first = await registration(f);
  await f.service.register({ ...first.body, displayName: '  Exact Name  ' });
  const second = await registration(f, '+8613800000002');
  await assert.rejects(
    () => f.service.register({ ...second.body, displayName: 'Exact Name' }),
    (e) => e.code === 'GAME_NICKNAME_TAKEN' && e.status === 409 && !!e.fieldErrors.displayName
  );
  assert.equal(second.inv.row.usedAt, null);
  assert.equal(f.db.rows.invitation.find((i) => i.id === second.inv.row.id).usedAt, null);
  assert.equal(f.db.rows.verificationCode.find((c) => c.phone === second.body.phone).consumedAt, null);
  await f.service.register({ ...second.body, displayName: 'Different Name' });
  assert.ok(f.db.rows.invitation.find((i) => i.id === second.inv.row.id).usedAt);
});
test('same exact nickname across two servers is allowed', async () => {
  const f = fixture(),
    first = await registration(f),
    second = await registration(f, '+8613800000002');
  await f.service.register(first.body);
  await f.service.register({ ...second.body, ...otherLocation });
  assert.equal(f.db.rows.account.filter((a) => a.displayName === first.body.displayName).length, 2);
});
for (const [label, left, right] of [
  ['case', 'Player', 'player'],
  ['internal whitespace', 'A B', 'A  B'],
  ['Unicode normalization', 'é', 'e\u0301'],
  ['Unicode codepoints', 'Ａ', 'A']
])
  test('same-server identity preserves ' + label, async () => {
    const f = fixture(),
      first = await registration(f),
      second = await registration(f, '+8613800000002');
    await f.service.register({ ...first.body, displayName: left });
    await f.service.register({ ...second.body, displayName: right });
    assert.deepEqual(
      f.db.rows.account.filter((a) => [PHONE, second.body.phone].includes(a.phone)).map((a) => a.displayName),
      [left, right]
    );
  });
test('legacy null location and duplicate names still login without backfill', async () => {
  const f = fixture(),
    one = await f.account(),
    two = await f.account('NONE', 'MEMBER', '+8613800000002');
  for (const a of [one, two])
    await f.db.account.update({ where: { id: a.id }, data: { displayName: 'Legacy' } });
  for (const a of [one, two]) {
    const auth = await f.service.login({ phone: a.phone, password: PASSWORD }, 'legacy-' + a.id);
    assert.equal(auth.snapshot.user.gameRegion, null);
    assert.equal(auth.snapshot.user.gameServer, null);
    const stored = f.db.rows.account.find((row) => row.id === a.id);
    assert.equal(stored.gameRegion, null);
    assert.equal(stored.gameServer, null);
  }
});

test('composite P2002 fallback maps to nickname conflict and rolls back artifacts', async () => {
  const f = fixture(),
    { body } = await registration(f),
    before = structuredClone(f.db.rows);
  const create = f.db.account.create;
  f.db.account.create = async () => {
    throw Object.assign(Error('synthetic unique violation'), {
      code: 'P2002',
      meta: { target: ['gameServer', 'displayName'] }
    });
  };
  await assert.rejects(
    () => f.service.register(body),
    (e) => e.code === 'GAME_NICKNAME_TAKEN' && e.status === 409 && !!e.fieldErrors.displayName
  );
  assert.deepEqual(f.db.rows, before);
  f.db.account.create = create;
  await f.service.register(body);
});
test('unrelated database unique violation is not mislabeled as nickname conflict', async () => {
  const f = fixture(),
    { body } = await registration(f),
    before = structuredClone(f.db.rows);
  f.db.account.create = async () => {
    throw Object.assign(Error('synthetic phone violation'), { code: 'P2002', meta: { target: ['phone'] } });
  };
  await assert.rejects(
    () => f.service.register(body),
    (e) => e.code === 'P2002'
  );
  assert.deepEqual(f.db.rows, before);
});

for (const [label, cause] of [
  [
    'named index',
    {
      kind: 'UniqueConstraintViolation',
      table: 'Account',
      constraint: { index: 'Account_gameServer_displayName_key' }
    }
  ],
  [
    'exact fields',
    {
      kind: 'UniqueConstraintViolation',
      table: 'Account',
      constraint: { fields: ['displayName', 'gameServer'] }
    }
  ],
  [
    'named index without table',
    { kind: 'UniqueConstraintViolation', constraint: { index: 'Account_gameServer_displayName_key' } }
  ]
])
  test('Prisma 7 adapter ' + label + ' maps nickname conflict and rolls back', async () => {
    const f = fixture(),
      { body } = await registration(f),
      before = structuredClone(f.db.rows);
    f.db.account.create = async () => {
      throw Object.assign(Error('synthetic adapter violation'), {
        code: 'P2002',
        meta: { modelName: 'Account', driverAdapterError: { cause } }
      });
    };
    await assert.rejects(
      () => f.service.register(body),
      (e) => e.code === 'GAME_NICKNAME_TAKEN' && e.status === 409 && !!e.fieldErrors.displayName
    );
    assert.deepEqual(f.db.rows, before);
  });
for (const [label, cause] of [
  [
    'unrelated index',
    { kind: 'UniqueConstraintViolation', table: 'Account', constraint: { index: 'Account_phone_key' } }
  ],
  [
    'unrelated fields',
    { kind: 'UniqueConstraintViolation', table: 'Account', constraint: { fields: ['phone'] } }
  ],
  [
    'unrelated table',
    {
      kind: 'UniqueConstraintViolation',
      table: 'Invitation',
      constraint: { index: 'Account_gameServer_displayName_key' }
    }
  ],
  [
    'unrelated table exact fields',
    {
      kind: 'UniqueConstraintViolation',
      table: 'Invitation',
      constraint: { fields: ['gameServer', 'displayName'] }
    }
  ],
  [
    'wrong error kind',
    {
      kind: 'ForeignKeyConstraintViolation',
      table: 'Account',
      constraint: { index: 'Account_gameServer_displayName_key' }
    }
  ],
  [
    'extra constraint field',
    {
      kind: 'UniqueConstraintViolation',
      table: 'Account',
      constraint: { fields: ['gameServer', 'displayName', 'phone'] }
    }
  ],
  [
    'unknown constraint shape',
    { kind: 'UniqueConstraintViolation', table: 'Account', constraint: 'Account_gameServer_displayName_key' }
  ],
  ['missing constraint', { kind: 'UniqueConstraintViolation', table: 'Account' }],
  ['null cause', null],
  ['unknown scalar cause', 'unexpected']
])
  test('Prisma 7 adapter ' + label + ' preserves unrelated error and rolls back', async () => {
    const f = fixture(),
      { body } = await registration(f),
      before = structuredClone(f.db.rows);
    const original = Object.assign(Error('synthetic unrelated violation'), {
      code: 'P2002',
      meta: { modelName: 'Account', driverAdapterError: { cause } }
    });
    f.db.account.create = async () => {
      throw original;
    };
    await assert.rejects(
      () => f.service.register(body),
      (e) => e === original
    );
    assert.deepEqual(f.db.rows, before);
  });
