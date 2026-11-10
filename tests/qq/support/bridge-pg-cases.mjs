import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dutyPresetSeats } from '../../../packages/domain/src/index.ts';
import { QqBridgeService } from '../../../apps/web/server/qq-official/bridge.ts';
import { QQ_SIGNUP_PLUGIN_VERSION } from '../../../apps/web/server/qq-official/signup-code.ts';
import {
  enqueueQqActivityNotifications,
  recoverQqDeliveryLeases
} from '../../../packages/db/src/qq-official-notifications.ts';
export async function bridgePostgresCases({ f, auth, service, check, token, fresh }) {
  const db = f.db,
    now = auth.now(),
    reject = (fn, code = 'FORBIDDEN') => assert.rejects(fn, (e) => e.code === code);
  function setup(mode = 'simulation') {
    const prefix = mode === 'simulation' ? 'mock_' : 'synthetic_';
    const target = {
      appId: prefix + randomUUID(),
      botId: prefix + 'bot',
      groupOpenId: prefix + 'group',
      enabled: true,
      testGroupOnly: true,
      enabledAt: new Date(now.getTime() - 1000),
      deliveryMode: mode === 'simulation' ? 'SIMULATION' : 'LIVE'
    };
    const config = {
      mode,
      target,
      bridgeSecret: 'synthetic-bridge-secret-test-only-0000',
      passiveEnabled: true,
      proactiveEnabled: true
    };
    const bridge = new QqBridgeService(auth, config);
    const body = {
      app_id: target.appId,
      bot_id: target.botId,
      group_openid: target.groupOpenId,
      simulation: mode === 'simulation'
    };
    return { target, bridge, body };
  }
  const command = (s, patch = {}) => ({
    ...s.body,
    sender_openid: 'mock_unbound',
    event_id: randomUUID(),
    message_idx: 'synthetic-idx',
    event_timestamp: now.toISOString(),
    content: 'help',
    ...patch
  });
  async function delivery(mode = 'simulation') {
    const s = setup(mode);
    // 现行产品要求：正式模式下，插件最近 2 分钟内上报"已就绪"才会领取投递。
    if (mode === 'live') {
      const telemetry = {
        ready: true,
        plugin_version: QQ_SIGNUP_PLUGIN_VERSION,
        proactive_paused: false,
        passive_paused: false
      };
      await db.botManagementObservation.upsert({
        where: { id: 'qq-official' },
        create: { id: 'qq-official', reportedVersion: 0, telemetry, observedAt: now },
        update: { telemetry, observedAt: now, applyError: null }
      });
    }
    const activity = (
      await service.create(
        fresh({ startsAt: '2030-06-01T22:00:00+08:00', endsAt: '2030-06-02T00:00:00+08:00' }),
        token(0)
      )
    ).activity;
    const row = await db.activity.findUniqueOrThrow({ where: { id: activity.id } });
    await db.$transaction((tx) => enqueueQqActivityNotifications(tx, row, 'PUBLISHED', s.target, now));
    const c = await s.bridge.claim(s.body);
    assert.ok(c.delivery);
    const identity = { ...s.body, delivery_id: c.delivery.delivery_id, claim_token: c.delivery.claim_token };
    assert.deepEqual(await s.bridge.begin(identity), { dispatch: true, simulation: mode === 'simulation' });
    return { ...s, identity, activity };
  }
  await check('bridge nonce concurrent replay commits one digest and rejects other requests', async () => {
    const s = setup(),
      nonce = 'synthetic-nonce-' + randomUUID(),
      results = await Promise.allSettled(
        Array.from({ length: 5 }, () => s.bridge.consumeNonce(nonce, new Date(now.getTime() + 120000)))
      );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'FORBIDDEN'));
    const { tokenDigest } = await import('../../../apps/web/server/auth/crypto.ts');
    assert.equal(await db.qqOfficialNonce.count({ where: { nonceHash: tokenDigest(nonce) } }), 1);
  });
  await check(
    'bridge concurrent inbound replay returns one result and conflicting fingerprint is rejected',
    async () => {
      const s = setup(),
        b = command(s),
        results = await Promise.all(Array.from({ length: 4 }, () => s.bridge.command(b)));
      assert.ok(results.every((r) => r.message === results[0].message));
      assert.equal(await db.qqOfficialInbound.count({ where: { appId: s.target.appId } }), 1);
      await reject(() => s.bridge.command({ ...b, content: '报名 H1 白魔' }));
      await reject(() => s.bridge.command({ ...b, sender_openid: 'mock_other' }));
      assert.equal(await db.qqOfficialInbound.count({ where: { appId: s.target.appId } }), 1);
    }
  );
  await check(
    'bridge missing or cross-scope references cannot register and arbitrary accountId has no authority',
    async () => {
      const s = setup(),
        activity = (await service.create(fresh(), token(0))).activity;
      const ref = randomUUID();
      await db.qqOfficialMessage.create({
        data: {
          appId: s.target.appId,
          botId: 'other-bot',
          groupOpenId: s.target.groupOpenId,
          refIdx: ref,
          deliveryId: randomUUID(),
          activityId: activity.id,
          simulated: true
        }
      });
      for (const patch of [{}, { ref_idx: 'missing' }, { ref_idx: ref }]) {
        const result = await s.bridge.command(
          command(s, { content: '报名 H1 白魔', accountId: f.ids[1], ...patch })
        );
        assert.ok(!result.message.startsWith('报名成功'));
      }
      for (const patch of [
        { groupOpenId: 'wrong-group', simulated: true },
        { simulated: false },
        { simulated: true }
      ]) {
        const reference = randomUUID();
        await db.qqOfficialMessage.create({
          data: {
            appId: s.target.appId,
            botId: s.target.botId,
            groupOpenId: s.target.groupOpenId,
            ...patch,
            refIdx: reference,
            deliveryId: randomUUID(),
            activityId: activity.id
          }
        });
        const result = await s.bridge.command(
          command(s, { content: '报名 H1 白魔', ref_idx: reference, accountId: f.ids[1] })
        );
        assert.ok(!result.message.startsWith('报名成功'));
      }
      assert.equal(await db.activityRegistration.count({ where: { activityId: activity.id } }), 0);
    }
  );
  await check('bridge simulation sent receipt cannot mark sent or establish activity mapping', async () => {
    const s = await delivery(),
      result = await s.bridge.ack({
        ...s.identity,
        outcome: 'sent',
        message_id: 'synthetic-message',
        ref_idx: 'synthetic-ref'
      });
    assert.equal(result.accepted, true);
    const row = await db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: s.identity.delivery_id } });
    assert.equal(row.status, 'UNKNOWN');
    assert.equal(row.sentAt, null);
    assert.equal(row.providerMessageId, null);
    assert.equal(await db.qqOfficialMessage.count({ where: { deliveryId: row.id } }), 0);
    assert.equal((await s.bridge.claim(s.body)).delivery, null);
  });
  await check('bridge simulation completion remains simulated with no live message mapping', async () => {
    const s = await delivery();
    assert.equal((await s.bridge.ack({ ...s.identity, outcome: 'simulated' })).accepted, true);
    const row = await db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: s.identity.delivery_id } });
    assert.equal(row.status, 'SIMULATED');
    assert.equal(row.sentAt, null);
    assert.equal(await db.qqOfficialMessage.count({ where: { deliveryId: row.id } }), 0);
  });
  await check(
    'bridge live refuses simulated outcome and permission/unknown failures are terminal',
    async () => {
      for (const outcome of ['simulated', 'permission_denied', 'unknown', 'generic_failure']) {
        const s = await delivery('live');
        assert.equal((await s.bridge.ack({ ...s.identity, outcome })).accepted, true);
        const row = await db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: s.identity.delivery_id } });
        assert.equal(row.status, outcome === 'permission_denied' ? 'DENIED' : 'UNKNOWN');
        assert.equal(await db.qqOfficialMessage.count({ where: { deliveryId: row.id } }), 0);
        assert.equal((await s.bridge.claim(s.body)).delivery, null);
      }
    }
  );
  await check(
    'bridge live confirmed receipt maps once and stale/mismatched tokens cannot overwrite it',
    async () => {
      const s = await delivery('live');
      assert.equal(
        (
          await s.bridge.ack({
            ...s.identity,
            claim_token: 'forged-token',
            outcome: 'sent',
            message_id: 'forged',
            ref_idx: 'forged-ref'
          })
        ).accepted,
        false
      );
      const receipt = {
        ...s.identity,
        outcome: 'sent',
        message_id: 'synthetic-confirmed',
        ref_idx: 'synthetic-reference'
      };
      assert.equal((await s.bridge.ack(receipt)).accepted, true);
      assert.equal((await s.bridge.ack(receipt)).accepted, true);
      assert.equal((await s.bridge.ack({ ...receipt, message_id: 'changed' })).accepted, false);
      const mapping = await db.qqOfficialMessage.findMany({ where: { deliveryId: s.identity.delivery_id } });
      assert.equal(mapping.length, 1);
      assert.equal(mapping[0].simulated, false);
      assert.equal(mapping[0].refIdx, 'synthetic-reference');
    }
  );
  await check('bridge stale postdispatch ack after lease recovery cannot create a mapping', async () => {
    const s = await delivery('live');
    await db.$transaction((tx) => recoverQqDeliveryLeases(tx, new Date(now.getTime() + 31000)));
    assert.equal(
      (
        await s.bridge.ack({
          ...s.identity,
          outcome: 'sent',
          message_id: 'too-late',
          ref_idx: 'too-late-ref'
        })
      ).accepted,
      false
    );
    assert.equal(await db.qqOfficialMessage.count({ where: { deliveryId: s.identity.delivery_id } }), 0);
  });
  await check('bridge inbound rate limit denies request 31 before storing an event', async () => {
    const s = setup();
    for (let i = 0; i < 30; i++) await s.bridge.command(command(s));
    await reject(() => s.bridge.command(command(s)), 'RATE_LIMITED');
    assert.equal(await db.qqOfficialInbound.count({ where: { appId: s.target.appId } }), 30);
  });
  await check(
    'bridge concurrent duplicate signup event creates one registration and one organizer event',
    async () => {
      const s = setup(),
        activity = (
          await service.create(
            fresh({
              dutySelection: { type: 'OTHER', name: 'Synthetic full party', partyComposition: 'FULL' },
              seats: dutyPresetSeats('FULL').map((s) => s.requirement)
            }),
            token(0)
          )
        ).activity,
        ref = randomUUID(),
        member = 'mock_duplicate_signup';
      await db.qqOfficialBinding.create({
        data: {
          appId: s.target.appId,
          botId: s.target.botId,
          groupOpenId: s.target.groupOpenId,
          accountId: f.ids[17],
          memberOpenId: member,
          confirmedAt: now
        }
      });
      await db.qqOfficialMessage.create({
        data: {
          appId: s.target.appId,
          botId: s.target.botId,
          groupOpenId: s.target.groupOpenId,
          refIdx: ref,
          deliveryId: randomUUID(),
          activityId: activity.id,
          simulated: true
        }
      });
      const b = command(s, {
        sender_openid: member,
        ref_idx: ref,
        content: '报名 H1 白魔',
        accountId: f.ids[18]
      });
      const results = await Promise.all(Array.from({ length: 4 }, () => s.bridge.command(b)));
      assert.ok(
        results.every((r) => r.message.startsWith('报名成功')),
        JSON.stringify(results)
      );
      const registrations = await db.activityRegistration.findMany({ where: { activityId: activity.id } });
      assert.equal(registrations.length, 1);
      assert.equal(registrations[0].accountId, f.ids[17]);
      assert.equal(
        await db.activityOutbox.count({ where: { activityId: activity.id, kind: 'REGISTRATION_CREATED' } }),
        1
      );
      assert.equal(await db.qqOfficialInbound.count({ where: { appId: s.target.appId } }), 1);
    }
  );
}
