// Synthetic serial memory transactions verify rules, not PostgreSQL concurrency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { loadInvitationCipher } from '../../apps/web/server/auth/invitation-cipher.ts';
import { tokenDigest } from '../../apps/web/server/auth/crypto.ts';
import { mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import { MemoryDb } from './support/memory-db.mjs';
import { location } from './support/game-location.mjs';
const START = Date.parse('2026-10-26T00:00:00Z'),
  DAY = 86400000;
const codeError = (code) => (e) => e.code === code;
async function fixture() {
  const db = new MemoryDb(),
    inbox = [];
  let now = START;
  const admin = await db.account.create({
    data: {
      phone: '+8613900000001',
      passwordHash: 'synthetic-only',
      membership: 'MEMBER',
      adminRole: 'ADMIN',
      createdAt: new Date(now)
    }
  });
  const token = 'A'.repeat(43);
  await db.accountSession.create({
    data: {
      tokenHash: tokenDigest(token),
      accountId: admin.id,
      createdAt: new Date(now),
      expiresAt: new Date(now + DAY)
    }
  });
  const service = new AccountService(db, {
    smsResponseDelay: async () => {},
    phone: mainlandChinaPhone,
    environment: 'test',
    invitationCipher: loadInvitationCipher({ ARTZOO_INVITATION_KEY: Buffer.alloc(32, 7).toString('base64') }),
    now: () => new Date(now),
    sms: {
      mode: 'mock',
      available: true,
      async send(m) {
        inbox.push(m);
      }
    }
  });
  const create = async (mode) =>
    service.createInvitation(
      {
        membership: 'FRIEND',
        expiresAt: new Date(START + DAY).toISOString(),
        ...(mode === undefined ? {} : { usageMode: mode })
      },
      token
    );
  const prepare = async (inv, n) => {
    const phone = '+86138' + String(n).padStart(8, '0'),
      invitationToken = inv.invitePath.split('/').at(-1);
    await service.sendCode({ phone, purpose: 'REGISTER', invitationToken });
    return {
      phone,
      invitationToken,
      displayName: '合成旅人' + n,
      ...location,
      code: inbox.findLast((message) => message.phone === phone).code,
      password: 'Synthetic!7',
      confirmPassword: 'Synthetic!7'
    };
  };
  return {
    db,
    service,
    admin,
    token,
    create,
    prepare,
    setNow: (v) => {
      now = v;
    }
  };
}
test('omitted mode remains single-use; unsupported modes fail closed', async () => {
  const f = await fixture(),
    created = await f.create();
  assert.equal(created.invitation.usageMode, 'SINGLE');
  assert.equal(f.db.rows.invitation[0].usageMode, 'SINGLE');
  for (const value of [null, 'single', 'MULTI', true, 1, {}, []])
    await assert.rejects(
      () => f.create(value),
      (e) => e.code === 'VALIDATION_ERROR' && !!e.fieldErrors.usageMode
    );
  assert.equal(f.db.rows.invitation.length, 1);
});
test('multiple invitation registers independent members, preserves link and never consumes invitation', async () => {
  const f = await fixture(),
    inv = await f.create('MULTIPLE');
  const bodies = await Promise.all([f.prepare(inv, 1), f.prepare(inv, 2), f.prepare(inv, 3)]);
  assert.equal(
    (
      await Promise.allSettled(bodies.map((b) => f.service.register({ ...b, adminRole: 'SUPER_ADMIN' })))
    ).filter((r) => r.status === 'fulfilled').length,
    3
  );
  const row = f.db.rows.invitation[0];
  assert.equal(row.usedAt, null);
  assert.equal(row.usedById, null);
  assert.equal(f.db.rows.verificationCode.filter((c) => c.consumedAt).length, 3);
  assert.equal(
    f.db.rows.account.filter((a) => a.adminRole === 'NONE' && a.membership === 'FRIEND').length,
    3
  );
  assert.equal((await f.service.invitationLink(inv.invitation.id, f.token)).invitePath, inv.invitePath);
  const list = await f.service.list('invitations', new URL('http://localhost'), f.token);
  assert.equal(list.items[0].status, 'ACTIVE');
  assert.equal(list.items[0].usageMode, 'MULTIPLE');
  assert.equal(list.items[0].linkAvailable, true);
});
test('single invitation still commits only one success across two phones', async () => {
  const f = await fixture(),
    inv = await f.create('SINGLE'),
    a = await f.prepare(inv, 11),
    b = await f.prepare(inv, 12);
  const result = await Promise.allSettled([f.service.register(a), f.service.register(b)]);
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(result.find((r) => r.status === 'rejected').reason.code, 'INVITATION_USED');
  assert.equal(f.db.rows.account.length, 2);
  assert.equal(f.db.rows.verificationCode.filter((c) => c.consumedAt).length, 1);
});
test('multiple invitation expiration boundary rejects all paths without consuming code or account', async () => {
  const f = await fixture(),
    inv = await f.create('MULTIPLE'),
    body = await f.prepare(inv, 21);
  f.setNow(START + DAY);
  await assert.rejects(() => f.service.register(body), codeError('INVITATION_EXPIRED'));
  await assert.rejects(() => f.service.invitation(body.invitationToken), codeError('INVITATION_EXPIRED'));
  await assert.rejects(
    () => f.service.sendCode({ ...body, purpose: 'REGISTER' }),
    codeError('INVITATION_EXPIRED')
  );
  assert.equal(f.db.rows.account.length, 1);
  assert.equal(f.db.rows.verificationCode[0].consumedAt, null);
});
test('expiry during awaited verification is rechecked for multiple mode before creating account', async () => {
  const f = await fixture(),
    inv = await f.create('MULTIPLE'),
    body = await f.prepare(inv, 22);
  const check = f.service.checkCode.bind(f.service);
  f.service.checkCode = async (...args) => {
    const result = await check(...args);
    f.setNow(START + DAY);
    return result;
  };
  await assert.rejects(() => f.service.register(body), codeError('CODE_EXPIRED'));
  assert.equal(f.db.rows.account.length, 1);
  assert.equal(f.db.rows.invitation[0].usedAt, null);
});
test('invitation expiry during uniqueness awaits is rechecked even while the code remains valid', async () => {
  const f = await fixture(),
    inv = await f.create('MULTIPLE');
  f.setNow(START + DAY - 1000);
  const body = await f.prepare(inv, 23);
  const find = f.db.account.findFirst;
  f.db.account.findFirst = async (args) => {
    const row = await find(args);
    f.setNow(START + DAY);
    return row;
  };
  await assert.rejects(() => f.service.register(body), codeError('INVITATION_EXPIRED'));
  assert.equal(f.db.rows.account.length, 1);
  assert.equal(f.db.rows.verificationCode[0].consumedAt, null);
});
test('revoke and remove after a multiple registration stop subsequent use while preserving accounts', async () => {
  for (const action of ['revokeInvitation', 'removeInvitation']) {
    const f = await fixture(),
      inv = await f.create('MULTIPLE'),
      first = await f.prepare(inv, 31),
      second = await f.prepare(inv, 32);
    await f.service.register(first);
    await f.service[action](inv.invitation.id, { reason: 'synthetic test' }, f.token);
    await assert.rejects(
      () => f.service.register(second),
      codeError(action === 'revokeInvitation' ? 'INVITATION_REVOKED' : 'INVITATION_INVALID')
    );
    await assert.rejects(
      () => f.service.invitation(second.invitationToken),
      codeError(action === 'revokeInvitation' ? 'INVITATION_REVOKED' : 'INVITATION_INVALID')
    );
    assert.equal(f.db.rows.account.length, 2);
    assert.equal(f.db.rows.invitation[0].usedAt, null);
  }
});
test('multiple mode preserves duplicate-phone and nickname rules without consuming more codes', async () => {
  const f = await fixture(),
    inv = await f.create('MULTIPLE'),
    first = await f.prepare(inv, 41);
  await f.service.register(first);
  const second = await f.prepare(inv, 42);
  await assert.rejects(
    () => f.service.register({ ...second, displayName: first.displayName }),
    codeError('GAME_NICKNAME_TAKEN')
  );
  assert.equal(f.db.rows.verificationCode.filter((c) => c.consumedAt).length, 1);
  f.setNow(START + 61000);
  const duplicate = await f.prepare(inv, 41);
  await assert.rejects(() => f.service.register(duplicate), codeError('PHONE_ALREADY_REGISTERED'));
  assert.equal(f.db.rows.account.length, 2);
  assert.equal(f.db.rows.invitation[0].usedAt, null);
});
test('multiple registration rolls back account on code write failure and can retry safely', async () => {
  const f = await fixture(),
    inv = await f.create('MULTIPLE'),
    body = await f.prepare(inv, 51);
  f.db.fail = 'verificationCode.update';
  await assert.rejects(() => f.service.register(body), /injected storage failure/);
  assert.equal(f.db.rows.account.length, 1);
  assert.equal(f.db.rows.verificationCode[0].consumedAt, null);
  assert.equal(f.db.rows.invitation[0].usedAt, null);
  f.db.fail = null;
  assert.equal((await f.service.register(body)).registered, true);
});
test('multiple creation retains administrator gate and encrypted-link configuration requirement', async () => {
  const f = await fixture(),
    body = { membership: 'FRIEND', usageMode: 'MULTIPLE', expiresAt: new Date(START + DAY).toISOString() };
  await assert.rejects(() => f.service.createInvitation(body), codeError('UNAUTHENTICATED'));
  f.db.rows.account[0].adminRole = 'NONE';
  await assert.rejects(() => f.service.createInvitation(body, f.token), codeError('FORBIDDEN'));
  f.db.rows.account[0].adminRole = 'ADMIN';
  const noCipher = new AccountService(f.db, { ...f.service.options, invitationCipher: undefined });
  await assert.rejects(
    () => noCipher.createInvitation(body, f.token),
    codeError('INVITATION_LINK_UNAVAILABLE')
  );
  assert.equal(f.db.rows.invitation.length, 0);
});
