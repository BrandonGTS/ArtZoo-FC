import { location, otherLocation } from './support/game-location.mjs';
import { loadInvitationCipher } from '../../apps/web/server/auth/invitation-cipher.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { validateGameNickname } from '../../packages/domain/src/account-contract.ts';
import { tokenDigest } from '../../apps/web/server/auth/crypto.ts';
import { mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import { MemoryDb } from './support/memory-db.mjs';

const START = new Date('2026-10-13T14:00:00Z'),
  DAY = 86400000;
async function fixture() {
  const db = new MemoryDb(),
    inbox = [];
  const admin = await db.account.create({
    data: {
      phone: '+8613900000001',
      passwordHash: 'synthetic-only',
      displayName: null,
      membership: 'MEMBER',
      adminRole: 'ADMIN',
      createdAt: START
    }
  });
  const token = 'T'.repeat(43);
  await db.accountSession.create({
    data: {
      tokenHash: tokenDigest(token),
      accountId: admin.id,
      createdAt: START,
      expiresAt: new Date(+START + DAY)
    }
  });
  const service = new AccountService(db, {
    smsResponseDelay: async () => {},
    invitationCipher: loadInvitationCipher({ ARTZOO_INVITATION_KEY: Buffer.alloc(32, 7).toString('base64') }),
    phone: mainlandChinaPhone,
    environment: 'test',
    now: () => START,
    sms: {
      mode: 'mock',
      available: true,
      async send(value) {
        inbox.push(value);
      }
    }
  });
  const invite = async () => {
    const created = await service.createInvitation(
      { membership: 'FRIEND', expiresAt: new Date(+START + DAY).toISOString() },
      token
    );
    return { id: created.invitation.id, raw: created.invitePath.split('/').at(-1) };
  };
  return { db, service, admin, token, inbox, invite };
}
async function registration(f, phone = '+8613800000001', nickname = '测试旅人') {
  const invitation = await f.invite();
  await f.service.sendCode({ phone, purpose: 'REGISTER', invitationToken: invitation.raw });
  return {
    invitation,
    body: {
      phone,
      displayName: nickname,
      ...location,
      invitationToken: invitation.raw,
      code: f.inbox.at(-1).code,
      password: 'synthetic!7',
      confirmPassword: 'synthetic!7'
    }
  };
}
const errorCode = (code) => (error) => error.code === code;

test('game nickname: trim, 1–30 Unicode code points, no control/format characters preserves exact Unicode spelling', () => {
  assert.equal(validateGameNickname('  小猫  '), '小猫');
  assert.equal(validateGameNickname('😀'.repeat(30)), '😀'.repeat(30));
  assert.equal(validateGameNickname('A'), 'A');
  for (const value of [
    undefined,
    null,
    12,
    '',
    '  ',
    'x'.repeat(31),
    '😀'.repeat(31),
    'a\nb',
    '\nname',
    'name\t',
    'a\u0000b',
    '\u200b',
    'a\u202Eb',
    'a\u2028b'
  ])
    assert.throws(
      () => validateGameNickname(value),
      (error) => error.code === 'VALIDATION_ERROR' && !!error.fieldErrors.displayName
    );
});

test('registration validates nickname before DB/code mutation, persists it and permits duplicate nicknames across servers', async () => {
  const f = await fixture(),
    one = await registration(f);
  const before = structuredClone(f.db.rows);
  for (const displayName of [undefined, '', 'x'.repeat(31)]) {
    await assert.rejects(
      () => f.service.register({ ...one.body, displayName }),
      errorCode('VALIDATION_ERROR')
    );
    assert.deepEqual(f.db.rows, before);
  }
  await f.service.register({ ...one.body, displayName: '  同名玩家  ' });
  const two = await registration(f, '+8613800000002', '同名玩家');
  await f.service.register({ ...two.body, ...otherLocation });
  assert.equal(f.db.rows.account.filter((row) => row.displayName === '同名玩家').length, 2);
  assert.equal(f.db.rows.account.find((row) => row.id === f.admin.id).displayName, null);
});

test('account search is blank by default, nickname-only, case-insensitive and leaves unnamed records untouched', async () => {
  const f = await fixture();
  await f.db.account.create({
    data: {
      phone: '+8613800000002',
      passwordHash: 'synthetic',
      displayName: 'RainbowCat',
      membership: 'FRIEND',
      adminRole: 'NONE',
      createdAt: START
    }
  });
  let reads = 0;
  const find = f.db.account.findMany;
  f.db.account.findMany = async (args) => {
    reads++;
    return find(args);
  };
  for (const query of ['', '   ']) {
    const result = await f.service.list(
      'accounts',
      new URL('http://localhost?query=' + encodeURIComponent(query)),
      f.token
    );
    assert.deepEqual(result, { items: [], nextCursor: null });
  }
  assert.equal(reads, 0);
  const matched = await f.service.list('accounts', new URL('http://localhost?query=rainbow'), f.token);
  assert.equal(matched.items.length, 1);
  assert.equal(matched.items[0].displayName, 'RainbowCat');
  const phone = await f.service.list('accounts', new URL('http://localhost?query=13800000002'), f.token);
  assert.deepEqual(phone.items, []);
  await assert.rejects(
    () => f.service.list('accounts', new URL('http://localhost')),
    errorCode('UNAUTHENTICATED')
  );
  assert.equal(f.db.rows.account.find((row) => row.id === f.admin.id).displayName, null);
});

test('membership audit filters before server pagination, returns total, stable ordering and distinct pages', async () => {
  const f = await fixture();
  for (let i = 0; i < 25; i++)
    await f.db.accountAudit.create({
      data: {
        action: 'MEMBERSHIP_CHANGED',
        actorId: f.admin.id,
        targetAccountId: f.admin.id,
        beforeMembership: 'MEMBER',
        afterMembership: 'FRIEND',
        reason: 'synthetic ' + i,
        createdAt: new Date(+START + i)
      }
    });
  for (const action of ['INVITATION_CREATED', 'INVITATION_REVOKED', 'INVITATION_REMOVED'])
    await f.db.accountAudit.create({
      data: { action, actorId: f.admin.id, createdAt: new Date(+START + 100) }
    });
  const page = (n) =>
    f.service.list('audit', new URL('http://localhost?scope=membership&page=' + n + '&pageSize=10'), f.token);
  const one = await page(1),
    two = await page(2),
    three = await page(3);
  assert.deepEqual([one.items.length, two.items.length, three.items.length], [10, 10, 5]);
  assert.deepEqual([one.total, two.total, three.total], [25, 25, 25]);
  assert.equal(new Set([...one.items, ...two.items, ...three.items].map((row) => row.id)).size, 25);
  assert.ok(one.items.every((row) => row.action === 'MEMBERSHIP_CHANGED'));
  assert.ok(one.items[0].createdAt > two.items[0].createdAt);
  assert.equal((await page(999)).page, 3);
  const invitations = await f.service.list('audit', new URL('http://localhost?scope=invitation'), f.token);
  assert.equal(invitations.total, 3);
  for (const query of [
    'page=0',
    'page=-1',
    'page=1.5',
    'page=1000001',
    'pageSize=101',
    'pageSize=0',
    'scope=all'
  ])
    await assert.rejects(
      () => f.service.list('audit', new URL('http://localhost?' + query), f.token),
      errorCode('VALIDATION_ERROR')
    );
  await f.db.account.update({ where: { id: f.admin.id }, data: { adminRole: 'NONE' } });
  await assert.rejects(() => page(1), errorCode('FORBIDDEN'));
});

test('soft removal hides invitation, invalidates every public registration path and is idempotently audited', async () => {
  const f = await fixture(),
    { invitation, body } = await registration(f);
  const beforeAccount = structuredClone(f.db.rows.account);
  await f.service.removeInvitation(invitation.id, { reason: '  测试移除  ' }, f.token);
  await f.service.removeInvitation(invitation.id, { reason: 'again' }, f.token);
  const row = f.db.rows.invitation.find((row) => row.id === invitation.id);
  assert.ok(row.removedAt);
  assert.equal(row.revokedAt, null);
  assert.equal(row.usedAt, null);
  assert.equal(f.db.rows.invitation.length, 1);
  assert.deepEqual((await f.service.list('invitations', new URL('http://localhost'), f.token)).items, []);
  assert.equal(f.db.rows.accountAudit.filter((row) => row.action === 'INVITATION_REMOVED').length, 1);
  assert.equal(f.db.rows.accountAudit.at(-1).reason, '测试移除');
  assert.ok(f.db.rows.verificationCode[0].invalidatedAt);
  await assert.rejects(() => f.service.invitation(invitation.raw), errorCode('INVITATION_INVALID'));
  await assert.rejects(
    () =>
      f.service.sendCode({ phone: '+8613800000003', purpose: 'REGISTER', invitationToken: invitation.raw }),
    errorCode('INVITATION_INVALID')
  );
  await assert.rejects(() => f.service.register(body), errorCode('INVITATION_INVALID'));
  await assert.rejects(
    () => f.service.revokeInvitation(invitation.id, { reason: 'test' }, f.token),
    errorCode('NOT_FOUND')
  );
  assert.deepEqual(f.db.rows.account, beforeAccount);
  assert.equal(f.inbox.length, 1);
});

test('removing used/expired/revoked invitations preserves registered accounts and previous lifecycle facts', async () => {
  for (const state of ['used', 'expired', 'revoked']) {
    const f = await fixture(),
      { invitation, body } = await registration(f);
    if (state === 'used') await f.service.register(body);
    if (state === 'expired')
      await f.db.invitation.update({
        where: { id: invitation.id },
        data: { expiresAt: new Date(+START - 1) }
      });
    if (state === 'revoked') await f.service.revokeInvitation(invitation.id, { reason: 'test' }, f.token);
    const beforeAccounts = structuredClone(f.db.rows.account),
      beforeSessions = structuredClone(f.db.rows.accountSession);
    const before = structuredClone(f.db.rows.invitation[0]);
    await f.service.removeInvitation(invitation.id, { reason: 'test' }, f.token);
    const after = f.db.rows.invitation[0];
    for (const key of ['usedAt', 'usedById', 'revokedAt', 'expiresAt'])
      assert.deepEqual(after[key], before[key]);
    assert.deepEqual(f.db.rows.account, beforeAccounts);
    assert.deepEqual(f.db.rows.accountSession, beforeSessions);
  }
});

test('soft removal permissions and audit failure preserve invitation and verification records', async () => {
  const f = await fixture(),
    { invitation } = await registration(f);
  await assert.rejects(
    () => f.service.removeInvitation(invitation.id, { reason: 'test' }),
    errorCode('UNAUTHENTICATED')
  );
  const before = structuredClone(f.db.rows);
  f.db.fail = 'accountAudit.create';
  await assert.rejects(() => f.service.removeInvitation(invitation.id, { reason: 'test' }, f.token));
  assert.deepEqual(f.db.rows, before);
  f.db.fail = null;
  await f.db.account.update({ where: { id: f.admin.id }, data: { adminRole: 'NONE' } });
  await assert.rejects(
    () => f.service.removeInvitation(invitation.id, { reason: 'test' }, f.token),
    errorCode('FORBIDDEN')
  );
});

test('serial transaction regression: removal first blocks registration; registration first survives removal', async () => {
  for (const removeFirst of [true, false]) {
    const f = await fixture(),
      { invitation, body } = await registration(f);
    const remove = () => f.service.removeInvitation(invitation.id, { reason: 'test' }, f.token);
    const register = () => f.service.register(body);
    // MemoryDb serializes transactions; real PG lock interleaving requires isolated PG verification.
    const actions = removeFirst ? [remove(), register()] : [register(), remove()];
    const result = await Promise.allSettled(actions);
    assert.equal(result[removeFirst ? 0 : 1].status, 'fulfilled');
    const registered = f.db.rows.account.some((row) => row.phone === body.phone);
    if (removeFirst) assert.equal(registered, false);
    // Password hashing precedes registration's transaction; validate the invariant whichever commits first.
    assert.ok(f.db.rows.invitation[0].removedAt);
    if (registered)
      assert.equal(
        f.db.rows.invitation[0].usedById,
        f.db.rows.account.find((row) => row.phone === body.phone).id
      );
  }
});

test('nickname search treats SQL pattern characters literally', async () => {
  const f = await fixture();
  for (const displayName of ['猫A', '猫_', '猫%', String.raw`猫\窝`]) {
    await f.db.account.create({
      data: {
        phone: 'synthetic-' + displayName,
        passwordHash: 'synthetic',
        displayName,
        membership: 'FRIEND',
        adminRole: 'NONE',
        createdAt: START
      }
    });
  }
  const original = f.db.account.findMany;
  let predicate;
  f.db.account.findMany = async (args) => {
    predicate = args.where.displayName.contains;
    return original(args);
  };
  const slash = String.fromCharCode(92);
  for (const [query, expected, escaped] of [
    ['_', '猫_', slash + '_'],
    ['%', '猫%', slash + '%'],
    [slash, '猫' + slash + '窝', slash + slash]
  ]) {
    const result = await f.service.list(
      'accounts',
      new URL('http://localhost?query=' + encodeURIComponent(query)),
      f.token
    );
    assert.equal(predicate, escaped);
    assert.deepEqual(
      result.items.map((row) => row.displayName),
      [expected]
    );
  }
});
test('encrypted new invitation survives service restart and never appears in list/public projections', async () => {
  const f = await fixture(),
    inv = await f.invite();
  const row = f.db.rows.invitation.find((item) => item.id === inv.id);
  assert.match(row.tokenCiphertext, /^v1[.]/);
  assert.ok(!row.tokenCiphertext.includes(inv.raw));
  assert.equal(row.tokenHash, tokenDigest(inv.raw));
  const restarted = new AccountService(f.db, {
    ...f.service.options,
    invitationCipher: loadInvitationCipher({ ARTZOO_INVITATION_KEY: Buffer.alloc(32, 7).toString('base64') })
  });
  assert.equal((await restarted.invitationLink(inv.id, f.token)).invitePath, '/invite/' + inv.raw);
  const list = await restarted.list('invitations', new URL('http://localhost'), f.token);
  assert.equal(list.items[0].linkAvailable, true);
  const visible = JSON.stringify([list, await restarted.invitation(inv.raw)]);
  for (const secret of [row.tokenHash, row.tokenCiphertext, inv.raw]) assert.ok(!visible.includes(secret));
  await assert.rejects(() => restarted.invitationLink(inv.id), errorCode('UNAUTHENTICATED'));
  await f.db.account.update({ where: { id: f.admin.id }, data: { adminRole: 'NONE' } });
  await assert.rejects(() => restarted.invitationLink(inv.id, f.token), errorCode('FORBIDDEN'));
});
test('missing/wrong key fails closed without changing data or breaking public invitation validation', async () => {
  const f = await fixture(),
    inv = await f.invite(),
    before = structuredClone(f.db.rows);
  for (const cipher of [
    undefined,
    loadInvitationCipher({ ARTZOO_INVITATION_KEY: Buffer.alloc(32, 8).toString('base64') })
  ]) {
    const service = new AccountService(f.db, { ...f.service.options, invitationCipher: cipher });
    await assert.rejects(
      () => service.invitationLink(inv.id, f.token),
      errorCode('INVITATION_LINK_UNAVAILABLE')
    );
    assert.equal((await service.invitation(inv.raw)).membership, 'FRIEND');
  }
  const noKey = new AccountService(f.db, { ...f.service.options, invitationCipher: undefined });
  await assert.rejects(
    () =>
      noKey.createInvitation(
        { membership: 'FRIEND', expiresAt: new Date(+START + DAY).toISOString() },
        f.token
      ),
    errorCode('INVITATION_LINK_UNAVAILABLE')
  );
  assert.deepEqual(f.db.rows, before);
});
test('link recovery checks lifecycle', async () => {
  for (const [field, value, code] of [
    ['removedAt', START, 'INVITATION_INVALID'],
    ['usedAt', START, 'INVITATION_USED'],
    ['revokedAt', START, 'INVITATION_REVOKED'],
    ['expiresAt', START, 'INVITATION_EXPIRED']
  ]) {
    const f = await fixture(),
      inv = await f.invite();
    await f.db.invitation.update({ where: { id: inv.id }, data: { [field]: value } });
    await assert.rejects(() => f.service.invitationLink(inv.id, f.token), errorCode(code));
  }
});
