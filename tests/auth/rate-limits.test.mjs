import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequestSource } from '../../apps/web/server/auth/request-source.ts';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import { MemoryDb } from './support/memory-db.mjs';
import { tokenDigest, DUMMY_PASSWORD_HASH } from '../../apps/web/server/auth/crypto.ts';
const req = (value) => ({ headers: new Headers(value == null ? {} : { 'x-forwarded-for': value }) });
test('proxy trust opt-in; untrusted headers cannot split buckets', () => {
  assert.equal(resolveRequestSource(req('192.0.2.1'), ''), 'untrusted-source');
  assert.equal(resolveRequestSource(req('192.0.2.1'), 'other'), 'untrusted-source');
  assert.equal(resolveRequestSource(req('192.0.2.1'), 'caddy'), 'ip:192.0.2.1');
  assert.equal(resolveRequestSource(req('203.0.113.7, 192.0.2.1'), 'caddy'), 'ip:192.0.2.1');
});
test('invalid source fail-closed, IPv6 aliases and /64 group', () => {
  for (const v of [null, '', 'x', '192.0.2.1:90', '010.0.0.1', '[::1]', 'fe80::1%eth0', '192.0.2.1,invalid'])
    assert.equal(resolveRequestSource(req(v), 'caddy'), 'untrusted-source');
  assert.equal(resolveRequestSource(req('2001:db8:abcd:0001::2'), 'caddy'), 'ip:2001:db8:abcd:1::/64');
  assert.equal(
    resolveRequestSource(req('2001:0db8:abcd:1:aaaa:bbbb:cccc:dddd'), 'caddy'),
    'ip:2001:db8:abcd:1::/64'
  );
  assert.notEqual(
    resolveRequestSource(req('2001:db8:abcd:2::1'), 'caddy'),
    resolveRequestSource(req('2001:db8:abcd:1::1'), 'caddy')
  );
  assert.equal(resolveRequestSource(req('::ffff:192.0.2.1'), 'caddy'), 'ip:0:0:0:0::/64');
});
function fixture(options = {}) {
  const db = new MemoryDb(),
    sent = [],
    delays = [];
  let now = new Date('2026-11-04T15:59:59Z');
  const service = new AccountService(db, {
    environment: 'test',
    phone: mainlandChinaPhone,
    sms: {
      mode: 'mock',
      available: true,
      async send(v) {
        sent.push(v);
      }
    },
    now: () => new Date(now),
    smsResponseDelay: async (ms) => delays.push(ms),
    ...options
  });
  return { db, service, sent, delays, setTime: (date) => (now = new Date(date)) };
}
const limited = (p) =>
  assert.rejects(p, (e) => e.code === 'RATE_LIMITED' && e.status === 429 && e.retryAfterSeconds > 0);
test('IP isolation, atomic multi-bucket failure and global fuse', async () => {
  const f = fixture({ writeSourceLimit: 1, writeGlobalLimit: 3 });
  await f.service.limitWriteSource('ip:192.0.2.1');
  await limited(f.service.limitWriteSource('ip:192.0.2.1'));
  assert.equal(f.db.rows.accountRateEvent.length, 2, 'rejected consume reserves no partial bucket');
  await f.service.limitWriteSource('ip:192.0.2.2');
  await f.service.limitWriteSource('ip:192.0.2.3');
  await limited(f.service.limitWriteSource('ip:192.0.2.4'));
});
test('same account quota follows source changes; other account unaffected; check does not consume', async () => {
  const f = fixture({ writeAccountLimit: 1 });
  f.service.sessionIn = async (_db, token) => (token ? { accountId: token } : null);
  await f.service.checkWriteSource('ip:192.0.2.1', 'A');
  assert.equal(f.db.rows.accountRateEvent.length, 0);
  await f.service.limitWriteSource('ip:192.0.2.1', 'A');
  await limited(f.service.limitWriteSource('ip:192.0.2.2', 'A'));
  await f.service.limitWriteSource('ip:192.0.2.2', 'B');
  assert.equal(f.db.rows.accountRateEvent.length, 6);
});
test('login phone+IP bucket rejects one source without consuming another source quota', async () => {
  const f = fixture({ loginPhoneSourceLimit: 1 });
  await assert.rejects(
    f.service.login({ phone: '13800000001', password: 'wrong' }, 'ip:192.0.2.1'),
    (e) => e.code === 'INVALID_CREDENTIALS'
  );
  await limited(f.service.login({ phone: '13800000001', password: 'wrong' }, 'ip:192.0.2.1'));
  await assert.rejects(
    f.service.login({ phone: '13800000001', password: 'wrong' }, 'ip:192.0.2.2'),
    (e) => e.code === 'INVALID_CREDENTIALS'
  );
  assert.equal(f.db.rows.accountRateEvent.length, 6);
});
test('quota conflict retry replays only DB work and samples time after locks', async () => {
  const f = fixture();
  const original = f.db.$transaction.bind(f.db);
  let calls = 0;
  f.db.$transaction = async (action) => {
    if (++calls === 1) throw { code: 'P2034' };
    return original(action);
  };
  await f.service.rate('synthetic', 1, 60);
  assert.equal(calls, 2);
  assert.equal(f.db.rows.accountRateEvent.length, 1);
  assert.equal(f.db.rows.accountRateEvent[0].key, tokenDigest('synthetic'));
});
test('unknown reset is indistinguishable success envelope without an available code/send', async () => {
  const known = fixture(),
    unknown = fixture();
  await known.db.account.create({ data: { phone: '+8613800000001', passwordHash: DUMMY_PASSWORD_HASH } });
  const a = await known.service.sendCode({ purpose: 'RESET_PASSWORD', phone: '13800000001' });
  const b = await unknown.service.sendCode({ purpose: 'RESET_PASSWORD', phone: '13800000001' });
  assert.deepEqual(a, b);
  assert.equal(known.sent.length, 1);
  assert.equal(unknown.sent.length, 0);
  const row = unknown.db.rows.verificationCode[0];
  assert.ok(row.invalidatedAt);
  assert.equal(+row.expiresAt, +row.createdAt);
  assert.equal(row.deliveredAt, null);
  assert.equal(known.delays.length, 1);
  assert.equal(unknown.delays.length, 1);
  await limited(unknown.service.sendCode({ purpose: 'RESET_PASSWORD', phone: '13800000001' }));
});
test('daily cap counts reservations including failed/fake sends; Beijing midnight resets', async () => {
  const f = fixture({ smsDailyLimit: 1 });
  await f.service.sendCode({ purpose: 'RESET_PASSWORD', phone: '13800000001' });
  await assert.rejects(
    f.service.sendCode({ purpose: 'RESET_PASSWORD', phone: '13800000002' }),
    (e) => e.code === 'SMS_UNAVAILABLE' && e.status === 503
  );
  assert.equal(f.db.rows.verificationCode.length, 1);
  f.setTime('2026-11-04T16:00:00Z');
  await f.service.sendCode({ purpose: 'RESET_PASSWORD', phone: '13800000002' });
  assert.equal(f.db.rows.verificationCode.length, 2);
  assert.equal(f.sent.length, 0);
});
test('concurrent synthetic requests cannot over-reserve budget (serial stub, not proof of PG locks)', async () => {
  const f = fixture({ smsDailyLimit: 2 });
  const results = await Promise.allSettled(
    [1, 2, 3, 4].map((n) => f.service.sendCode({ purpose: 'RESET_PASSWORD', phone: '1380000000' + n }))
  );
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 2);
  assert.equal(f.db.rows.verificationCode.length, 2);
});

test('budget lock midnight rollover uses new day and rechecks registration invitation expiry', async () => {
  const f = fixture();
  let moved = false;
  const raw = f.db.$queryRaw.bind(f.db);
  f.db.$queryRaw = async (strings, key) => {
    if (String(key).startsWith('sms-day:') && !moved) {
      moved = true;
      f.setTime('2026-11-04T16:00:00Z');
    }
    return raw(strings, key);
  };
  await f.service.sendCode({ purpose: 'RESET_PASSWORD', phone: '13800000001' });
  assert.equal(f.db.rows.verificationCode[0].createdAt.toISOString(), '2026-11-04T16:00:00.000Z');
  assert.equal(f.db.locks.filter((key) => String(key).startsWith('sms-day:')).length, 2);
  const g = fixture(),
    token = 'I'.repeat(43);
  await g.db.invitation.create({
    data: { tokenHash: tokenDigest(token), membership: 'MEMBER', expiresAt: new Date('2026-11-04T16:00:00Z') }
  });
  const raw2 = g.db.$queryRaw.bind(g.db);
  g.db.$queryRaw = async (strings, key) => {
    if (String(key).startsWith('sms-day:')) g.setTime('2026-11-04T16:00:01Z');
    return raw2(strings, key);
  };
  await assert.rejects(
    g.service.sendCode({ purpose: 'REGISTER', phone: '13800000001', invitationToken: token }),
    (e) => e.code === 'INVITATION_EXPIRED'
  );
  assert.equal(g.sent.length, 0);
  assert.equal(g.db.rows.verificationCode.length, 0);
});
test('modest common floor is applied but slow provider latency remains observable', async () => {
  const known = fixture(),
    unknown = fixture();
  await known.db.account.create({ data: { phone: '+8613800000001', passwordHash: DUMMY_PASSWORD_HASH } });
  known.service.options.sms.send = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
  };
  const start = performance.now();
  await known.service.sendCode({ purpose: 'RESET_PASSWORD', phone: '13800000001' });
  const elapsed = performance.now() - start;
  await unknown.service.sendCode({ purpose: 'RESET_PASSWORD', phone: '13800000001' });
  assert.ok(known.delays[0] + elapsed >= 900);
  assert.ok(
    unknown.delays[0] > 500 && unknown.delays[0] <= 1000,
    'unknown path receives only the approved modest one-second floor'
  );
});
