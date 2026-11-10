import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { qqSignature, verifyQqSignature } from '../../apps/web/server/qq-official/signature.ts';
import {
  loadQqOfficialConfig,
  loadQqOfficialPlanningConfig
} from '../../packages/db/src/qq-official-config.ts';
import { QqBridgeService } from '../../apps/web/server/qq-official/bridge.ts';
const now = new Date('2030-06-01T10:00:00Z'),
  secret = 'synthetic-bridge-test-secret-only-0000',
  path = '/api/qq-official/bridge/commands';
const raw = '{"content":"报名 H1 白魔","simulation":true}',
  stamp = String(now.getTime() / 1000),
  nonce = 'synthetic_nonce_123456';
const headers = (patch = {}) =>
  new Headers({
    'x-artzoo-timestamp': stamp,
    'x-artzoo-nonce': nonce,
    'x-artzoo-signature': qqSignature(secret, stamp, nonce, path, raw),
    ...patch
  });
const denied = (fn) => assert.throws(fn, (e) => e.code === 'FORBIDDEN');
test('signature matches independently constructed HMAC and exact UTF-8 body', () => {
  const digest = createHash('sha256').update(raw).digest('hex');
  assert.equal(
    qqSignature(secret, stamp, nonce, path, raw),
    createHmac('sha256', secret).update([stamp, nonce, 'POST', path, digest].join('\n')).digest('hex')
  );
  assert.deepEqual(verifyQqSignature(headers(), path, raw, secret, now), {
    nonce,
    expiresAt: new Date(now.getTime() + 120000)
  });
});
test('signature rejects raw whitespace, content tamper, route, secret and nonce substitution', () => {
  for (const [p, r, s, h] of [
    [path, raw + ' ', secret, headers()],
    ['/api/qq-official/bridge/ack', raw, secret, headers()],
    [path, raw.replace('白魔', '学者'), secret, headers()],
    [path, raw, 'another-synthetic-secret', headers()],
    [path, raw, secret, headers({ 'x-artzoo-nonce': nonce + 'x' })]
  ])
    denied(() => verifyQqSignature(h, p, r, s, now));
});
test('signature enforces 60 second boundary and strict header syntax', () => {
  for (const delta of [60000, -60000])
    assert.ok(verifyQqSignature(headers(), path, raw, secret, new Date(now.getTime() + delta)));
  for (const delta of [60001, -60001])
    denied(() => verifyQqSignature(headers(), path, raw, secret, new Date(now.getTime() + delta)));
  for (const patch of [
    { 'x-artzoo-timestamp': '1e9' },
    { 'x-artzoo-timestamp': stamp + '.0' },
    { 'x-artzoo-nonce': 'short' },
    { 'x-artzoo-nonce': 'a'.repeat(129) },
    { 'x-artzoo-signature': 'A'.repeat(64) },
    { 'x-artzoo-signature': '0'.repeat(63) }
  ])
    denied(() => verifyQqSignature(headers(patch), path, raw, secret, now));
});
const env = {
  NODE_ENV: 'test',
  ARTZOO_QQ_MODE: 'simulation',
  ARTZOO_QQ_TARGET_KIND: 'TEST',
  ARTZOO_QQ_TEST_GROUP_APPROVED: '1',
  ARTZOO_QQ_APP_ID: 'mock_app',
  ARTZOO_QQ_BOT_ID: 'mock_bot',
  ARTZOO_QQ_GROUP_OPENID: 'mock_group',
  ARTZOO_QQ_ENABLED_AT: '2030-06-01T09:00:00Z',
  ARTZOO_QQ_BRIDGE_SECRET: secret
};
test('config defaults disabled and rejects incomplete or unsafe simulation scope', () => {
  assert.deepEqual(loadQqOfficialConfig({}), { mode: 'disabled', target: null, bridgeSecret: null });
  for (const patch of [
    { ARTZOO_QQ_MODE: 'LIVE' },
    { ARTZOO_QQ_TARGET_KIND: 'PRODUCTION' },
    { ARTZOO_QQ_TEST_GROUP_APPROVED: '0' },
    { ARTZOO_QQ_APP_ID: 'real_app' },
    { ARTZOO_QQ_GROUP_OPENID: 'bad/group' },
    { ARTZOO_QQ_ENABLED_AT: '2030-06-01T09:00:00' },
    { ARTZOO_QQ_ENABLED_AT: 'badZ' },
    { ARTZOO_QQ_BRIDGE_SECRET: 'short' },
    { NODE_ENV: 'production', ARTZOO_DEPLOYMENT_ENV: 'production' }
  ])
    assert.equal(loadQqOfficialConfig({ ...env, ...patch }).mode, 'disabled');
  assert.equal(loadQqOfficialConfig(env).target.deliveryMode, 'SIMULATION');
});
test('live requires explicit live gate and refuses mock identities', () => {
  const live = {
    ...env,
    ARTZOO_QQ_MODE: 'live',
    ARTZOO_QQ_APP_ID: 'synthetic_app',
    ARTZOO_QQ_BOT_ID: 'synthetic_bot',
    ARTZOO_QQ_GROUP_OPENID: 'synthetic_group'
  };
  assert.equal(loadQqOfficialConfig(live).mode, 'disabled');
  assert.equal(
    loadQqOfficialConfig({ ...live, ARTZOO_QQ_LIVE_SEND_ENABLED: '1' }).target.deliveryMode,
    'LIVE'
  );
  assert.equal(
    loadQqOfficialConfig({ ...live, ARTZOO_QQ_LIVE_SEND_ENABLED: '1', ARTZOO_QQ_BOT_ID: 'mock_bot' }).mode,
    'disabled'
  );
});
const config = () => loadQqOfficialConfig(env);
const body = () => ({
  app_id: 'mock_app',
  bot_id: 'mock_bot',
  group_openid: 'mock_group',
  simulation: true,
  sender_openid: 'mock_sender',
  event_id: 'event',
  message_idx: 'idx',
  event_timestamp: now.toISOString(),
  content: 'help'
});
test('bridge rejects disabled/future target, wrong app/bot/group and mode', () => {
  for (const patch of [
    { app_id: 'other' },
    { bot_id: 'other' },
    { group_openid: 'other' },
    { simulation: false },
    { simulation: 'true' }
  ])
    denied(() => new QqBridgeService({ now: () => now }, config()).scope({ ...body(), ...patch }));
  for (const c of [
    { ...config(), mode: 'disabled' },
    { ...config(), target: { ...config().target, enabled: false } },
    { ...config(), target: { ...config().target, enabledAt: new Date(now.getTime() + 1) } }
  ])
    denied(() => new QqBridgeService({ now: () => now }, c).scope(body()));
});
test('bridge rejects expired/future/unzoned events and real identity in simulation before DB access', async () => {
  const service = new QqBridgeService(
    {
      now: () => now,
      rate: () => {
        throw Error('unexpected rate');
      }
    },
    config()
  );
  for (const patch of [
    { sender_openid: 'real_sender' },
    { event_timestamp: '2030-06-01T09:54:59Z' },
    { event_timestamp: '2030-06-01T10:01:01Z' },
    { event_timestamp: '2030-06-01T10:00:00' }
  ])
    await assert.rejects(
      () => service.command({ ...body(), ...patch }),
      (e) => e.code === 'FORBIDDEN'
    );
});
test('bridge applies inbound and bot/group/day rate limits', async () => {
  const calls = [],
    auth = {
      now: () => now,
      rate: async (...args) => {
        calls.push(args);
        if (args[0].startsWith('qq-inbound:')) throw Object.assign(Error(), { code: 'RATE_LIMITED' });
      },
      transaction: async (fn) =>
        fn({ $queryRaw: async () => [], qqOfficialDelivery: { findFirst: async () => null } })
    };
  const service = new QqBridgeService(auth, config());
  await assert.rejects(
    () => service.command(body()),
    (e) => e.code === 'RATE_LIMITED'
  );
  assert.deepEqual(calls[0].slice(1), [30, 60]);
  assert.deepEqual(await service.begin({ ...body(), delivery_id: 'synthetic', claim_token: 'synthetic' }), {
    dispatch: false,
    simulation: true
  });
  assert.deepEqual(
    calls.slice(1).map((c) => c.slice(1)),
    [
      [20, 60],
      [10, 60],
      [500, 86400]
    ]
  );
});

test('live directions default closed and can be approved independently without changing the scope', async () => {
  const live = {
    ...env,
    ARTZOO_QQ_MODE: 'live',
    ARTZOO_QQ_LIVE_SEND_ENABLED: '1',
    ARTZOO_QQ_APP_ID: 'synthetic_app',
    ARTZOO_QQ_BOT_ID: 'synthetic_bot',
    ARTZOO_QQ_GROUP_OPENID: 'synthetic_group'
  };
  const closed = loadQqOfficialConfig(live),
    inbound = loadQqOfficialConfig({ ...live, ARTZOO_QQ_PASSIVE_ENABLED: '1' });
  const active = loadQqOfficialConfig({ ...live, ARTZOO_QQ_PROACTIVE_ENABLED: '1' });
  assert.equal(closed.passiveEnabled, false);
  assert.equal(closed.proactiveEnabled, false);
  assert.equal(inbound.passiveEnabled, true);
  assert.equal(inbound.proactiveEnabled, false);
  assert.equal(active.passiveEnabled, false);
  assert.equal(active.proactiveEnabled, true);
  const noDb = {
    now: () => now,
    transaction: () => {
      throw Error('unexpected DB');
    },
    rate: () => {
      throw Error('unexpected rate');
    }
  };
  const b = {
    ...body(),
    app_id: 'synthetic_app',
    bot_id: 'synthetic_bot',
    group_openid: 'synthetic_group',
    simulation: false
  };
  for (const config of [closed, inbound]) {
    const service = new QqBridgeService(noDb, config);
    assert.deepEqual(await service.claim(b), { delivery: null });
    assert.deepEqual(await service.begin(b), { dispatch: false, simulation: false });
  }
  for (const config of [closed, active])
    await assert.rejects(
      () => new QqBridgeService(noDb, config).command(b),
      (e) => e.code === 'FORBIDDEN'
    );
  const { QqBindingService } = await import('../../apps/web/server/qq-official/binding.ts');
  await assert.rejects(
    () => new QqBindingService(noDb, closed).initiate(),
    (e) => e.code === 'FORBIDDEN'
  );
});
test('passive-only live events do not enqueue any proactive storage work', async () => {
  const { enqueueConfiguredQqActivityNotifications } =
    await import('../../packages/db/src/qq-official-notifications.ts');
  const values = {
    ...env,
    ARTZOO_QQ_MODE: 'live',
    ARTZOO_QQ_LIVE_SEND_ENABLED: '1',
    ARTZOO_QQ_PASSIVE_ENABLED: '1',
    ARTZOO_QQ_PROACTIVE_ENABLED: '0',
    ARTZOO_QQ_APP_ID: 'synthetic_app',
    ARTZOO_QQ_BOT_ID: 'synthetic_bot',
    ARTZOO_QQ_GROUP_OPENID: 'synthetic_group'
  };
  const prior = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, values);
    const tx = new Proxy(
      {},
      {
        get() {
          throw Error('unexpected proactive DB work');
        }
      }
    );
    for (const kind of ['PUBLISHED', 'CHANGED', 'CANCELLED', 'REMINDERS'])
      assert.equal(await enqueueConfiguredQqActivityNotifications(tx, 'synthetic-id', kind, now), 0);
  } finally {
    for (const [k, v] of Object.entries(prior))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

test('worker planning never reads HMAC while HTTP capability remains disabled without it', () => {
  const safe = {
    ...env,
    ARTZOO_QQ_MODE: 'live',
    ARTZOO_QQ_LIVE_SEND_ENABLED: '1',
    ARTZOO_QQ_PROACTIVE_ENABLED: '1',
    ARTZOO_QQ_APP_ID: 'synthetic_app',
    ARTZOO_QQ_BOT_ID: 'synthetic_bot',
    ARTZOO_QQ_GROUP_OPENID: 'synthetic_group'
  };
  delete safe.ARTZOO_QQ_BRIDGE_SECRET;
  const plan = loadQqOfficialPlanningConfig(safe);
  assert.equal(plan.target.deliveryMode, 'LIVE');
  assert.equal(plan.proactiveEnabled, true);
  assert.equal('bridgeSecret' in plan, false);
  assert.equal(loadQqOfficialConfig(safe).mode, 'disabled');
  const guarded = new Proxy(safe, {
    get(target, key) {
      if (key === 'ARTZOO_QQ_BRIDGE_SECRET') throw Error('planner read transport credential');
      return target[key];
    }
  });
  assert.equal(loadQqOfficialPlanningConfig(guarded).target.groupOpenId, 'synthetic_group');
  for (const patch of [
    { ARTZOO_QQ_LIVE_SEND_ENABLED: '0' },
    { ARTZOO_QQ_TEST_GROUP_APPROVED: '0' },
    { ARTZOO_QQ_TARGET_KIND: 'PRODUCTION' },
    { ARTZOO_QQ_ENABLED_AT: 'unconfirmed' }
  ])
    assert.equal(loadQqOfficialPlanningConfig({ ...safe, ...patch }).mode, 'disabled');
});
