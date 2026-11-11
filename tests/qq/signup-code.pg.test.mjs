import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from '../activities/support/pg-fixture.mjs';
import { input } from '../activities/support/activity-input.mjs';
import { AccountService, lock } from '../../apps/web/server/auth/service.ts';
import { mainlandChinaPhone, unavailableSms } from '../../apps/web/server/auth/ports.ts';
import { ActivityService } from '../../apps/web/server/activities/service.ts';
import { QqBridgeService } from '../../apps/web/server/qq-official/bridge.ts';
import { QqOfficialSignupService } from '../../apps/web/server/qq-official/signup.ts';
import { ensureQqSignupCode, resolveQqSignupCode } from '../../apps/web/server/qq-official/signup-code.ts';
import { enqueueQqActivityNotificationsById } from '../../packages/db/src/qq-official-notifications.ts';
import { dutyPresetSeats } from '../../packages/domain/src/index.ts';

test('QQ 报名码与按钮报名（数据库）', async (t) => {
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
    const bridge = new QqBridgeService(auth, config),
      signup = new QqOfficialSignupService(auth, config);
    const wire = {
      app_id: scope.appId,
      bot_id: scope.botId,
      group_openid: scope.groupOpenId,
      simulation: false
    };
    const adopted = { ready: true, plugin_version: '0.3.6', proactive_paused: false, passive_paused: false };
    await f.db.botManagementObservation.create({
      data: { id: 'qq-official', reportedVersion: 0, telemetry: adopted, observedAt: now }
    });
    const check = (name, fn) => t.test(name, fn);
    const reject = (fn, code) => assert.rejects(fn, (e) => e.code === code);
    for (let i = 1; i < 12; i++)
      await f.db.qqOfficialBinding.create({
        data: { ...scope, accountId: f.ids[i], memberOpenId: 'synthetic_member_' + i, confirmedAt: now }
      });
    async function create(composition = 'FULL', extra = {}) {
      const seats = dutyPresetSeats(composition).map((x) => x.requirement);
      return (
        await new ActivityService(auth).create(
          input({
            idempotencyKey: randomUUID(),
            title: 'Synthetic ' + randomUUID().slice(0, 8),
            startsAt: '2030-06-01T22:00:00+08:00',
            endsAt: '2030-06-02T00:00:00+08:00',
            seats,
            dutySelection: { type: 'OTHER', name: 'Synthetic duty', partyComposition: composition },
            ...extra
          }),
          f.tokens[0]
        )
      ).activity;
    }
    // 入队时产品会把等锁耗时加到计划时间上；入队后把测试时钟推进到计划时间，紧接着的领取才不会早于它。
    async function enqueueAndReach(a) {
      await f.db.$transaction((tx) =>
        enqueueQqActivityNotificationsById(tx, a.id, 'PUBLISHED', config.target, now)
      );
      const pending = await f.db.qqOfficialDelivery.findFirstOrThrow({
        where: { activityId: a.id, kind: 'PUBLISHED', ...scope }
      });
      now = new Date(Math.max(now.getTime(), pending.dueAt.getTime()));
    }
    async function claimActivity(a) {
      await f.db.$transaction((tx) =>
        enqueueQqActivityNotificationsById(tx, a.id, 'PUBLISHED', config.target, now)
      );
      // Planning advances its trusted time after lock waits. The frozen fixture clock must reach the persisted due time.
      const pending = await f.db.qqOfficialDelivery.findFirstOrThrow({
        where: { activityId: a.id, kind: 'PUBLISHED', ...scope }
      });
      assert.equal(pending.status, 'PENDING');
      now = new Date(Math.max(now.getTime(), pending.dueAt.getTime()));
      const task = (await bridge.claim(wire)).delivery;
      assert.ok(task);
      assert.equal(
        (await f.db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: task.delivery_id } })).activityId,
        a.id
      );
      assert.equal(task.signup_button, true);
      return task;
    }
    async function acknowledge(task) {
      const base = { ...wire, delivery_id: task.delivery_id, claim_token: task.claim_token };
      assert.equal((await bridge.begin(base)).dispatch, true);
      const ack = {
        ...base,
        outcome: 'sent',
        message_id: 'ordinary_' + task.delivery_id,
        ref_idx: 'reference_' + task.delivery_id
      };
      assert.equal((await bridge.ack(ack)).accepted, true);
      return ack;
    }
    function command(code, seat = 'H1 白魔', member = 1, extra = {}) {
      return {
        ...wire,
        sender_openid: 'synthetic_member_' + member,
        event_id: randomUUID(),
        message_idx: randomUUID(),
        event_timestamp: now.toISOString(),
        content: `报名 ${code}${seat ? ' ' + seat : ''}`,
        activity_code: code,
        ...extra
      };
    }
    let a, task, ack, code;
    await check('parallel allocation has one durable non-recycled code per activity and scope', async () => {
      a = await create();
      const codes = await Promise.all(
        Array.from({ length: 6 }, () => f.db.$transaction((tx) => ensureQqSignupCode(tx, scope, a.id, now)))
      );
      assert.equal(new Set(codes).size, 1);
      code = codes[0];
      assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
      assert.equal(await f.db.qqOfficialSignupCode.count({ where: { ...scope, activityId: a.id } }), 1);
    });
    await check(
      'claim freezes copy text and explicit button metadata, allocation alone cannot register',
      async () => {
        await f.db.botManagementObservation.update({
          where: { id: 'qq-official' },
          data: { telemetry: { ...adopted, plugin_version: '0.3.5' } }
        });
        await f.db.$transaction((tx) =>
          enqueueQqActivityNotificationsById(tx, a.id, 'PUBLISHED', config.target, now)
        );
        assert.equal((await bridge.claim(wire)).delivery, null);
        const unleased = await f.db.qqOfficialDelivery.findFirstOrThrow({
          where: { activityId: a.id, kind: 'PUBLISHED' }
        });
        assert.equal(unleased.status, 'PENDING');
        assert.equal(unleased.renderedContent, null);
        assert.equal(unleased.signupCode, null);
        await f.db.botManagementObservation.update({
          where: { id: 'qq-official' },
          data: { telemetry: adopted }
        });
        task = await claimActivity(a);
        assert.equal(task.signup_code, code);
        assert.ok(task.content.endsWith(`报名 ${code} MT 骑士`));
        await f.db.qqOfficialMessage.create({
          data: { ...scope, activityId: a.id, deliveryId: randomUUID(), refIdx: 'synthetic_old_notice' }
        });
        await reject(
          () => signup.registerCode(scope, 'synthetic_member_1', code, `报名 ${code} H1 白魔`),
          'NOT_FOUND'
        );
        assert.equal(
          await f.db.activityRegistration.count({ where: { activityId: a.id, accountId: f.ids[1] } }),
          0
        );
        const frozen = await f.db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: task.delivery_id } });
        assert.equal(frozen.signupButton, true);
        assert.equal(frozen.signupCode, code);
        await f.db.botManagementObservation.update({
          where: { id: 'qq-official' },
          data: { telemetry: { ...adopted, plugin_version: '0.3.5' } }
        });
        assert.equal(
          (await bridge.begin({ ...wire, delivery_id: task.delivery_id, claim_token: task.claim_token }))
            .dispatch,
          false
        );
        assert.equal(
          (await f.db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: task.delivery_id } })).status,
          'CLAIMED'
        );
        await f.db.botManagementObservation.update({
          where: { id: 'qq-official' },
          data: { telemetry: adopted }
        });
      }
    );
    await check(
      'confirmed receipt activates locator; explicit command works without quote and reports target',
      async () => {
        ack = await acknowledge(task);
        const body = command(code),
          r = await bridge.command(body);
        assert.match(r.message, /报名成功/);
        assert.ok(r.message.includes(a.title));
        assert.ok(r.message.includes(code));
        assert.ok(r.message.includes('H1'));
        assert.deepEqual(await bridge.command(body), r);
        await reject(() => bridge.command({ ...body, activity_code: '23456789' }), 'FORBIDDEN');
        const omitted = { ...body };
        delete omitted.activity_code;
        await reject(() => bridge.command(omitted), 'FORBIDDEN');
        assert.equal((await bridge.command(command(code))).message, '你已报名该活动，无需重复报名');
        assert.equal(
          await f.db.activityRegistration.count({ where: { activityId: a.id, accountId: f.ids[1] } }),
          1
        );
      }
    );
    await check(
      'unknown quote does not block an explicit valid locator; existing quote-only path remains',
      async () => {
        assert.match(
          (await bridge.command(command(code, 'H2 学者', 2, { ref_idx: 'unmapped_reference' }))).message,
          /报名成功/
        );
        assert.match(
          (await bridge.command(command(code, 'D2 忍者', 11, { ref_idx: 'x'.repeat(300) }))).message,
          /报名成功/
        );
        const body = command(code, 'D1 武士', 3, { content: '报名 D1 武士', ref_idx: ack.ref_idx });
        delete body.activity_code;
        assert.match((await bridge.command(body)).message, /报名成功/);
      }
    );
    await check(
      'fresh duplicate code and quote commands do not report success or change business state',
      async () => {
        async function business() {
          return {
            registrations: await f.db.activityRegistration.count(),
            messages: await f.db.messageNotification.count(),
            outbox: await f.db.activityOutbox.count(),
            revision: (await f.db.activity.findUniqueOrThrow({ where: { id: a.id } })).revision
          };
        }
        const before = await business(),
          same = command(code);
        const one = await bridge.command(same);
        assert.equal(one.message, '你已报名该活动，无需重复报名');
        assert.deepEqual(await bridge.command(same), one);
        const quote = command(code, '', 3, { content: '报名 D1 武士', ref_idx: ack.ref_idx });
        delete quote.activity_code;
        assert.equal((await bridge.command(quote)).message, '你已报名该活动，无需重复报名');
        assert.equal(
          (await bridge.command(command(code, 'H2 学者', 1))).message,
          '你已报名该活动，不能重复占用席位'
        );
        assert.equal(
          (await bridge.command(command(code, 'H1 学者', 1))).message,
          '你已报名该活动，不能重复占用席位'
        );
        const other = command(code, '', 3, { content: '报名 H2 学者', ref_idx: ack.ref_idx });
        delete other.activity_code;
        assert.equal((await bridge.command(other)).message, '你已报名该活动，不能重复占用席位');
        assert.deepEqual(await business(), before);
      }
    );
    await check(
      'concurrent same-user fresh messages produce one success and one duplicate; delivery replay stays idempotent',
      async () => {
        const activity = await create(),
          t = await claimActivity(activity);
        await acknowledge(t);
        const beforeRevision = (await f.db.activity.findUniqueOrThrow({ where: { id: activity.id } }))
          .revision;
        const results = await Promise.all([
          bridge.command(command(t.signup_code, 'H1 白魔', 4)),
          bridge.command(command(t.signup_code, 'H1 白魔', 4))
        ]);
        assert.equal(results.filter((r) => r.message.startsWith('报名成功')).length, 1);
        assert.equal(results.filter((r) => r.message === '你已报名该活动，无需重复报名').length, 1);
        assert.equal(
          await f.db.activityRegistration.count({ where: { activityId: activity.id, accountId: f.ids[4] } }),
          1
        );
        assert.equal(
          (await f.db.activity.findUniqueOrThrow({ where: { id: activity.id } })).revision,
          beforeRevision + 1
        );
        const replayActivity = await create(),
          rt = await claimActivity(replayActivity);
        await acknowledge(rt);
        const body = command(rt.signup_code, 'H1 白魔', 6);
        const replies = await Promise.all([bridge.command(body), bridge.command(body)]);
        assert.deepEqual(replies[0], replies[1]);
        assert.match(replies[0].message, /^报名成功/);
        assert.equal(
          await f.db.activityRegistration.count({
            where: { activityId: replayActivity.id, accountId: f.ids[6] }
          }),
          1
        );
      }
    );
    await check(
      'bad locators, command disagreement, missing binding and wrong scope do not register',
      async () => {
        const before = await f.db.activityRegistration.count();
        for (const body of [
          command('ZZZZZZZZ', 'D2 忍者', 4),
          command(code, 'D2 忍者', 4, { activity_code: '23456789' }),
          command(code, 'D2 忍者', 19),
          command(code, 'D2 忍者', 4, { activity_code: undefined }),
          command(code, 'D2 忍者', 4, { content: '报名 H1 白魔' })
        ])
          assert.ok(!(await bridge.command(body)).message.startsWith('报名成功'));
        await reject(
          () =>
            signup.registerCode(
              { ...scope, groupOpenId: 'synthetic_other_group' },
              'synthetic_member_4',
              code,
              `报名 ${code} D2 忍者`
            ),
          'NOT_FOUND'
        );
        await assert.rejects(() => bridge.command(command(code, 'D2 忍者', 4, { bot_id: 'wrong_bot' })));
        assert.equal(await f.db.activityRegistration.count(), before);
      }
    );
    let second, secondTask, secondAck, secondCode;
    await check(
      'known quote conflicting with explicit code rejects without partial registration',
      async () => {
        second = await create();
        secondTask = await claimActivity(second);
        secondCode = secondTask.signup_code;
        secondAck = await acknowledge(secondTask);
        assert.notEqual(secondCode, code);
        const r = await bridge.command(command(code, 'D2 忍者', 4, { ref_idx: secondAck.ref_idx }));
        assert.match(r.message, /不一致/);
        assert.equal(
          await f.db.activityRegistration.count({ where: { activityId: a.id, accountId: f.ids[4] } }),
          0
        );
      }
    );
    await check(
      'two accounts racing for a seat produce one registration; retries cannot move or duplicate',
      async () => {
        const results = await Promise.all(
          [4, 6].map((i) => bridge.command(command(secondCode, 'H1 白魔', i)))
        );
        assert.equal(results.filter((x) => x.message.startsWith('报名成功')).length, 1);
        assert.equal(await f.db.activityRegistration.count({ where: { activityId: second.id } }), 1);
        const winner =
          (await f.db.activityRegistration.findFirstOrThrow({ where: { activityId: second.id } }))
            .accountId === f.ids[4]
            ? 4
            : 6;
        const r = await bridge.command(command(secondCode, 'H2 学者', winner));
        assert.ok(!r.message.startsWith('报名成功'));
        assert.equal(await f.db.activityRegistration.count({ where: { activityId: second.id } }), 1);
      }
    );
    await check('cancellation and current cutoff remain authoritative after code activation', async () => {
      await f.db.activity.update({ where: { id: second.id }, data: { cancelledAt: now } });
      assert.match((await bridge.command(command(secondCode, 'H2 学者', 7))).message, /取消/);
      now = new Date('2030-06-01T13:30:00Z');
      assert.match((await bridge.command(command(code, 'D2 忍者', 7))).message, /截止/);
      now = new Date('2030-06-01T10:00:00Z');
    });
    await check('24-person and offline commands keep their original registration semantics', async () => {
      const alliance = await create('ALLIANCE'),
        allTask = await claimActivity(alliance);
      await acknowledge(allTask);
      assert.match(
        (await bridge.command(command(allTask.signup_code, 'A队 H1 白魔', 8))).message,
        /报名成功/
      );
      assert.ok(
        !(await bridge.command(command(allTask.signup_code, 'H1 白魔', 9))).message.startsWith('报名成功')
      );
      const offline = await create('FULL', {
        scene: 'OFFLINE',
        category: 'SOCIAL',
        dutySelection: null,
        seats: [],
        offline: {
          location: 'Synthetic location',
          meetingInstructions: '',
          capacity: null,
          registrationClosesAt: '2030-06-01T21:30:00+08:00'
        }
      });
      const offTask = await claimActivity(offline);
      await acknowledge(offTask);
      assert.ok(offTask.content.endsWith('报名 ' + offTask.signup_code));
      assert.match((await bridge.command(command(offTask.signup_code, '', 9))).message, /报名成功/);
      assert.equal(
        (await bridge.command(command(offTask.signup_code, '', 9))).message,
        '你已报名该活动，无需重复报名'
      );
      assert.equal(
        await f.db.activityRegistration.count({ where: { activityId: offline.id, accountId: f.ids[9] } }),
        1
      );
    });
    await check('waiting for activity lock rechecks trusted cutoff with complete rollback', async () => {
      const activity = await create(),
        t = await claimActivity(activity);
      await acknowledge(t);
      let release, locked;
      const ready = new Promise((r) => (locked = r)),
        hold = new Promise((r) => (release = r));
      const blocker = f.db.$transaction(
        async (tx) => {
          await lock(tx, 'activity:' + activity.id);
          locked();
          await hold;
        },
        { timeout: 10000 }
      );
      await ready;
      const pending = signup.registerCode(
        scope,
        'synthetic_member_10',
        t.signup_code,
        `报名 ${t.signup_code} H1 白魔`
      );
      await new Promise((r) => setTimeout(r, 150));
      now = new Date('2030-06-01T13:30:00Z');
      release();
      await blocker;
      await reject(() => pending, 'FORBIDDEN');
      assert.equal(await f.db.activityRegistration.count({ where: { activityId: activity.id } }), 0);
      now = new Date('2030-06-01T10:00:00Z');
    });
    await check('old frozen notices keep their content and have no retroactive code or button', async () => {
      const old = await create();
      await enqueueAndReach(old);
      const row = await f.db.qqOfficialDelivery.findFirstOrThrow({
        where: { activityId: old.id, kind: 'PUBLISHED' }
      });
      await f.db.qqOfficialDelivery.update({
        where: { id: row.id },
        data: { renderedContent: 'Frozen legacy notice' }
      });
      const t = (await bridge.claim(wire)).delivery;
      assert.equal(t.content, 'Frozen legacy notice');
      assert.equal(t.signup_code, undefined);
      assert.equal(t.signup_button, undefined);
      assert.equal(await f.db.qqOfficialSignupCode.count({ where: { activityId: old.id } }), 0);
    });
    await check(
      'custom templates and both activity fields remain intact with the system instruction',
      async () => {
        const { BotManagementService, BotManagementBridge } =
          await import('../../apps/web/server/bot-management/service.ts');
        const { botDefaults } = await import('../../packages/domain/src/index.ts');
        await f.db.account.update({ where: { id: f.ids[0] }, data: { adminRole: 'SUPER_ADMIN' } });
        const management = new BotManagementService(auth, config),
          cfg = botDefaults();
        cfg.templates.PUBLISHED = 'CUSTOM_LITERAL|{arrangement}|{participationRequirements}';
        const saved = await management.command(
          'save',
          { expectedRevision: 0, expectedVersion: 0, idempotencyKey: randomUUID(), config: cfg },
          f.tokens[0]
        );
        const pub = await f.db.botManagementPublication.findUniqueOrThrow({
          where: { version: saved.publishedVersion }
        });
        await new BotManagementBridge(auth, config).sync({
          ...wire,
          protocol: 1,
          applied_version: pub.version,
          applied_digest: pub.digest,
          apply_error: null,
          telemetry: {
            ready: true,
            plugin_version: '0.3.6',
            proactive_paused: false,
            passive_paused: false,
            minute_proactive: 0,
            minute_group: 0,
            rolling_proactive: 0,
            reply_outcomes: { sent: 0, unknown: 0, permission_denied: 0, simulated: 0 },
            recent: []
          }
        });
        const activity = await create(),
          t = await claimActivity(activity);
        assert.ok(t.content.startsWith('CUSTOM_LITERAL|Synthetic fixture|Synthetic participation'));
        assert.ok(t.content.endsWith('报名 ' + t.signup_code + ' MT 骑士'));
        assert.deepEqual(
          (await f.db.botManagementPublication.findUniqueOrThrow({ where: { version: pub.version } })).config,
          cfg
        );
        await acknowledge(t);
      }
    );
    await check('button opt-in is frozen per delivery and absent by default', async () => {
      const activity = await create();
      await enqueueAndReach(activity);
      const normal = new QqBridgeService(auth, { ...config, signupButtons: undefined });
      const t = (await normal.claim(wire)).delivery;
      assert.equal(
        (await f.db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: t.delivery_id } })).activityId,
        activity.id
      );
      assert.match(t.signup_code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
      assert.equal(t.signup_button, false);
    });
    await check(
      'unknown activity-button send never activates its code or requeues the notification',
      async () => {
        const activity = await create(),
          t = await claimActivity(activity),
          base = { ...wire, delivery_id: t.delivery_id, claim_token: t.claim_token };
        assert.equal((await bridge.begin(base)).dispatch, true);
        assert.equal((await bridge.ack({ ...base, outcome: 'unknown' })).accepted, true);
        assert.equal(
          (await f.db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: t.delivery_id } })).status,
          'UNKNOWN'
        );
        const allocated = await f.db.qqOfficialSignupCode.findUniqueOrThrow({
          where: { code: t.signup_code }
        });
        assert.equal(allocated.activatedAt, null);
        await reject(
          () =>
            signup.registerCode(scope, 'synthetic_member_10', t.signup_code, `报名 ${t.signup_code} H1 白魔`),
          'NOT_FOUND'
        );
        assert.equal((await bridge.claim(wire)).delivery, null);
        assert.equal(await f.db.activityRegistration.count({ where: { activityId: activity.id } }), 0);
      }
    );
  } finally {
    await f.cleanup();
  }
});
