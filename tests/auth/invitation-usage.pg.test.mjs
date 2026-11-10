// 邀请的单次 / 多次使用：用两个真实的数据库连接同时注册，确认单次邀请只能成功一次、
// 多次邀请可以重复使用，存储失败时整体回滚。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { loadInvitationCipher } from '../../apps/web/server/auth/invitation-cipher.ts';
import { mainlandChinaPhone } from '../../apps/web/server/auth/ports.ts';
import { tokenDigest } from '../../apps/web/server/auth/crypto.ts';
import { location } from './support/game-location.mjs';
import { createTestDatabase } from '../_shared/database.mjs';

const requireDb = createRequire(new URL('../../packages/db/package.json', import.meta.url));
const { PrismaPg } = requireDb('@prisma/adapter-pg');
const { PrismaClient } = await import('../../packages/db/src/generated/prisma/client.ts');

test('邀请使用次数：真实 PostgreSQL 上的并发与回滚', async (t) => {
  const testDb = await createTestDatabase();
  const pool = testDb.pool,
    a = testDb.db,
    b = new PrismaClient({
      adapter: new PrismaPg({ ...testDb.connection, max: 3, application_name: 'artzoo-test' })
    });
  t.after(async () => {
    await b.$disconnect();
    await testDb.close();
  });
  const check = (name, fn) => t.test(name, fn);
  const START = Date.parse('2026-10-26T00:00:00Z'),
    DAY = 86400000;
  let now = START,
    sequence = 100;
  const inbox = new Map(),
    sms = {
      mode: 'mock',
      available: true,
      async send(m) {
        inbox.set(m.phone, m.code);
      }
    };
  const cipher = loadInvitationCipher({ ARTZOO_INVITATION_KEY: Buffer.alloc(32, 7).toString('base64') });
  const options = {
    phone: mainlandChinaPhone,
    sms,
    invitationCipher: cipher,
    environment: 'test',
    now: () => new Date(now)
  };
  const sa = new AccountService(a, options),
    sb = new AccountService(b, options);
  const err = (code) => (e) => e.code === code;
  let adminToken, admin;
  async function invite(mode = 'SINGLE') {
    return sa.createInvitation(
      { membership: 'FRIEND', usageMode: mode, expiresAt: new Date(START + DAY).toISOString() },
      adminToken
    );
  }
  async function prepare(inv) {
    const n = ++sequence,
      phone = '+86138' + String(n).padStart(8, '0'),
      invitationToken = inv.invitePath.split('/').at(-1);
    await sa.sendCode({ phone, purpose: 'REGISTER', invitationToken });
    return {
      phone,
      invitationToken,
      displayName: '独立并发旅人' + n,
      ...location,
      code: inbox.get(phone),
      password: 'SyntheticOnly!7',
      confirmPassword: 'SyntheticOnly!7'
    };
  }
  function deferred() {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function bounded(p) {
    let timer;
    try {
      return await Promise.race([
        p,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('barrier timeout')), 7000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function hooked(client, hooks) {
    return new Proxy(client, {
      get(target, key) {
        if (key === '$transaction')
          return (fn, opts) => target.$transaction((tx) => fn(hooked(tx, hooks)), opts);
        if (key === '$queryRaw')
          return async (strings, ...values) => {
            const invitation =
              strings.join('').includes('pg_advisory_xact_lock') &&
              String(values[0]).startsWith('invitation:');
            if (invitation && hooks.before) await hooks.before(target);
            const value = await target.$queryRaw(strings, ...values);
            if (invitation && hooks.after) await hooks.after(target);
            return value;
          };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }
  async function race(mode) {
    const inv = await invite(mode),
      one = await prepare(inv),
      two = await prepare(inv),
      locked = deferred(),
      release = deferred(),
      waiting = deferred();
    let waiterPid;
    const first = new AccountService(
      hooked(a, {
        after: async () => {
          locked.resolve();
          await bounded(release.promise);
        }
      }),
      options
    );
    const second = new AccountService(
      hooked(b, {
        before: async (tx) => {
          waiterPid = (await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;
          waiting.resolve();
        }
      }),
      options
    );
    const p = first.register(one);
    p.catch(() => {});
    let q;
    try {
      await bounded(locked.promise);
      q = second.register(two);
      q.catch(() => {});
      await bounded(waiting.promise);
      let observed = false;
      for (let i = 0; i < 100; i++) {
        const rows = await pool.query(
          'SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype=$2 AND granted=false',
          [waiterPid, 'advisory']
        );
        if (rows.rowCount) {
          observed = true;
          break;
        }
        await wait(20);
      }
      assert.equal(
        observed,
        true,
        'second independent connection must wait on actual invitation advisory lock'
      );
    } finally {
      release.resolve();
    }
    const settled = await Promise.allSettled([p, q]);
    assert.equal(settled.filter((r) => r.status === 'fulfilled').length, mode === 'SINGLE' ? 1 : 2);
    if (mode === 'SINGLE') assert.equal(settled[1].reason.code, 'INVITATION_USED');
    const row = await a.invitation.findUniqueOrThrow({ where: { id: inv.invitation.id } });
    assert.equal(row.usageMode, mode);
    assert.equal(row.usedAt !== null, mode === 'SINGLE');
    if (mode === 'MULTIPLE') {
      assert.equal(row.usedById, null);
      assert.equal((await sa.invitationLink(row.id, adminToken)).invitePath, inv.invitePath);
      await sa.register(await prepare(inv));
      assert.equal(
        (await sa.list('invitations', new URL('http://localhost'), adminToken)).items.find(
          (x) => x.id === row.id
        ).status,
        'ACTIVE'
      );
    }
  }
  admin = await a.account.create({
    data: {
      phone: '+8613900009999',
      passwordHash: 'synthetic-unusable',
      membership: 'MEMBER',
      adminRole: 'ADMIN'
    }
  });
  adminToken = 'PGsyntheticAdmin'.padEnd(43, 'x');
  await a.accountSession.create({
    data: {
      accountId: admin.id,
      tokenHash: tokenDigest(adminToken),
      createdAt: new Date(now),
      expiresAt: new Date(now + DAY)
    }
  });
  await check('two real PostgreSQL connections contend for SINGLE invitation: exactly one registration', () =>
    race('SINGLE')
  );
  await check(
    'two real PostgreSQL connections contend for MULTIPLE invitation: both plus a later registration succeed',
    () => race('MULTIPLE')
  );
  await check(
    'MULTIPLE exact expiry rejects registration and code/link paths without consuming account/code',
    async () => {
      const inv = await invite('MULTIPLE'),
        body = await prepare(inv);
      now = START + DAY;
      await assert.rejects(() => sa.register(body), err('INVITATION_EXPIRED'));
      await assert.rejects(() => sa.invitation(body.invitationToken), err('INVITATION_EXPIRED'));
      await assert.rejects(() => sa.sendCode({ ...body, purpose: 'REGISTER' }), err('INVITATION_EXPIRED'));
      assert.equal(await a.account.count({ where: { phone: body.phone } }), 0);
      assert.equal((await a.verificationCode.findFirst({ where: { phone: body.phone } })).consumedAt, null);
      now = START;
    }
  );
  await check(
    'MULTIPLE revoke/remove after first registration reject pending use and preserve first account',
    async () => {
      for (const method of ['revokeInvitation', 'removeInvitation']) {
        const inv = await invite('MULTIPLE'),
          one = await prepare(inv),
          two = await prepare(inv);
        await sa.register(one);
        await sa[method](inv.invitation.id, { reason: 'synthetic PG test' }, adminToken);
        await assert.rejects(
          () => sb.register(two),
          err(method === 'revokeInvitation' ? 'INVITATION_REVOKED' : 'INVITATION_INVALID')
        );
        assert.equal(await a.account.count({ where: { phone: one.phone } }), 1);
        assert.equal(await a.account.count({ where: { phone: two.phone } }), 0);
        assert.equal((await a.invitation.findUnique({ where: { id: inv.invitation.id } })).usedAt, null);
      }
    }
  );
  await check(
    'MULTIPLE uniqueness remains exact and rejected nickname leaves invitation usable',
    async () => {
      const inv = await invite('MULTIPLE'),
        one = await prepare(inv),
        two = await prepare(inv);
      await sa.register(one);
      await assert.rejects(
        () => sb.register({ ...two, displayName: one.displayName }),
        err('GAME_NICKNAME_TAKEN')
      );
      assert.equal((await a.verificationCode.findFirst({ where: { phone: two.phone } })).consumedAt, null);
      await sb.register(two);
      assert.equal((await a.invitation.findUnique({ where: { id: inv.invitation.id } })).usedAt, null);
    }
  );
  await check(
    'MULTIPLE account/code transaction rollback preserves reusable invitation on storage failure',
    async () => {
      const inv = await invite('MULTIPLE'),
        body = await prepare(inv);
      const proxy = new Proxy(a, {
        get(target, key) {
          if (key === '$transaction')
            return (fn, opts) =>
              target.$transaction(
                (tx) =>
                  fn(
                    new Proxy(tx, {
                      get(t, k) {
                        if (k === 'verificationCode')
                          return new Proxy(t.verificationCode, {
                            get(m, n) {
                              if (n === 'update')
                                return async (arg) => {
                                  if (arg.data.consumedAt) throw Error('synthetic write failure');
                                  return m.update(arg);
                                };
                              const v = m[n];
                              return typeof v === 'function' ? v.bind(m) : v;
                            }
                          });
                        const v = t[k];
                        return typeof v === 'function' ? v.bind(t) : v;
                      }
                    })
                  ),
                opts
              );
          const v = target[key];
          return typeof v === 'function' ? v.bind(target) : v;
        }
      });
      await assert.rejects(
        () => new AccountService(proxy, options).register(body),
        /synthetic write failure/
      );
      assert.equal(await a.account.count({ where: { phone: body.phone } }), 0);
      assert.equal((await a.verificationCode.findFirst({ where: { phone: body.phone } })).consumedAt, null);
      await sa.register(body);
    }
  );
});
