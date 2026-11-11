// 后台管理（真实 PostgreSQL）：只有超级管理员能任免管理员；不能改自己和其他超管；
// 版本号与幂等；锁等待后重新核对权限；审计只追加；任何操作都不影响业务数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';

test('后台管理：真实 PostgreSQL', async (t) => {
  const { fixture, roleBody, noPrivate, effects, snapshot, observe } =
    await import('./support/admin-fixture.mjs');
  const { AccountService } = await import('../../apps/web/server/auth/service.ts');
  const { AdminManagementService } = await import('../../apps/web/server/admin-management/service.ts');
  const { mainlandChinaPhone, unavailableSms } = await import('../../apps/web/server/auth/ports.ts');
  const { tokenDigest } = await import('../../apps/web/server/auth/crypto.ts');
  const f = await fixture(),
    { db, ids, tokens } = f;
  let clock = new Date('2030-10-01T00:00:00Z');
  const authFor = (database = db) =>
    new AccountService(database, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      environment: 'test',
      now: () => clock
    });
  const auth = authFor(),
    service = new AdminManagementService(auth);
  const url = (query = '') => new URL('http://test/api/admin/management/accounts' + query);
  const row = (index) => db.account.findUniqueOrThrow({ where: { id: ids[index] } });

  const reject = (fn, status) => assert.rejects(fn, (e) => e.status === status);
  const check = (name, fn) =>
    t.test(name, async () => {
      clock = new Date('2030-10-01T00:00:00Z');
      await fn();
    });
  const change = async (index, role, extra = {}) =>
    service.changeRole(ids[index], roleBody(await row(index), role, extra), tokens[0]);
  async function actor() {
    const account = await db.account.create({
        data: {
          phone: 'management-expiry-' + randomUUID(),
          passwordHash: 'NONLOGIN-SYNTHETIC',
          displayName: '合成最终校验超管',
          membership: 'MEMBER',
          adminRole: 'SUPER_ADMIN'
        }
      }),
      token = randomBytes(32).toString('base64url'),
      expiresAt = new Date(+clock + 1000);
    const session = await db.accountSession.create({
      data: { accountId: account.id, tokenHash: tokenDigest(token), expiresAt }
    });
    return { account, token, session, expiresAt };
  }
  try {
    const protectedBefore = await effects(db);
    await check(
      'only super administrators may read or write; ordinary administrators members friends and anonymous are rejected',
      async () => {
        for (const token of [null, tokens[1], tokens[2], tokens[3], tokens[4]]) {
          const status = token ? 403 : 401;
          await reject(() => service.accounts(url('?query=合成'), token), status);
          await reject(() => service.audits(url('?scope=roles'), token), status);
          await reject(async () => service.changeRole(ids[6], roleBody(await row(6)), token), status);
        }
        for (const index of [0, 5]) {
          noPrivate(await service.accounts(url('?query=合成'), tokens[index]));
          noPrivate(await service.audits(url('?scope=roles'), tokens[index]));
        }
        assert.deepEqual((await service.accounts(url(), tokens[0])).items, []);
      }
    );
    await check(
      'member and friend qualification toggles preserve membership and all other account fields; existing sessions change ordinary-admin access immediately',
      async () => {
        for (const index of [2, 3]) {
          const before = await row(index);
          await reject(() => auth.requireAccount(db, tokens[index], true), 403);
          const granted = await change(index, 'ADMIN');
          assert.equal(granted.account.adminRole, 'ADMIN');
          assert.equal(granted.account.adminRoleRevision, before.adminRoleRevision + 1);
          assert.equal((await auth.requireAccount(db, tokens[index], true)).accountId, ids[index]);
          const revoked = await change(index, 'NONE');
          assert.equal(revoked.account.membership, before.membership);
          await reject(() => auth.requireAccount(db, tokens[index], true), 403);
          const after = await row(index);
          for (const key of Object.keys(before))
            if (!['adminRole', 'adminRoleRevision', 'updatedAt'].includes(key))
              assert.deepEqual(after[key], before[key], key);
        }
      }
    );
    await check(
      'super targets self promotion strict fields empty reasons and stale role revisions never write',
      async () => {
        const target = await row(6),
          before = await snapshot(db);
        for (const id of [ids[0], ids[5]])
          await reject(() => service.changeRole(id, roleBody(target), tokens[0]), 403);
        for (const body of [
          roleBody(target, 'SUPER_ADMIN'),
          roleBody(target, 'ADMIN', { expectedRole: 'SUPER_ADMIN' }),
          roleBody(target, 'ADMIN', { expectedRevision: -1 }),
          roleBody(target, 'ADMIN', { expectedRevision: 2147483647 }),
          roleBody(target, 'ADMIN', { reason: '' }),
          roleBody(target, 'ADMIN', { reason: 'x'.repeat(1001) }),
          roleBody(target, 'ADMIN', { membership: 'FRIEND' }),
          roleBody(target, 'ADMIN', { idempotencyKey: 'bad' })
        ])
          await reject(() => service.changeRole(target.id, body, tokens[0]), 400);
        await reject(() => service.changeRole('invalid', roleBody(target), tokens[0]), 400);
        await reject(() => service.changeRole(randomUUID(), roleBody(target), tokens[0]), 404);
        assert.deepEqual(await snapshot(db), before);
      }
    );
    await check(
      'role same-key concurrency writes once; ABA stale revision and actor-key cross-command reuse conflict',
      async () => {
        const target = await row(6),
          original = roleBody(target),
          twice = await Promise.all([
            service.changeRole(target.id, original, tokens[0]),
            service.changeRole(target.id, original, tokens[0])
          ]);
        assert.deepEqual(twice.map((x) => x.replayed).sort(), [false, true]);
        const state = await snapshot(db);
        await reject(() => service.changeRole(target.id, { ...original, reason: 'changed' }, tokens[0]), 409);
        assert.deepEqual(await snapshot(db), state);
        await change(6, 'NONE');
        const current = await row(6);
        assert.equal(current.adminRole, target.adminRole);
        assert.equal(current.adminRoleRevision, target.adminRoleRevision + 2);
        await reject(() => service.changeRole(target.id, roleBody(target), tokens[0]), 409);
        const replay = await service.changeRole(target.id, original, tokens[0]);
        assert.equal(replay.replayed, true);
        assert.equal(replay.account.adminRole, 'NONE');
        assert.equal(replay.account.adminRoleRevision, current.adminRoleRevision);
        const a = roleBody(current),
          b = roleBody(current, a.adminRole);
        const race = await Promise.allSettled([
          service.changeRole(target.id, a, tokens[0]),
          service.changeRole(target.id, b, tokens[5])
        ]);
        assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1);
        assert.equal(race.find((x) => x.status === 'rejected').reason.status, 409);
      }
    );
    await check(
      'scoped audit pagination and account search return safe DTOs with actor target reason and versions',
      async () => {
        for (const scope of ['roles']) {
          const first = await service.audits(url('?scope=' + scope + '&page=1&pageSize=2'), tokens[0]),
            second = await service.audits(url('?scope=' + scope + '&page=2&pageSize=2'), tokens[0]);
          assert.ok(first.total > 0);
          assert.ok(first.items.length <= 2);
          assert.equal(first.total, second.total);
          noPrivate(first);
          for (const item of first.items) {
            assert.ok(item.actor.id);
            assert.ok(item.reason);
            assert.ok(item.createdAt);
            assert.equal(item.kind, 'ADMIN_ROLE_CHANGED');
          }
        }
        const page = await service.accounts(
          url('?query=' + encodeURIComponent(f.people[2].displayName) + '&page=1&pageSize=1'),
          tokens[0]
        );
        assert.equal(page.items[0].id, ids[2]);
        assert.ok(Number.isInteger(page.items[0].adminRoleRevision));
        noPrivate(page);
        for (const query of ['?query=合成&page=0', '?query=合成&pageSize=101'])
          await reject(() => service.accounts(url(query), tokens[0]), 400);
        for (const scope of ['all', 'public-qq'])
          await reject(() => service.audits(url('?scope=' + scope), tokens[0]), 400);
      }
    );
    await check(
      'completed final command and authentication-return expiry roll back role writes and reject committed replay',
      async () => {
        let branches = 0;
        for (const replay of [false, true])
          for (const seam of ['command', 'auth-return']) {
            clock = new Date('2030-10-01T00:00:00Z');
            const own = await actor(),
              target = await row(2),
              key = randomUUID(),
              input = roleBody(target, undefined, { idempotencyKey: key });
            const execute = (s) => s.changeRole(target.id, input, own.token);
            if (replay) await execute(service);
            const before = await snapshot(db);
            let ready = false,
              advanced = 0,
              valid = false;
            const observed = observe(db, (event) => {
                if (
                  event.member === 'adminManagementCommand' &&
                  JSON.stringify(event.args).includes(key) &&
                  ((event.method === 'create' && !replay) ||
                    (event.method === 'findUnique' && replay && event.result))
                ) {
                  ready = true;
                  if (seam === 'command' && !advanced) {
                    clock = own.expiresAt;
                    advanced++;
                  }
                }
              }),
              wrapped = authFor(observed),
              real = wrapped.requireAccount.bind(wrapped);
            wrapped.requireAccount = async (...args) => {
              const result = await real(...args);
              if (ready && seam === 'auth-return' && !advanced) {
                valid = clock < result.expiresAt;
                clock = own.expiresAt;
                advanced++;
              }
              return result;
            };
            await reject(() => execute(new AdminManagementService(wrapped)), 401);
            assert.equal(advanced, 1);
            if (seam === 'auth-return') assert.equal(valid, true);
            assert.deepEqual(await snapshot(db), before);
            branches++;
          }
        assert.equal(branches, 4);
      }
    );
    await check(
      'final membership role and session changes revalidate exact actor on new writes and replays',
      async () => {
        for (const replay of [false, true])
          for (const crossing of ['membership', 'role', 'session']) {
            clock = new Date('2030-10-01T00:00:00Z');
            const own = await actor(),
              target = await row(3),
              input = roleBody(target);
            if (replay) await service.changeRole(target.id, input, own.token);
            const before = await snapshot(db);
            let ready = false,
              changed = 0;
            const observed = observe(db, (event) => {
                if (
                  event.member === 'adminManagementCommand' &&
                  JSON.stringify(event.args).includes(input.idempotencyKey) &&
                  ((event.method === 'create' && !replay) ||
                    (event.method === 'findUnique' && replay && event.result))
                )
                  ready = true;
              }),
              wrapped = authFor(observed),
              real = wrapped.requireAccount.bind(wrapped);
            wrapped.requireAccount = async (tx, ...args) => {
              if (ready && !changed) {
                changed++;
                if (crossing === 'session')
                  await tx.accountSession.update({
                    where: { id: own.session.id },
                    data: { revokedAt: clock }
                  });
                else
                  await tx.account.update({
                    where: { id: own.account.id },
                    data: crossing === 'membership' ? { membership: 'FRIEND' } : { adminRole: 'ADMIN' }
                  });
              }
              return real(tx, ...args);
            };
            await assert.rejects(
              () => new AdminManagementService(wrapped).changeRole(target.id, input, own.token),
              (e) => [401, 403].includes(e.status)
            );
            assert.equal(changed, 1);
            assert.deepEqual(await snapshot(db), before);
          }
      }
    );
    await check(
      'invitation write serializes before role revocation and final read rejects revoked administrator',
      async () => {
        const target = await row(1);
        assert.equal(target.adminRole, 'ADMIN');
        const invite = await db.invitation.create({
            data: {
              tokenHash: tokenDigest(randomUUID()),
              tokenCiphertext: 'synthetic',
              membership: 'MEMBER',
              expiresAt: new Date('2035-01-01'),
              createdById: ids[1]
            }
          }),
          lockKey = 'invitation:' + invite.tokenHash;
        let enter, release;
        const ready = new Promise((r) => (enter = r)),
          blocked = new Promise((r) => (release = r)),
          holder = db.$transaction(
            async (tx) => {
              await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text', lockKey);
              enter();
              await blocked;
            },
            { timeout: 15000 }
          );
        await ready;
        const order = [],
          writing = auth.revokeInvitation(invite.id, { reason: '合成邀请撤销' }, tokens[1]).then((value) => {
            order.push('invitation');
            return value;
          });
        const waitCount = async (minimum) => {
          for (let n = 0; n < 150; n++) {
            const [r] = await db.$queryRawUnsafe(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted"
            );
            if (r.n >= minimum) return;
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.fail('real PostgreSQL advisory wait not observed');
        };
        let revoking;
        try {
          await waitCount(1);
          revoking = service.changeRole(ids[1], roleBody(target, 'NONE'), tokens[0]).then((value) => {
            order.push('role');
            return value;
          });
          await waitCount(2);
          assert.deepEqual(order, []);
          release();
          await holder;
          await writing;
          await revoking;
          assert.deepEqual(order, ['invitation', 'role']);
          await reject(
            () => auth.revokeInvitation(invite.id, { reason: '撤权后不可重放旧邀请' }, tokens[1]),
            403
          );
        } finally {
          release();
          await holder;
          await writing;
          if (revoking) await revoking;
        }
        // One read-side wait after completed real invitation SQL; no fabricated row/auth result.
        await change(1, 'ADMIN');
        let readEnter, readRelease;
        const readReady = new Promise((r) => (readEnter = r)),
          readBlocked = new Promise((r) => (readRelease = r));
        let paused = false;
        const delayed = observe(db, async (event) => {
            if (event.member === 'invitation' && event.method === 'findMany' && !paused) {
              paused = true;
              readEnter();
              await readBlocked;
            }
          }),
          reader = authFor(delayed);
        const reading = reader.list('invitations', url(), tokens[1]).then(
          (value) => ({ value }),
          (error) => ({ error })
        );
        await readReady;
        try {
          await change(1, 'NONE');
          readRelease();
          assert.equal((await reading).error?.status, 403);
        } finally {
          readRelease();
          await reading;
        }
      }
    );
    assert.deepEqual(await effects(db), protectedBefore);
  } finally {
    await f.close();
  }
});
