import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { AccountService, lock } from '../../../apps/web/server/auth/service.ts';
import { mainlandChinaPhone, unavailableSms } from '../../../apps/web/server/auth/ports.ts';
import { tokenDigest } from '../../../apps/web/server/auth/crypto.ts';
import { QqBindingService } from '../../../apps/web/server/qq-official/binding.ts';
import { BotGroupService } from '../../../apps/web/server/bot-management/groups.ts';
import { qqGroupRegistry, resolveQqGroup } from '../../../packages/db/src/qq-groups.ts';

export async function seedBindingHistory(f, scope, now) {
  const activity = await f.db.activity.create({
    data: {
      organizerId: f.ids[0],
      idempotencyKey: randomUUID(),
      requestFingerprint: 'synthetic-history',
      title: 'Synthetic binding history',
      description: 'Existing synthetic history must survive binding changes',
      category: 'SOCIAL',
      startsAt: new Date('2030-05-01T10:00:00Z'),
      endsAt: new Date('2030-05-01T12:00:00Z')
    }
  });
  const registration = await f.db.activityRegistration.create({
    data: {
      activityId: activity.id,
      accountId: f.ids[0],
      status: 'WITHDRAWN',
      exitedAt: now,
      seatSnapshot: { label: 'Synthetic historical seat' }
    }
  });
  const seat = await f.db.activitySeat.create({
    data: { activityId: activity.id, position: 0, kind: 'ANY' }
  });
  await f.db.activityRegistration.create({
    data: { activityId: activity.id, seatId: seat.id, accountId: f.ids[11], status: 'ACTIVE' }
  });
  await f.db.activityOutbox.create({
    data: {
      eventKey: randomUUID(),
      activityId: activity.id,
      registrationId: registration.id,
      kind: 'REGISTRATION_WITHDRAWN',
      channel: 'IN_APP',
      recipientId: f.ids[0],
      payload: { synthetic: true },
      messageReadAt: now
    }
  });
  await f.db.messageNotification.create({
    data: {
      recipientId: f.ids[0],
      actorId: f.ids[11],
      kind: 'SYNTHETIC_HISTORY',
      sourceType: 'ACTIVITY',
      sourceId: activity.id,
      eventKey: randomUUID(),
      readAt: now
    }
  });
  await f.db.qqOfficialDelivery.create({
    data: {
      ...scope,
      eventKey: randomUUID(),
      activityId: activity.id,
      activityRevision: 0,
      kind: 'PUBLISHED',
      dueAt: now,
      expiresAt: new Date(now.getTime() + 60000),
      payload: { synthetic: true },
      status: 'SENT',
      sentAt: now,
      attempts: 1,
      providerMessageId: 'synthetic-preserved-message'
    }
  });
}

export async function managedBindingChecks(f, check) {
  let now = new Date('2031-06-01T10:00:00Z');
  const auth = new AccountService(f.db, {
    phone: mainlandChinaPhone,
    sms: unavailableSms,
    environment: 'test',
    now: () => now
  });
  const scope = {
    appId: 'synthetic_managed_app',
    botId: 'synthetic_managed_bot',
    groupOpenId: 'synthetic_managed_group'
  };
  const group = await f.db.botGroup.create({
    data: {
      ...scope,
      label: 'Synthetic managed group',
      enabled: true,
      enabledAt: new Date(now.getTime() - 60000),
      generation: 1,
      boundAt: now
    }
  });
  const config = {
    mode: 'live',
    passiveEnabled: true,
    proactiveEnabled: true,
    managedGroups: true,
    bridgeSecret: null,
    target: {
      ...scope,
      enabled: true,
      testGroupOnly: false,
      managed: true,
      generation: 1,
      enabledAt: group.enabledAt,
      deliveryMode: 'LIVE'
    }
  };
  const service = new QqBindingService(auth, config),
    manager = new BotGroupService(auth, config),
    accounts = [],
    tokens = [];
  for (let i = 0; i < 4; i++) {
    const a = await f.db.account.create({
      data: {
        phone: 'qq-managed-' + randomUUID(),
        displayName: 'Synthetic managed ' + i,
        passwordHash: 'NONLOGIN-TEST-MARKER',
        membership: 'MEMBER',
        adminRole: i === 0 ? 'SUPER_ADMIN' : 'NONE'
      }
    });
    const token = randomBytes(32).toString('base64url');
    await f.db.accountSession.create({
      data: { accountId: a.id, tokenHash: tokenDigest(token), expiresAt: new Date('2035-01-01T00:00:00Z') }
    });
    accounts.push(a);
    tokens.push(token);
  }
  async function adopt() {
    const registry = await f.db.$transaction((tx) => qqGroupRegistry(tx, config));
    const data = {
      reportedVersion: 0,
      groupRevision: registry.revision,
      groupDigest: registry.digest,
      telemetry: { ready: true },
      observedAt: now,
      applyError: null
    };
    await f.db.botManagementObservation.upsert({
      where: { id: 'qq-official' },
      create: { id: 'qq-official', ...data },
      update: data
    });
  }
  async function refresh() {
    config.target = await f.db.$transaction((tx) => resolveQqGroup(tx, config, scope.groupOpenId, true));
    assert.ok(config.target);
    await adopt();
  }
  async function toggle(enabled) {
    const current = await f.db.botGroup.findUniqueOrThrow({ where: { id: group.id } });
    return manager.command(
      'toggle',
      {
        groupId: group.id,
        generation: current.generation,
        enabled,
        confirmed: true,
        idempotencyKey: randomUUID()
      },
      tokens[0]
    );
  }
  const keyRow = (k) => f.db.qqOfficialBindingKey.findUniqueOrThrow({ where: { id: k.requestId } });
  const forbidden = (fn) => assert.rejects(fn, (e) => e?.code === 'FORBIDDEN');
  await adopt();
  await check('managed adopted enabled group creates protocol2 binding', async () => {
    const key = await service.initiate(tokens[1]);
    await service.bindKey(scope, 'synthetic_managed_member_1', key.key);
    assert.equal(
      (await f.db.qqOfficialBinding.findFirstOrThrow({ where: { accountId: accounts[1].id, ...scope } }))
        .protocolVersion,
      2
    );
  });
  let old;
  await check('managed disable blocks stale initiation and key consumption after adoption', async () => {
    old = await service.initiate(tokens[2]);
    await toggle(false);
    await adopt();
    await forbidden(() => service.initiate(tokens[2]));
    await forbidden(() => service.bindKey(scope, 'synthetic_managed_member_2', old.key));
    assert.equal((await keyRow(old)).consumedAt, null);
    assert.equal(await f.db.qqOfficialBinding.count({ where: { accountId: accounts[2].id } }), 0);
  });
  await check('managed reenable changes anchor rejects old key and accepts fresh key', async () => {
    now = new Date(now.getTime() + 1000);
    await toggle(true);
    await refresh();
    assert.notEqual(config.target.enabledAt.getTime(), (await keyRow(old)).enabledAt.getTime());
    await forbidden(() => service.bindKey(scope, 'synthetic_managed_member_2', old.key));
    const fresh = await service.initiate(tokens[2]);
    await service.bindKey(scope, 'synthetic_managed_member_2', fresh.key);
    assert.ok((await keyRow(fresh)).consumedAt);
    assert.equal((await keyRow(old)).consumedAt, null);
  });
  async function waiters(count) {
    for (let i = 0; i < 150; i++) {
      const [x] = await f.db
        .$queryRaw`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted`;
      if (x.n >= count) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail('expected real management advisory waiters');
  }
  await check(
    'managed bind and real group toggle wait before account locks and settle without deadlock',
    async () => {
      const key = await service.initiate(tokens[0]);
      let release, ready;
      const gate = new Promise((r) => (release = r)),
        locked = new Promise((r) => (ready = r));
      const holder = f.db.$transaction(async (tx) => {
        await lock(tx, 'bot-management:write');
        ready();
        await gate;
        // Both competing operations must still be waiting for management: neither may hold account or group locks.
        await tx.$queryRaw`SELECT "id" FROM "BotGroup" WHERE "id"=${group.id} FOR UPDATE NOWAIT`;
        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${accounts[0].id} FOR UPDATE NOWAIT`;
      });
      await locked;
      let binding, toggling;
      try {
        binding = service.bindKey(scope, 'synthetic_managed_admin', key.key).then(
          () => ({ ok: true }),
          (e) => ({ ok: false, code: e.code })
        );
        toggling = toggle(false).then(
          () => ({ ok: true }),
          (e) => ({ ok: false, code: e.code })
        );
        await waiters(2);
        release();
        await holder;
        const [b, t] = await Promise.all([binding, toggling]);
        assert.equal(t.ok, true);
        if (!b.ok) assert.equal(b.code, 'FORBIDDEN');
        assert.equal((await f.db.botGroup.findUniqueOrThrow({ where: { id: group.id } })).enabled, false);
        const row = await keyRow(key);
        assert.equal(!!row.consumedAt, b.ok);
        assert.equal(
          await f.db.qqOfficialBinding.count({ where: { accountId: accounts[0].id, ...scope } }),
          b.ok ? 1 : 0
        );
      } finally {
        release();
        await holder;
        await Promise.all([binding, toggling].filter(Boolean));
      }
    }
  );
  await check('managed initiation waits before group and account locks', async () => {
    now = new Date(now.getTime() + 1000);
    await toggle(true);
    await refresh();
    let release, ready;
    const gate = new Promise((r) => (release = r)),
      locked = new Promise((r) => (ready = r));
    const holder = f.db.$transaction(async (tx) => {
      await lock(tx, 'bot-management:write');
      ready();
      await gate;
      await tx.$queryRaw`SELECT "id" FROM "BotGroup" WHERE "id"=${group.id} FOR UPDATE NOWAIT`;
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${accounts[3].id} FOR UPDATE NOWAIT`;
    });
    await locked;
    let pending;
    try {
      pending = service.initiate(tokens[3]).then(
        (k) => ({ ok: true, k }),
        (e) => ({ ok: false, code: e.code })
      );
      await waiters(1);
      release();
      await holder;
      assert.equal((await pending).ok, true);
    } finally {
      release();
      await holder;
      if (pending) await pending;
    }
  });
}
