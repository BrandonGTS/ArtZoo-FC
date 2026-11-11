import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { fixture } from '../activities/support/pg-fixture.mjs';
import { seedBindingHistory, managedBindingChecks } from './support/binding-managed.mjs';
import { AccountService } from '../../apps/web/server/auth/service.ts';
import { mainlandChinaPhone, unavailableSms } from '../../apps/web/server/auth/ports.ts';
import { tokenDigest } from '../../apps/web/server/auth/crypto.ts';
import {
  QqBindingService,
  resolveBoundActor,
  revalidateBoundActor
} from '../../apps/web/server/qq-official/binding.ts';

test('QQ 一次性密钥绑定与解绑（数据库）', async (t) => {
  const f = await fixture({ accounts: 20 });
  try {
    let now = new Date('2030-06-01T10:00:00Z');
    const auth = new AccountService(f.db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      environment: 'test',
      now: () => now
    });
    const scope = { appId: 'synthetic_app', botId: 'synthetic_bot', groupOpenId: 'synthetic_group' };
    const config = {
      mode: 'live',
      passiveEnabled: true,
      proactiveEnabled: true,
      signupButtons: true,
      bridgeSecret: null,
      target: {
        ...scope,
        enabled: true,
        testGroupOnly: true,
        enabledAt: new Date('2030-06-01T09:00:00Z'),
        deliveryMode: 'LIVE'
      }
    };
    const service = new QqBindingService(auth, config);
    const check = (name, fn) => t.test(name, fn);
    // Never include an exception message: an assertion or database error can contain the bearer key.
    const reject = (fn) => assert.rejects(fn, (e) => !!e && typeof e.code === 'string');
    const issue = (i) => service.initiate(f.tokens[i]);
    const progress = (i, k) => service.progress({ requestId: k.requestId }, f.tokens[i]);
    const row = (k) => f.db.qqOfficialBindingKey.findUniqueOrThrow({ where: { id: k.requestId } });
    const member = (i) => 'synthetic_member_' + i;
    const bind = (k, i, s = scope) => service.bindKey(s, member(i), k.key);
    await seedBindingHistory(f, scope, now);
    const business = async () => ({
      activities: await f.db.activity.findMany({ orderBy: { id: 'asc' } }),
      registrations: await f.db.activityRegistration.findMany(),
      outbox: await f.db.activityOutbox.findMany(),
      messages: await f.db.messageNotification.findMany(),
      deliveries: await f.db.qqOfficialDelivery.findMany()
    });
    const baseline = await business();
    assert.ok(
      baseline.activities.length &&
        baseline.registrations.length &&
        baseline.outbox.length &&
        baseline.messages.length &&
        baseline.deliveries.length
    );
    let first, firstBinding;
    await check('256-bit key stored only as digest and readonly pending progress', async () => {
      first = await issue(0);
      assert.deepEqual(Object.keys(first).sort(), ['expiresAt', 'key', 'requestId']);
      assert.match(first.key, /^[A-Za-z0-9_-]{43}$/);
      const before = await row(first);
      assert.equal(before.keyHash, tokenDigest(first.key));
      assert.equal(before.accountId, f.ids[0]);
      assert.equal(before.groupOpenId, scope.groupOpenId);
      assert.ok(!JSON.stringify(before).includes(first.key));
      assert.deepEqual(await progress(0, first), { state: 'PENDING', expiresAt: first.expiresAt });
      assert.deepEqual(await row(first), before);
    });
    await check('successful bind atomically consumes key creates protocol2 and one audit', async () => {
      const audit = await f.db.qqOfficialBindingAudit.count({ where: { accountId: f.ids[0] } });
      const reply = await bind(first, 0);
      assert.ok(!JSON.stringify(reply).includes(first.key));
      firstBinding = await f.db.qqOfficialBinding.findFirstOrThrow({
        where: { accountId: f.ids[0], ...scope }
      });
      assert.equal(firstBinding.memberOpenId, member(0));
      const key = await row(first);
      assert.ok(key.consumedAt);
      assert.equal(key.bindingId, firstBinding.id);
      assert.deepEqual(await progress(0, first), {
        state: 'BOUND',
        expiresAt: first.expiresAt,
        bindingId: firstBinding.id
      });
      assert.equal(await f.db.qqOfficialBindingAudit.count({ where: { accountId: f.ids[0] } }), audit + 1);
    });
    await check('replay malformed and unknown keys fail without mutation or key disclosure', async () => {
      const before = await f.db.qqOfficialBinding.count(),
        audit = await f.db.qqOfficialBindingAudit.count();
      for (const key of [first.key, 'bad', 'A'.repeat(43), '', first.key + 'x']) {
        try {
          await service.bindKey(scope, member(19), key);
          assert.fail('unexpected success');
        } catch (e) {
          assert.ok(e.code);
          assert.ok(!String(e.message).includes(first.key));
          if (key.length === 43) assert.ok(!String(e.message).includes(key));
        }
      }
      assert.equal(await f.db.qqOfficialBinding.count(), before);
      assert.equal(await f.db.qqOfficialBindingAudit.count(), audit);
    });
    await check('wrong app bot or group scope cannot consume key', async () => {
      const k = await issue(1);
      for (const field of ['appId', 'botId', 'groupOpenId'])
        await reject(() => bind(k, 1, { ...scope, [field]: 'synthetic_wrong' }));
      assert.equal((await progress(1, k)).state, 'PENDING');
      await bind(k, 1);
    });
    await check('disabled group rejects initiation and consumption', async () => {
      const k = await issue(2),
        disabled = new QqBindingService(auth, { ...config, target: { ...config.target, enabled: false } });
      await reject(() => disabled.initiate(f.tokens[2]));
      await reject(() => disabled.bindKey(scope, member(2), k.key));
      assert.equal((await progress(2, k)).state, 'PENDING');
    });
    await check('regeneration revokes all unused account keys', async () => {
      const old = await issue(3),
        fresh = await issue(3);
      assert.notEqual(old.key, fresh.key);
      assert.equal((await progress(3, old)).state, 'REVOKED');
      assert.ok((await row(old)).invalidatedAt);
      await reject(() => bind(old, 3));
      assert.equal((await progress(3, fresh)).state, 'PENDING');
    });
    await check('expiry is visible readonly and forbids consumption', async () => {
      const k = await issue(4);
      now = new Date(k.expiresAt);
      const before = await row(k);
      assert.equal((await progress(4, k)).state, 'EXPIRED');
      await reject(() => bind(k, 4));
      assert.deepEqual(await row(k), before);
      now = new Date('2030-06-01T10:00:00Z');
    });
    await check('cross account and sibling session cannot progress or cancel', async () => {
      const k = await issue(6);
      await reject(() => progress(7, k));
      await reject(() => service.cancel({ requestId: k.requestId }, f.tokens[7]));
      const token = randomBytes(32).toString('base64url');
      await f.db.accountSession.create({
        data: {
          accountId: f.ids[6],
          tokenHash: tokenDigest(token),
          expiresAt: new Date('2035-01-01T00:00:00Z')
        }
      });
      assert.equal((await auth.requireAccount(f.db, token)).accountId, f.ids[6]);
      await reject(() => service.progress({ requestId: k.requestId }, token));
      await reject(() => service.cancel({ requestId: k.requestId }, token));
      assert.equal((await progress(6, k)).state, 'PENDING');
      await service.cancel({ requestId: k.requestId }, f.tokens[6]);
      assert.equal((await progress(6, k)).state, 'REVOKED');
      await reject(() => bind(k, 6));
    });
    await check('same bearer key concurrent different QQ identities has exactly one winner', async () => {
      const k = await issue(8),
        answers = await Promise.allSettled([bind(k, 8), bind(k, 9)]);
      assert.equal(answers.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal(await f.db.qqOfficialBinding.count({ where: { accountId: f.ids[8] } }), 1);
      assert.equal(
        await f.db.qqOfficialBindingAudit.count({ where: { accountId: f.ids[8], action: 'BOUND' } }),
        1
      );
    });
    await check('two account keys racing for one QQ identity never overwrite', async () => {
      const a = await issue(9),
        b = await issue(10),
        answers = await Promise.allSettled([bind(a, 10), bind(b, 10)]);
      assert.equal(answers.filter((x) => x.status === 'fulfilled').length, 1);
      const winner = await f.db.qqOfficialBinding.findFirstOrThrow({
        where: { ...scope, memberOpenId: member(10) }
      });
      const losing = winner.accountId === f.ids[9] ? b : a;
      await reject(() => bind(losing, 10));
      assert.deepEqual(await f.db.qqOfficialBinding.findUnique({ where: { id: winner.id } }), winner);
    });
    await check(
      'bound account cannot generate another key and unsafe unlink never removes binding',
      async () => {
        await reject(() => issue(0));
        for (const [body, token] of [
          [{ bindingId: firstBinding.id, version: firstBinding.version, confirmed: true }, f.tokens[7]],
          [{ bindingId: firstBinding.id, version: firstBinding.version, confirmed: false }, f.tokens[0]],
          [{ bindingId: firstBinding.id, version: firstBinding.version + 1, confirmed: true }, f.tokens[0]]
        ])
          await reject(() => service.unlink(body, token));
        assert.deepEqual(
          await f.db.qqOfficialBinding.findUnique({ where: { id: firstBinding.id } }),
          firstBinding
        );
      }
    );
    await check(
      'explicit owner unlink revokes all own pending keys and preserves other accounts',
      async () => {
        const sessionId = (await row(first)).sessionId;
        const pending = await f.db.qqOfficialBindingKey.create({
          data: {
            ...scope,
            groupOpenId: 'synthetic_second_group',
            enabledAt: config.target.enabledAt,
            accountId: f.ids[0],
            sessionId,
            keyHash: tokenDigest(randomUUID()),
            expiresAt: new Date('2030-06-01T11:00:00Z')
          }
        });
        const other = await issue(17),
          otherBefore = await row(other);
        await service.unlink(
          { bindingId: firstBinding.id, version: firstBinding.version, confirmed: true },
          f.tokens[0]
        );
        assert.equal(await f.db.qqOfficialBinding.findUnique({ where: { id: firstBinding.id } }), null);
        assert.ok(
          (await f.db.qqOfficialBindingKey.findUniqueOrThrow({ where: { id: pending.id } })).invalidatedAt
        );
        assert.deepEqual(await row(other), otherBefore);
        assert.ok((await row(first)).consumedAt);
      }
    );
    async function waitingMutation(i, mutate) {
      const k = await issue(i);
      let release, ready;
      const gate = new Promise((r) => (release = r)),
        locked = new Promise((r) => (ready = r));
      const holder = f.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${f.ids[i]} FOR UPDATE`;
        ready();
        await gate;
        await mutate(tx, k);
      });
      await locked;
      let pending;
      try {
        pending = bind(k, i).then(
          () => ({ ok: true }),
          () => ({ ok: false })
        );
        let blocked = false;
        for (let n = 0; n < 150; n++) {
          const [x] = await f.db
            .$queryRaw`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted AND locktype IN ('tuple','transactionid','advisory')) AS blocked`;
          if (x.blocked) {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.ok(blocked);
        release();
        await holder;
        assert.equal((await pending).ok, false);
        assert.equal(await f.db.qqOfficialBinding.count({ where: { accountId: f.ids[i] } }), 0);
        assert.equal((await row(k)).consumedAt, null);
      } finally {
        release();
        await holder;
        if (pending) await pending;
      }
    }
    await check('session revoked while waiting for account lock cannot bind', () =>
      waitingMutation(12, async (tx, k) => {
        await tx.accountSession.update({ where: { id: (await row(k)).sessionId }, data: { revokedAt: now } });
      })
    );
    await check('session expiry committed while waiting for account lock cannot bind', () =>
      waitingMutation(13, async (tx, k) => {
        await tx.accountSession.update({ where: { id: (await row(k)).sessionId }, data: { expiresAt: now } });
      })
    );
    await check('key expires during real lock wait and cannot bind', () =>
      waitingMutation(14, async (_tx, k) => {
        now = new Date(k.expiresAt);
      })
    );
    now = new Date('2030-06-01T10:00:00Z');
    await check('deleted original session cannot consume its pending key', async () => {
      const k = await issue(18);
      await f.db.accountSession.delete({ where: { id: (await row(k)).sessionId } });
      await reject(() => bind(k, 18));
      assert.equal(await f.db.qqOfficialBinding.count({ where: { accountId: f.ids[18] } }), 0);
    });
    await check('changed group enabled anchor rejects previously issued key', async () => {
      const k = await issue(19),
        changed = new QqBindingService(auth, {
          ...config,
          target: { ...config.target, enabledAt: new Date('2030-06-01T09:30:00Z') }
        });
      await reject(() => changed.bindKey(scope, member(19), k.key));
      assert.equal((await row(k)).consumedAt, null);
    });
    await check('cancel consumed key reports conflict and never unbinds', async () => {
      const binding = await f.db.qqOfficialBinding.findFirstOrThrow({ where: { accountId: f.ids[1] } });
      const key = await f.db.qqOfficialBindingKey.findFirstOrThrow({ where: { bindingId: binding.id } });
      await assert.rejects(
        () => service.cancel({ requestId: key.id }, f.tokens[1]),
        (e) => e?.code === 'CONFLICT'
      );
      assert.deepEqual(await f.db.qqOfficialBinding.findUnique({ where: { id: binding.id } }), binding);
    });
    await check('account initiation limit is five per fifteen minutes', async () => {
      for (let i = 0; i < 5; i++) await issue(15);
      await reject(() => issue(15));
    });
    await check(
      'trusted bridge binds once caches identical event and rejects fresh replay without storing raw key',
      async () => {
        const { QqBridgeService } = await import('../../apps/web/server/qq-official/bridge.ts');
        const bridge = new QqBridgeService(auth, config),
          k = await issue(16);
        const body = {
          app_id: scope.appId,
          bot_id: scope.botId,
          group_openid: scope.groupOpenId,
          sender_openid: member(16),
          simulation: false,
          event_id: randomUUID(),
          message_idx: randomUUID(),
          event_timestamp: now.toISOString(),
          content: `<@${scope.botId}> 绑定 ${k.key}`
        };
        const first = await bridge.command(body);
        assert.match(first.message, /绑定成功/);
        assert.ok(!first.message.includes(k.key));
        assert.deepEqual(await bridge.command(body), first);
        await assert.rejects(
          () => bridge.command({ ...body, content: body.content + 'x' }),
          (e) => e?.code === 'FORBIDDEN'
        );
        const replay = await bridge.command({ ...body, event_id: randomUUID(), message_idx: randomUUID() });
        assert.ok(!replay.message.includes('绑定成功'));
        assert.equal(await f.db.qqOfficialBinding.count({ where: { accountId: f.ids[16] } }), 1);
        assert.equal(
          await f.db.qqOfficialBindingAudit.count({ where: { accountId: f.ids[16], action: 'BOUND' } }),
          1
        );
        const inbound = await f.db.qqOfficialInbound.findMany({ where: { ...scope } });
        assert.ok(inbound.length >= 2);
        assert.ok(!JSON.stringify(inbound).includes(k.key));
      }
    );
    await managedBindingChecks(f, check);
    await check(
      'binding operations leave nonempty signup history and notification tables untouched',
      async () => assert.deepEqual(await business(), baseline)
    );
  } finally {
    await f.cleanup();
  }
});
