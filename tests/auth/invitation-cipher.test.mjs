import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInvitationCipher } from '../../apps/web/server/auth/invitation-cipher.ts';
import { tokenDigest } from '../../apps/web/server/auth/crypto.ts';
const raw = 'T'.repeat(43),
  id = 'synthetic-invitation',
  digest = tokenDigest(raw);
const env = { ARTZOO_INVITATION_KEY: Buffer.alloc(32, 7).toString('base64') };
test('AES-GCM independent 32-byte configuration is strict and fails closed', () => {
  for (const value of [
    undefined,
    '',
    'bad',
    Buffer.alloc(31).toString('base64'),
    Buffer.alloc(33).toString('base64'),
    env.ARTZOO_INVITATION_KEY + ' '
  ])
    assert.equal(loadInvitationCipher({ ARTZOO_INVITATION_KEY: value }), undefined);
  assert.equal(
    loadInvitationCipher({
      SMS_ACCESS_KEY_SECRET: env.ARTZOO_INVITATION_KEY,
      PGPASSWORD: env.ARTZOO_INVITATION_KEY
    }),
    undefined
  );
});
test('AES-GCM uses a fresh nonce, round trips with independent instance and binds invitation id/hash', () => {
  const cipher = loadInvitationCipher(env),
    first = cipher.seal(raw, id, digest),
    second = cipher.seal(raw, id, digest);
  assert.notEqual(first, second);
  assert.equal(loadInvitationCipher(env).open(first, id, digest), raw);
  for (const [envelope, target, hash] of [
    [first, id + 'x', digest],
    [first, id, tokenDigest('X'.repeat(43))],
    ['v2' + first.slice(2), id, digest],
    // 改动最后两个字符；原文碰巧以 xx 结尾时改成 yy，避免"改了等于没改"（约 1/4096 的偶发失败）。
    [first.slice(0, -2) + (first.endsWith('xx') ? 'yy' : 'xx'), id, digest],
    ['x'.repeat(100000), id, digest]
  ]) {
    assert.throws(
      () => cipher.open(envelope, target, hash),
      (e) => e.code === 'INVITATION_LINK_UNAVAILABLE' && !e.message.includes(envelope)
    );
  }
});
