import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fixture } from '../activities/support/pg-fixture.mjs';
test('机器人管理：配置发布、权限与运行状态（数据库）', async (t) => {
  const f = await fixture({ accounts: 20 });
  try {
    const { AccountService } = await import('../../apps/web/server/auth/service.ts');
    const { mainlandChinaPhone, unavailableSms } = await import('../../apps/web/server/auth/ports.ts');
    const { BotManagementService, BotManagementBridge } =
      await import('../../apps/web/server/bot-management/service.ts');
    const { QqBridgeService } = await import('../../apps/web/server/qq-official/bridge.ts');
    const { botDefaults, botCanonical } = await import('../../packages/domain/src/index.ts');
    const { botDispatchAllowed, botRuntimeReady } = await import('../../packages/db/src/bot-management.ts');
    let now = new Date('2030-06-01T10:00:00Z');
    const auth = new AccountService(f.db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      environment: 'test',
      now: () => now
    });
    await f.db.account.update({ where: { id: f.ids[0] }, data: { adminRole: 'SUPER_ADMIN' } });
    await f.db.account.update({ where: { id: f.ids[1] }, data: { adminRole: 'ADMIN' } });
    const scope = { appId: 'mock_app', botId: 'mock_bot', groupOpenId: 'mock_group' },
      config = {
        mode: 'simulation',
        passiveEnabled: true,
        proactiveEnabled: true,
        bridgeSecret: 'synthetic-test-only-not-transported-0000',
        target: {
          ...scope,
          enabled: true,
          testGroupOnly: true,
          enabledAt: new Date('2030-06-01T09:00:00Z'),
          deliveryMode: 'SIMULATION'
        }
      },
      service = new BotManagementService(auth, config),
      bridge = new BotManagementBridge(auth, config),
      qq = new QqBridgeService(auth, config),
      token = f.tokens[0];
    const check = (n, fn) => t.test(n, fn);
    const templatePart = (content) => content.split('\n\n活动编号：')[0];
    const signupFooter = /\n\n活动编号：[A-Z0-9]{8}\n报名示例：/;
    const reject = (fn, code) => assert.rejects(fn, (e) => e.code === code);
    const body = (r, v, x = {}) => ({
      expectedRevision: r,
      expectedVersion: v,
      idempotencyKey: randomUUID(),
      ...x
    });
    const telemetry = {
      ready: true,
      plugin_version: '0.2.0',
      proactive_paused: false,
      passive_paused: false,
      minute_proactive: 0,
      minute_group: 0,
      rolling_proactive: 0,
      reply_outcomes: { sent: 0, unknown: 0, permission_denied: 0, simulated: 0 },
      recent: []
    };
    const wire = {
      app_id: scope.appId,
      bot_id: scope.botId,
      group_openid: scope.groupOpenId,
      simulation: true
    };
    let cfg = botDefaults(),
      version = 0,
      revision = 0,
      pub;
    async function publish(c) {
      const d = await service.command('draft', body(revision, version, { config: c }), token);
      revision = d.draftRevision;
      const r = await service.command('publish', body(revision, version), token);
      version = r.publishedVersion;
      return r;
    }
    async function sync(extra = {}) {
      return bridge.sync({
        ...wire,
        protocol: 1,
        applied_version: version,
        applied_digest: pub?.digest ?? null,
        apply_error: null,
        telemetry,
        ...extra
      });
    }
    await check('all reads, preview and writes reject ordinary admin, member, anonymous', async () => {
      for (const t of [f.tokens[1], f.tokens[2], null]) {
        const code = t ? 'FORBIDDEN' : 'UNAUTHENTICATED';
        await reject(() => service.snapshot(t), code);
        await reject(() => service.settings(t), code);
        await reject(() => service.preview({ config: cfg, kind: 'PUBLISHED' }, t), code);
        for (const action of ['draft', 'publish', 'test', 'save'])
          await reject(() => service.command(action, body(0, 0, { config: cfg }), t), code);
      }
      assert.equal(await f.db.botManagementAudit.count(), 0);
    });
    await check('overview is read-only and default config is not published', async () => {
      const s = await service.snapshot(token);
      assert.equal(s.publicationStatus, 'UNPUBLISHED');
      assert.equal(await f.db.botManagementState.count(), 0);
    });
    await check('preview cannot save, enqueue, create invitation or mutate binding', async () => {
      const r = await service.preview({ config: cfg, kind: 'SIGNUP_FAILURE' }, token);
      assert.equal(r.simulation, true);
      assert.match(r.text, /报名失败/);
      for (const table of [
        'botManagementState',
        'botManagementAudit',
        'botManagementTest',
        'qqOfficialDelivery',
        'qqOfficialInbound',
        'qqOfficialBinding',
        'invitation'
      ])
        assert.equal(await f.db[table].count(), 0);
    });
    await check('invalid config and unexpected credentials fields rejected', async () => {
      await reject(
        () => service.command('draft', body(0, 0, { config: { ...cfg, secret: 'blocked' } }), token),
        'VALIDATION_ERROR'
      );
      await reject(
        () => service.command('draft', body(0, 0, { config: cfg, secret: 'blocked' }), token),
        'VALIDATION_ERROR'
      );
      assert.equal(await f.db.botManagementAudit.count(), 0);
    });
    await check(
      'draft alone does not alter effective policy; idempotent retry and conflict safe',
      async () => {
        const b = body(0, 0, { config: cfg });
        const r = await service.command('draft', b, token);
        revision = r.draftRevision;
        assert.equal((await service.command('draft', b, token)).replayed, true);
        await reject(
          () => service.command('draft', { ...b, config: { ...cfg, proactivePaused: true } }, token),
          'CONFLICT'
        );
        assert.equal(await f.db.botManagementPublication.count(), 0);
        assert.equal(await f.db.$transaction((tx) => botRuntimeReady(tx, scope, now)), true);
      }
    );
    await check('concurrent first publish commits exactly once without claiming old work', async () => {
      const prefix = 'initial-legacy-' + randomUUID();
      const legacyIds = [];
      // 投递表对活动有外键，先建一条合成活动作为这些旧投递的归属。
      await f.db.activity.create({
        data: {
          id: 'initial-synthetic',
          organizerId: f.ids[2],
          idempotencyKey: randomUUID(),
          requestFingerprint: 'synthetic',
          title: '合成旧投递活动',
          description: '合成旧投递活动',
          category: 'DUNGEON',
          startsAt: new Date(now.getTime() + 86400000),
          endsAt: new Date(now.getTime() + 90000000)
        }
      });
      for (const [kind, status, attempts, dueAt] of [
        ['REMINDER_2H', 'PENDING', 0, now],
        ['REMINDER_1H', 'CLAIMED', 1, new Date(now.getTime() + 60000)]
      ]) {
        const row = await f.db.qqOfficialDelivery.create({
          data: {
            eventKey: prefix + kind,
            ...scope,
            activityId: 'initial-synthetic',
            activityRevision: 1,
            kind,
            status,
            attempts,
            deliveryMode: 'SIMULATION',
            dueAt,
            expiresAt: new Date(now.getTime() + 120000),
            payload: { activityId: 'initial-synthetic' },
            createdAt: now
          }
        });
        legacyIds.push(row.id);
      }
      const b = body(revision, version);
      const r = await Promise.allSettled([
        service.command('publish', b, token),
        service.command('publish', body(revision, version), token)
      ]);
      assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
      const initial = await f.db.qqOfficialDelivery.findMany({
        where: { id: { in: legacyIds } },
        orderBy: { kind: 'asc' }
      });
      assert.deepEqual(
        initial.map((x) => x.status),
        ['CLAIMED', 'PENDING']
      );
      assert.ok(initial.find((x) => x.kind === 'REMINDER_2H').payload.reminder);
      await f.db.qqOfficialDelivery.deleteMany({ where: { id: { in: legacyIds } } });
      version = 1;
      pub = await f.db.botManagementPublication.findUniqueOrThrow({ where: { version } });
      assert.equal((await service.snapshot(token)).publicationStatus, 'PENDING');
      assert.equal(await f.db.$transaction((tx) => botRuntimeReady(tx, scope, now)), false);
    });
    await check(
      'config digest matches sorted canonical and first sync returns immutable publication',
      async () => {
        const r = await bridge.sync({
          ...wire,
          protocol: 1,
          applied_version: 0,
          applied_digest: null,
          apply_error: null,
          telemetry
        });
        assert.equal(r.publication.version, 1);
        assert.equal(r.publication.digest, createHash('sha256').update(botCanonical(cfg)).digest('hex'));
        assert.equal((await service.snapshot(token)).publicationStatus, 'PENDING');
      }
    );
    await check('ACK exact version+digest enables policy; mismatched digest never says applied', async () => {
      await sync({ applied_digest: 'a'.repeat(64) });
      assert.equal((await service.snapshot(token)).publicationStatus, 'PENDING');
      assert.equal(await f.db.$transaction((tx) => botRuntimeReady(tx, scope, now)), false);
      await sync();
      assert.equal((await service.snapshot(token)).publicationStatus, 'APPLIED');
      assert.equal(await f.db.$transaction((tx) => botDispatchAllowed(tx, scope, 'PUBLISHED', now)), true);
    });
    await check(
      'matching ACK omits unchanged config but reports real adoption; repair and stale versions resend',
      async () => {
        const full = await sync({ applied_version: 0, applied_digest: null });
        assert.equal(full.publication.version, version);
        const same = await sync();
        assert.equal(same.publication, null);
        assert.equal((await service.settings(token)).publicationStatus, 'APPLIED');
        const bytes = Buffer.byteLength(JSON.stringify(full.publication));
        assert.ok(bytes > 4);
        console.log('METRIC BOT unchanged-publication ' + bytes + ' -> 4 raw-json-bytes');
        for (const apply_error of ['APPLY_FAILED', 'INVALID_CONFIG']) {
          const repaired = await sync({ apply_error });
          assert.equal(repaired.publication.digest, pub.digest);
        }
        assert.equal((await sync({ applied_digest: 'a'.repeat(64) })).publication.digest, pub.digest);
        assert.equal(
          (await sync({ applied_version: 0, applied_digest: null })).publication.digest,
          pub.digest
        );
        await sync();
      }
    );
    await check('apply failure and stale heartbeat stay visible and fail closed', async () => {
      await sync({ apply_error: 'APPLY_FAILED' });
      assert.equal((await service.snapshot(token)).publicationStatus, 'FAILED');
      assert.equal(await f.db.$transaction((tx) => botRuntimeReady(tx, scope, now)), false);
      await sync();
      now = new Date(now.getTime() + 121000);
      assert.equal((await service.snapshot(token)).publicationStatus, 'STALE');
      assert.equal(await f.db.$transaction((tx) => botRuntimeReady(tx, scope, now)), false);
      await sync();
    });
    await check('signed scope gate rejects wrong group, mode and future epochs', async () => {
      assert.throws(() => qq.scope({ ...wire, group_openid: 'other' }));
      assert.throws(() => qq.scope({ ...wire, simulation: false }));
      await reject(() => sync({ applied_version: version + 1 }), 'VALIDATION_ERROR');
      await reject(() => sync({ telemetry: { ...telemetry, secret: 'blocked' } }), 'VALIDATION_ERROR');
    });
    await check('unchanged publish does not bump version or reset epoch', async () => {
      const r = await service.command('publish', body(revision, version), token);
      assert.equal(r.unchanged, true);
      assert.equal(r.publishedVersion, 1);
      assert.equal(config.target.enabledAt.toISOString(), '2030-06-01T09:00:00.000Z');
    });
    await check('unknown sender results persist and never promote to a late success', async () => {
      const eventKey = 'b'.repeat(64);
      await sync({
        telemetry: {
          ...telemetry,
          recent: [{ eventKey, direction: 'passive', outcome: 'unknown', time: now.toISOString() }]
        }
      });
      await sync({
        telemetry: {
          ...telemetry,
          recent: [{ eventKey, direction: 'passive', outcome: 'sent', time: now.toISOString() }]
        }
      });
      assert.equal((await service.snapshot(token)).sendRecords[0].outcome, 'unknown');
    });
    await check('publish failure rolls back draft version and audit atomically', async () => {
      const prior = await f.db.botManagementState.findUniqueOrThrow({ where: { id: 'qq-official' } }),
        count = await f.db.botManagementAudit.count(),
        original = auth.transaction.bind(auth);
      auth.transaction = (fn) =>
        original(async (tx) => {
          await fn(tx);
          throw new Error('injected');
        });
      try {
        await assert.rejects(() =>
          service.command(
            'save',
            body(revision, version, { config: { ...cfg, proactivePaused: true } }),
            token
          )
        );
      } finally {
        auth.transaction = original;
      }
      assert.deepEqual(
        await f.db.botManagementState.findUniqueOrThrow({ where: { id: 'qq-official' } }),
        prior
      );
      assert.equal(await f.db.botManagementAudit.count(), count);
    });
    await check(
      'pause and five classes gate both claim and final dispatch; old queues not revived',
      async () => {
        cfg = { ...cfg, proactivePaused: true, notifications: { ...cfg.notifications, CHANGED: false } };
        await publish(cfg);
        pub = await f.db.botManagementPublication.findUniqueOrThrow({ where: { version } });
        await sync();
        assert.equal(await f.db.$transaction((tx) => botRuntimeReady(tx, scope, now)), false);
        assert.equal((await qq.claim(wire)).delivery, null);
        await reject(
          () =>
            service.command('test', body(revision, version, { targetGroupOpenId: scope.groupOpenId }), token),
          'SERVICE_UNAVAILABLE'
        );
        cfg = { ...cfg, proactivePaused: false };
        await publish(cfg);
        pub = await f.db.botManagementPublication.findUniqueOrThrow({ where: { version } });
        await sync();
        assert.equal(await f.db.$transaction((tx) => botDispatchAllowed(tx, scope, 'CHANGED', now)), false);
        assert.equal(await f.db.$transaction((tx) => botDispatchAllowed(tx, scope, 'PUBLISHED', now)), true);
      }
    );
    await check('test requires explicit exact target; no automatic send on save or publish', async () => {
      assert.equal(await f.db.botManagementTest.count(), 0);
      await reject(
        () => service.command('test', body(revision, version, { targetGroupOpenId: 'wrong' }), token),
        'VALIDATION_ERROR'
      );
    });
    await check(
      'explicit test is idempotent, scoped and never makes activity reference mapping',
      async () => {
        const b = body(revision, version, { targetGroupOpenId: scope.groupOpenId });
        const r = await service.command('test', b, token);
        assert.equal((await service.command('test', b, token)).testId, r.testId);
        assert.equal(await f.db.botManagementTest.count(), 1);
        const c = await bridge.test('test-claim', {
          ...wire,
          applied_version: version,
          applied_digest: pub.digest
        });
        assert.ok(c.delivery);
        assert.equal(
          (await bridge.test('test-claim', { ...wire, applied_version: version, applied_digest: pub.digest }))
            .delivery,
          null
        );
        const identity = {
          ...wire,
          delivery_id: c.delivery.delivery_id,
          claim_token: c.delivery.claim_token
        };
        assert.equal((await bridge.test('test-begin', identity)).dispatch, true);
        assert.equal((await bridge.test('test-ack', { ...identity, outcome: 'simulated' })).accepted, true);
        assert.equal((await bridge.test('test-ack', { ...identity, outcome: 'sent' })).terminal, true);
        assert.equal(await f.db.qqOfficialMessage.count(), 0);
      }
    );
    await check('fixed binding edits reject and runtime preserves actual result', async () => {
      const changed = structuredClone(cfg);
      changed.templates.BINDING = 'changed|{result}';
      await reject(
        () => service.command('save', body(revision, version, { config: changed }), token),
        'VALIDATION_ERROR'
      );
      const r = await qq.command({
        ...wire,
        event_id: randomUUID(),
        message_idx: 'mock_idx',
        event_timestamp: now.toISOString(),
        sender_openid: 'mock_member',
        content: '\u7ed1\u5b9a InvalidCode123456'
      });
      assert.ok(r.message);
      assert.ok(!r.message.startsWith('changed|'));
      assert.ok(!JSON.stringify(await service.snapshot(token)).includes('InvalidCode123456'));
    });
    await check('role revoked during write cannot commit configuration', async () => {
      const r = await f.db.account.findUniqueOrThrow({ where: { id: f.ids[0] } });
      await f.db.account.update({
        where: { id: r.id },
        data: { adminRole: 'ADMIN', adminRoleRevision: { increment: 1 } }
      });
      await reject(
        () => service.command('draft', body(revision, version, { config: cfg }), token),
        'FORBIDDEN'
      );
      await f.db.account.update({
        where: { id: r.id },
        data: { adminRole: 'SUPER_ADMIN', adminRoleRevision: { increment: 1 } }
      });
    });

    await check(
      'website active direction gate blocks test queue and dispatch even with plugin ready',
      async () => {
        const off = new BotManagementService(auth, { ...config, mode: 'live', proactiveEnabled: false }),
          offBridge = new BotManagementBridge(auth, { ...config, mode: 'live', proactiveEnabled: false });
        await reject(
          () => off.command('test', body(revision, version, { targetGroupOpenId: scope.groupOpenId }), token),
          'SERVICE_UNAVAILABLE'
        );
        assert.equal(
          (
            await offBridge.test('test-claim', {
              ...wire,
              simulation: false,
              applied_version: version,
              applied_digest: pub.digest
            })
          ).delivery,
          null
        );
      }
    );
    await check('wrong simulation mode and missing sent receipt never establish success', async () => {
      await reject(
        () =>
          bridge.test('test-claim', {
            ...wire,
            simulation: false,
            applied_version: version,
            applied_digest: pub.digest
          }),
        'VALIDATION_ERROR'
      );
      await reject(
        () =>
          bridge.test('test-claim', {
            ...wire,
            applied_version: version,
            applied_digest: pub.digest,
            secret: 'blocked'
          }),
        'VALIDATION_ERROR'
      );
    });
    await check(
      'planning gate serializes publication after in-flight enqueue without lock inversion',
      async () => {
        const { ActivityService } = await import('../../apps/web/server/activities/service.ts'),
          { input } = await import('../activities/support/activity-input.mjs'),
          { enqueueQqActivityNotifications } =
            await import('../../packages/db/src/qq-official-notifications.ts');
        const a = (
            await new ActivityService(auth).create(
              input({
                idempotencyKey: randomUUID(),
                startsAt: '2030-06-01T22:00:00+08:00',
                endsAt: '2030-06-02T00:00:00+08:00'
              }),
              token
            )
          ).activity,
          row = await f.db.activity.findUniqueOrThrow({ where: { id: a.id } });
        let arrive, release;
        const arrived = new Promise((r) => (arrive = r)),
          released = new Promise((r) => (release = r));
        let held = false;
        const enqueue = f.db.$transaction(async (tx) => {
          const proxy = new Proxy(tx, {
            get(target, key) {
              if (key === '$executeRawUnsafe')
                return async (...args) => {
                  if (!held && args[0].startsWith('INSERT INTO "QqOfficialDelivery"')) {
                    held = true;
                    arrive();
                    await released;
                  }
                  return target.$executeRawUnsafe(...args);
                };
              const v = target[key];
              return typeof v === 'function' ? v.bind(target) : v;
            }
          });
          return enqueueQqActivityNotifications(proxy, row, 'PUBLISHED', config.target, now);
        });
        await arrived;
        cfg = { ...cfg, proactivePaused: true };
        const publishing = publish(cfg);
        release();
        await enqueue;
        await publishing;
        pub = await f.db.botManagementPublication.findUniqueOrThrow({ where: { version } });
        await sync();
        const old = await f.db.qqOfficialDelivery.findMany({ where: { activityId: a.id } });
        assert.ok(old.length >= 2);
        assert.ok(old.every((r) => r.status === 'CANCELLED'));
        assert.equal((await qq.claim(wire)).delivery, null);
        cfg = { ...cfg, proactivePaused: false };
        await publish(cfg);
        pub = await f.db.botManagementPublication.findUniqueOrThrow({ where: { version } });
        await sync();
      }
    );
    await check(
      'first-claim text remains frozen after template-only publish and lease re-claim',
      async () => {
        cfg.templates.PUBLISHED = '{副本名称}|{人数信息}|{报名情况}|{活动地点}';
        await publish(cfg);
        pub = await f.db.botManagementPublication.findUniqueOrThrow({ where: { version } });
        await sync();
        const { ActivityService } = await import('../../apps/web/server/activities/service.ts'),
          { input } = await import('../activities/support/activity-input.mjs'),
          { enqueueQqActivityNotifications } =
            await import('../../packages/db/src/qq-official-notifications.ts');
        const a = (
            await new ActivityService(auth).create(
              input({
                idempotencyKey: randomUUID(),
                startsAt: '2030-06-01T23:00:00+08:00',
                endsAt: '2030-06-02T01:00:00+08:00',
                dutySelection: { type: 'OTHER', name: '变量核对副本', partyComposition: 'FULL' },
                seats: (await import('../../packages/domain/src/index.ts'))
                  .dutyPresetSeats('FULL')
                  .map((x) => x.requirement)
              }),
              token
            )
          ).activity,
          row = await f.db.activity.findUniqueOrThrow({ where: { id: a.id } });
        await f.db.$transaction((tx) =>
          enqueueQqActivityNotifications(tx, row, 'PUBLISHED', config.target, now)
        );
        const first = await qq.claim(wire);
        assert.ok(first.delivery);
        // 现行产品会在模板正文后追加"活动编号 / 报名示例"，这里分开核对两部分。
        assert.equal(templatePart(first.delivery.content), '变量核对副本|8|0/8|');
        assert.match(first.delivery.content, signupFooter);
        const epoch = pub.notificationEpoch;
        cfg.templates.PUBLISHED = '新的展示：{event}\n{title}\n{time}';
        await publish(cfg);
        pub = await f.db.botManagementPublication.findUniqueOrThrow({ where: { version } });
        assert.equal(pub.notificationEpoch, epoch);
        await sync();
        now = new Date(now.getTime() + 31000);
        await sync();
        const second = await qq.claim(wire);
        assert.ok(second.delivery);
        assert.equal(second.delivery.delivery_id, first.delivery.delivery_id);
        assert.equal(second.delivery.content, first.delivery.content);
      }
    );

    await check('test sent without a complete distinct native receipt becomes UNKNOWN', async () => {
      now = new Date(now.getTime() + 61000);
      await sync();
      const r = await service.command(
        'test',
        body(revision, version, { targetGroupOpenId: scope.groupOpenId }),
        token
      );
      const liveBridge = new BotManagementBridge(auth, { ...config, mode: 'live' });
      const w = { ...wire, simulation: false, applied_version: version, applied_digest: pub.digest };
      const c = await liveBridge.test('test-claim', w);
      assert.ok(c.delivery);
      const i = {
        ...wire,
        simulation: false,
        delivery_id: c.delivery.delivery_id,
        claim_token: c.delivery.claim_token
      };
      assert.equal((await liveBridge.test('test-begin', i)).dispatch, true);
      assert.equal((await liveBridge.test('test-ack', { ...i, outcome: 'sent' })).accepted, true);
      assert.equal(
        (await f.db.botManagementTest.findUniqueOrThrow({ where: { id: r.testId } })).status,
        'UNKNOWN'
      );
      assert.equal(await f.db.qqOfficialMessage.count(), 0);
    });
    await check('proactive safety pause report prevents a new explicit test request', async () => {
      await sync({ telemetry: { ...telemetry, proactive_paused: true } });
      await reject(
        () =>
          service.command('test', body(revision, version, { targetGroupOpenId: scope.groupOpenId }), token),
        'SERVICE_UNAVAILABLE'
      );
      await sync();
    });

    await check('single save publishes atomically, replays once and never claims adoption', async () => {
      cfg.parameters.proactivePerMinute = 4;
      const b = body(revision, version, { config: cfg }),
        beforeAudit = await f.db.botManagementAudit.count();
      const saved = await service.command('save', b, token);
      revision = saved.draftRevision;
      version = saved.publishedVersion;
      assert.equal((await service.command('save', b, token)).replayed, true);
      assert.equal(await f.db.botManagementAudit.count(), beforeAudit + 1);
      const s = await service.settings(token);
      assert.equal(s.publishedVersion, version);
      assert.equal(s.publicationStatus, 'PENDING');
      assert.equal(s.draft.parameters.proactivePerMinute, 4);
      assert.equal(Object.hasOwn(s, 'audits'), false);
      assert.equal(Object.hasOwn(s, 'telemetry'), false);
      pub = await f.db.botManagementPublication.findUniqueOrThrow({ where: { version } });
      await sync();
      assert.equal((await service.settings(token)).publicationStatus, 'APPLIED');
      await reject(
        () => service.command('save', { ...b, config: { ...cfg, proactivePaused: true } }, token),
        'CONFLICT'
      );
    });

    const { botConfigForEditing, dutyPresetSeats } = await import('../../packages/domain/src/index.ts');
    const { ActivityService } = await import('../../apps/web/server/activities/service.ts'),
      { input } = await import('../activities/support/activity-input.mjs');
    const {
      loadQqActivitySnapshot,
      planQqActivityNotifications,
      storeQqReminderPlan,
      reconcileQqReminderPlans
    } = await import('../../packages/db/src/qq-official-notifications.ts');
    let dynamicActivity, minutesKey, initialDue;
    const bj = (value) => new Date(value.getTime() + 8 * 3600000).toISOString().slice(0, 23) + '+08:00';
    async function saveDynamic(next) {
      const result = await service.command('save', body(revision, version, { config: next }), token);
      revision = result.draftRevision;
      version = result.publishedVersion;
      cfg = next;
      pub = await f.db.botManagementPublication.findUniqueOrThrow({ where: { version } });
      await sync();
      return result;
    }
    await check(
      'dynamic save migrates default rows and plans only future schedules with original anchor',
      async () => {
        cfg = botConfigForEditing(cfg);
        cfg.reminders[1].template = '旧提醒|{队伍构成}|{空缺席位}';
        const starts = new Date(now.getTime() + 4 * 3600000),
          ends = new Date(starts.getTime() + 3600000);
        dynamicActivity = (
          await new ActivityService(auth).create(
            input({
              idempotencyKey: randomUUID(),
              startsAt: bj(starts),
              endsAt: bj(ends),
              dutySelection: { type: 'OTHER', name: '纯值四人本', partyComposition: 'LIGHT' },
              seats: [
                { kind: 'ANY' },
                { kind: 'JOB', job: '白魔法师' },
                { kind: 'JOB', job: '武僧' },
                { kind: 'ROLE', role: 'DAMAGE' }
              ]
            }),
            token
          )
        ).activity;
        const row = await f.db.activitySeat.findMany({
          where: { activityId: dynamicActivity.id },
          orderBy: { position: 'asc' }
        });
        for (const index of [1, 3])
          await f.db.activityRegistration.create({
            data: {
              activityId: dynamicActivity.id,
              seatId: row[index].id,
              accountId: f.ids[index + 1],
              job: index === 1 ? '白魔法师' : '武僧',
              status: 'ACTIVE'
            }
          });
        await saveDynamic(cfg);
        const plans = await f.db.qqOfficialDelivery.findMany({
          where: { activityId: dynamicActivity.id, kind: 'REMINDER', status: 'PENDING' },
          orderBy: { dueAt: 'asc' }
        });
        assert.equal(plans.length, 2);
        assert.deepEqual(
          plans.map((r) => r.payload.reminder.minutes),
          [120, 60]
        );
        assert.ok(plans.every((r) => r.dueAt > now && r.createdAt >= config.target.enabledAt));
        assert.equal(config.target.enabledAt.toISOString(), '2030-06-01T09:00:00.000Z');
      }
    );
    await check(
      'editing and removing rows update only future unattempted schedules with stable minute identity',
      async () => {
        const reminder = { ...cfg.reminders[1], minutes: 30, template: '原模板|{队伍构成}|{空缺席位}' };
        await saveDynamic({ ...cfg, reminders: [reminder] });
        let rows = await f.db.qqOfficialDelivery.findMany({
          where: { activityId: dynamicActivity.id, kind: 'REMINDER' },
          orderBy: { dueAt: 'asc' }
        });
        assert.equal(rows.filter((r) => r.status === 'PENDING').length, 1);
        assert.ok(
          rows.filter((r) => r.payload.reminder.minutes !== 30).every((r) => r.status === 'CANCELLED')
        );
        const current = rows.find((r) => r.status === 'PENDING');
        minutesKey = current.eventKey;
        initialDue = current.dueAt;
        await saveDynamic({ ...cfg, reminders: [] });
        assert.equal(
          (await f.db.qqOfficialDelivery.findUniqueOrThrow({ where: { eventKey: minutesKey } })).status,
          'CANCELLED'
        );
        await saveDynamic({
          ...cfg,
          reminders: [{ ...reminder, id: 'new-stable-ui-id', template: '新模板|{队伍构成}|{空缺席位}' }]
        });
        const revived = await f.db.qqOfficialDelivery.findUniqueOrThrow({ where: { eventKey: minutesKey } });
        assert.equal(revived.id, current.id);
        assert.equal(revived.status, 'PENDING');
        assert.equal(revived.payload.reminder.id, 'new-stable-ui-id');
        assert.equal(revived.attempts, 0);
      }
    );
    await check(
      'already-due plan keeps original template on deletion and actual team/vacancy pure values',
      async () => {
        now = initialDue;
        await saveDynamic({ ...cfg, reminders: [] });
        const preserved = await f.db.qqOfficialDelivery.findUniqueOrThrow({
          where: { eventKey: minutesKey }
        });
        assert.equal(preserved.status, 'PENDING');
        assert.equal(preserved.payload.reminder.template, '新模板|{队伍构成}|{空缺席位}');
        const claim = await qq.claim(wire);
        assert.ok(claim.delivery);
        assert.equal(claim.delivery.idempotency_key, minutesKey);
        assert.equal(
          templatePart(claim.delivery.content),
          '新模板|T（不限）、H（白魔法师）、D1（武僧）、D2（输出）|T（不限）、D1（武僧）'
        );
        assert.match(claim.delivery.content, signupFooter);
        const identity = {
          ...wire,
          delivery_id: claim.delivery.delivery_id,
          claim_token: claim.delivery.claim_token
        };
        assert.equal((await qq.begin(identity)).dispatch, true);
        assert.equal((await qq.ack({ ...identity, outcome: 'simulated' })).accepted, true);
        assert.equal(await f.db.qqOfficialMessage.count(), 0);
      }
    );
    await check(
      'no replay after expiry or deletion/re-add, no new delivery for historical or second series period',
      async () => {
        now = new Date(initialDue.getTime() + 61000);
        const reminder = { id: 'same-time-new-id', minutes: 30, enabled: true, template: '不能补发' };
        await saveDynamic({ ...cfg, reminders: [reminder] });
        assert.equal(
          (await f.db.qqOfficialDelivery.findUniqueOrThrow({ where: { eventKey: minutesKey } })).status,
          'SIMULATED'
        );
        assert.equal((await qq.claim(wire)).delivery, null);
        const snapshot = await f.db.$transaction((tx) => loadQqActivitySnapshot(tx, dynamicActivity.id));
        assert.equal(
          planQqActivityNotifications(snapshot, 'REMINDERS', config.target, now, [reminder]).length,
          0
        );
      }
    );
    await check(
      'CLAIMED and UNKNOWN attempts cannot be revived or retemplated by config changes',
      async () => {
        const starts = new Date(now.getTime() + 4 * 3600000),
          ends = new Date(starts.getTime() + 3600000);
        const a = (
          await new ActivityService(auth).create(
            input({ idempotencyKey: randomUUID(), startsAt: bj(starts), endsAt: bj(ends) }),
            token
          )
        ).activity;
        const snapshot = await f.db.$transaction((tx) => loadQqActivitySnapshot(tx, a.id)),
          rules = [
            { id: 'r60', minutes: 60, enabled: true, template: '原值' },
            { id: 'r30', minutes: 30, enabled: true, template: '原值' }
          ];
        const plans = planQqActivityNotifications(snapshot, 'REMINDERS', config.target, now, rules);
        for (const [i, plan] of plans.entries()) {
          await f.db.$transaction((tx) => storeQqReminderPlan(tx, plan, now, pub.notificationEpoch));
          await f.db.qqOfficialDelivery.update({
            where: { eventKey: plan.eventKey },
            data: { attempts: 1, status: i ? 'UNKNOWN' : 'CLAIMED', renderedContent: '已冻结' }
          });
        }
        await saveDynamic({ ...cfg, reminders: rules.map((r) => ({ ...r, template: '不应覆盖' })) });
        for (const plan of plans) {
          const row = await f.db.qqOfficialDelivery.findUniqueOrThrow({ where: { eventKey: plan.eventKey } });
          assert.equal(row.renderedContent, '已冻结');
          assert.equal(row.payload.reminder.template, '原值');
          assert.equal(row.attempts, 1);
        }
      }
    );
    await check(
      'legacy attempted minute tombstone blocks new reminder identity and due legacy template freezes',
      async () => {
        const snapshot = await f.db.$transaction((tx) => loadQqActivitySnapshot(tx, dynamicActivity.id));
        const shift = {
          ...snapshot,
          startsAt: new Date(now.getTime() + 4 * 3600000),
          endsAt: new Date(now.getTime() + 5 * 3600000)
        };
        const legacy = planQqActivityNotifications(shift, 'REMINDERS', config.target, now)[0];
        await f.db.qqOfficialDelivery.create({
          data: {
            eventKey: legacy.eventKey + '-isolated',
            ...scope,
            activityId: shift.id,
            activityRevision: shift.revision,
            kind: legacy.kind,
            deliveryMode: 'SIMULATION',
            dueAt: legacy.dueAt,
            expiresAt: legacy.expiresAt,
            payload: legacy.payload,
            status: 'SENT',
            attempts: 1,
            createdAt: now
          }
        });
        const fresh = planQqActivityNotifications(shift, 'REMINDERS', config.target, now, [
          { id: 'r120', minutes: 120, enabled: true, template: '新' }
        ])[0];
        assert.equal(
          await f.db.$transaction((tx) => storeQqReminderPlan(tx, fresh, now, pub.notificationEpoch)),
          0
        );
        const due = {
          ...legacy,
          eventKey: legacy.eventKey + '-due',
          dueAt: now,
          expiresAt: new Date(now.getTime() + 60000)
        };
        const old = await f.db.qqOfficialDelivery.create({
          data: {
            eventKey: due.eventKey,
            ...scope,
            activityId: shift.id,
            activityRevision: shift.revision,
            kind: due.kind,
            deliveryMode: 'SIMULATION',
            dueAt: due.dueAt,
            expiresAt: due.expiresAt,
            payload: due.payload,
            status: 'PENDING',
            attempts: 0,
            createdAt: now
          }
        });
        const previous = { ...cfg, templates: { ...cfg.templates, REMINDER_2H: '旧配置模板' } };
        await f.db.$transaction((tx) =>
          reconcileQqReminderPlans(
            tx,
            config.target,
            { ...cfg, reminders: [] },
            now,
            pub.notificationEpoch,
            previous
          )
        );
        const frozen = await f.db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: old.id } });
        assert.equal(frozen.payload.reminder.template, '旧配置模板');
      }
    );
    await check('failed dynamic publication rolls config, plan changes and audit back together', async () => {
      const before = await f.db.qqOfficialDelivery.findMany({ orderBy: { id: 'asc' } }),
        state = await f.db.botManagementState.findUniqueOrThrow({ where: { id: 'qq-official' } }),
        count = await f.db.botManagementAudit.count(),
        original = auth.transaction.bind(auth);
      auth.transaction = (fn) =>
        original(async (tx) => {
          await fn(tx);
          throw new Error('injected dynamic failure');
        });
      try {
        await assert.rejects(() =>
          service.command('save', body(revision, version, { config: { ...cfg, reminders: [] } }), token)
        );
      } finally {
        auth.transaction = original;
      }
      assert.deepEqual(await f.db.qqOfficialDelivery.findMany({ orderBy: { id: 'asc' } }), before);
      assert.deepEqual(
        await f.db.botManagementState.findUniqueOrThrow({ where: { id: 'qq-official' } }),
        state
      );
      assert.equal(await f.db.botManagementAudit.count(), count);
    });

    await check(
      'same-super-admin actor lock and config planning lock have one compatible order',
      async () => {
        const { lock } = await import('../../apps/web/server/auth/service.ts'),
          { lockQqReminderPlanning } = await import('../../packages/db/src/qq-official-notifications.ts');
        const actor = await auth.requireAccount(f.db, token, true);
        let held, release, managerReady;
        const arrived = new Promise((r) => (held = r)),
          released = new Promise((r) => (release = r)),
          manager = new Promise((r) => (managerReady = r));
        const business = f.db.$transaction(async (tx) => {
          await lock(tx, 'phone:' + actor.account.phone);
          held();
          await released;
          await lockQqReminderPlanning(tx);
        });
        await arrived;
        const original = auth.transaction.bind(auth);
        auth.transaction = (fn) =>
          original((tx) =>
            fn(
              new Proxy(tx, {
                get(target, key) {
                  if (key === '$queryRaw')
                    return async (...args) => {
                      const value = await target.$queryRaw(...args);
                      if (args.includes('bot-management:write')) managerReady();
                      return value;
                    };
                  const value = target[key];
                  return typeof value === 'function' ? value.bind(target) : value;
                }
              })
            )
          );
        try {
          const pending = saveDynamic(cfg);
          await manager;
          release();
          await business;
          await pending;
        } finally {
          release();
          auth.transaction = original;
        }
      }
    );
    await check('planning waits refresh trusted clock and never catch up due schedules', async () => {
      const { lockQqReminderPlanning, enqueueQqActivityNotifications } =
        await import('../../packages/db/src/qq-official-notifications.ts');
      const snapshot = await f.db.$transaction((tx) => loadQqActivitySnapshot(tx, dynamicActivity.id));
      const a = {
        ...snapshot,
        startsAt: new Date(now.getTime() + 2 * 3600000),
        endsAt: new Date(now.getTime() + 3 * 3600000)
      };
      let ready, release, waiting;
      const held = new Promise((r) => (ready = r)),
        released = new Promise((r) => (release = r)),
        attempted = new Promise((r) => (waiting = r));
      const holder = f.db.$transaction(async (tx) => {
        await lockQqReminderPlanning(tx);
        ready();
        await released;
      });
      await held;
      let clock = now;
      const before = await f.db.qqOfficialDelivery.count();
      const pending = f.db.$transaction((tx) =>
        enqueueQqActivityNotifications(
          new Proxy(tx, {
            get(target, key) {
              if (key === '$queryRawUnsafe')
                return async (...args) => {
                  if (args[1] === 'bot-management:reminder-planning') waiting();
                  return target.$queryRawUnsafe(...args);
                };
              const value = target[key];
              return typeof value === 'function' ? value.bind(target) : value;
            }
          }),
          a,
          'REMINDERS',
          config.target,
          now,
          () => clock
        )
      );
      await attempted;
      clock = new Date(now.getTime() + 2 * 3600000);
      release();
      await holder;
      assert.equal(await pending, 0);
      assert.equal(await f.db.qqOfficialDelivery.count(), before);
    });
    await check(
      'oversized real 200-seat message fails safely before dispatch without truncation or blocking queue',
      async () => {
        const { ACTIVITY_JOBS } = await import('../../packages/domain/src/index.ts');
        const starts = new Date(now.getTime() + 2 * 3600000),
          ends = new Date(starts.getTime() + 3600000);
        const a = (
          await new ActivityService(auth).create(
            input({
              idempotencyKey: randomUUID(),
              startsAt: bj(starts),
              endsAt: bj(ends),
              dutySelection: { type: 'OTHER', name: '完整二百席', partyComposition: 'CUSTOM' },
              seats: Array.from({ length: 200 }, (_, i) => ({ kind: 'JOB', job: ACTIVITY_JOBS[i % 21].name }))
            }),
            token
          )
        ).activity;
        await saveDynamic({
          ...cfg,
          reminders: [
            {
              id: 'oversize',
              minutes: 30,
              enabled: true,
              template: '文'.repeat(200) + '{队伍构成}|{空缺席位}'
            }
          ]
        });
        const row = await f.db.qqOfficialDelivery.findFirstOrThrow({
          where: { activityId: a.id, kind: 'REMINDER', status: 'PENDING' }
        });
        now = row.dueAt;
        await sync();
        await f.db.qqOfficialDelivery.updateMany({
          where: { activityId: { not: a.id }, status: 'PENDING' },
          data: { status: 'CANCELLED', resultCode: 'ISOLATED_CASE_FINISHED' }
        });
        assert.equal((await qq.claim(wire)).delivery, null);
        const failed = await f.db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: row.id } });
        assert.equal(failed.status, 'FAILED');
        assert.equal(failed.resultCode, 'TEMPLATE_INVALID');
        assert.equal(failed.dispatchedAt, null);
        assert.equal(await f.db.qqOfficialMessage.count(), 0);
      }
    );

    await check('session revoked while command waits for lock cannot commit', async () => {
      let arrive, release;
      const arrived = new Promise((r) => (arrive = r)),
        released = new Promise((r) => (release = r));
      const holding = f.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('bot-management:write',0))::text`;
        arrive();
        await released;
      });
      await arrived;
      const count = await f.db.botManagementAudit.count();
      let initial;
      const original = service.requireSuper.bind(service),
        seen = new Promise((r) => (initial = r));
      service.requireSuper = async (...args) => {
        const result = await original(...args);
        initial();
        return result;
      };
      const pending = service.command('draft', body(revision, version, { config: cfg }), token);
      pending.catch(() => {});
      await seen;
      await f.db.accountSession.deleteMany({ where: { accountId: f.ids[0] } });
      release();
      await holding;
      await reject(() => pending, 'UNAUTHENTICATED');
      service.requireSuper = original;
      assert.equal(await f.db.botManagementAudit.count(), count);
    });
  } finally {
    await f.cleanup();
  }
});
