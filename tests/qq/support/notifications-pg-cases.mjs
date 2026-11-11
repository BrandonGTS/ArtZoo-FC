import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  enqueueQqActivityNotifications,
  enqueueConfiguredQqActivityNotifications,
  claimQqDelivery,
  beginQqDelivery,
  completeQqDelivery,
  recoverQqDeliveryLeases
} from '../../../packages/db/src/qq-official-notifications.ts';

export async function notificationPostgresCases({ db, check, organizerId }) {
  const now = new Date('2032-06-01T00:00:00Z');
  // 通知表对活动有外键，所以每个场景先建一条真实的合成活动。
  const setup = async () => {
    const suffix = randomUUID();
    const f = {
      target: {
        appId: 'notify-test-app-' + suffix,
        botId: 'notify-test-bot',
        groupOpenId: 'notify-test-group',
        enabled: true,
        testGroupOnly: true,
        deliveryMode: 'LIVE',
        enabledAt: new Date('2032-05-01T00:00:00Z')
      },
      activity: {
        id: randomUUID(),
        revision: 0,
        title: '合成通知活动',
        scene: 'GAME',
        mode: 'SINGLE',
        startsAt: new Date('2032-06-01T04:00:00Z'),
        endsAt: new Date('2032-06-01T06:00:00Z'),
        createdAt: new Date('2032-05-20T00:00:00Z'),
        cancelledAt: null
      }
    };
    const { id, title, scene, mode, startsAt, endsAt, createdAt } = f.activity;
    await db.activity.create({
      data: {
        id,
        organizerId,
        idempotencyKey: randomUUID(),
        requestFingerprint: 'synthetic',
        title,
        description: '合成通知活动',
        category: 'DUNGEON',
        scene,
        mode,
        startsAt,
        endsAt,
        createdAt
      }
    });
    return f;
  };
  const identity = (claim) => ({
    id: claim.delivery.id,
    fence: claim.delivery.fence,
    claimToken: claim.claimToken
  });
  // 入队时产品会把"等锁花掉的真实毫秒数"加到计划时间上（防止补发已到期的提醒）。
  // 测试传入固定时钟，让计划时间正好等于测试时间；否则机器慢时，领取时刻会早于计划时刻，领不到投递。
  const fixed = () => now;
  const queue = async (f) =>
    db.$transaction((tx) =>
      enqueueQqActivityNotifications(tx, f.activity, 'PUBLISHED', f.target, now, fixed)
    );
  const claim = async (f, at = now) => db.$transaction((tx) => claimQqDelivery(tx, f.target, at));
  const begin = async (f, c, at = now, row = f.activity) =>
    db.$transaction((tx) => beginQqDelivery(tx, identity(c), row, f.target, at));
  const complete = async (c, outcome, at = now) =>
    db.$transaction((tx) => completeQqDelivery(tx, identity(c), outcome, at));
  await check('QQ notifications real PG dedup enqueue and parallel workers claim exactly once', async () => {
    const f = await setup();
    assert.equal(await queue(f), 3);
    assert.equal(await queue(f), 0);
    const results = await Promise.all(Array.from({ length: 6 }, () => claim(f)));
    assert.equal(results.filter(Boolean).length, 1);
    const c = results.find(Boolean),
      stored = await db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: c.delivery.id } });
    assert.equal(stored.fence, 1);
    assert.equal(stored.attempts, 1);
    assert.notEqual(stored.leaseOwner, c.claimToken);
    assert.equal(stored.status, 'CLAIMED');
    assert.equal(await claim({ ...f, target: { ...f.target, deliveryMode: 'SIMULATION' } }), null);
  });
  await check(
    'QQ notifications real PG predispatch lease recovery increments fence and rejects stale claim',
    async () => {
      const f = await setup();
      await queue(f);
      const one = await claim(f),
        later = new Date(now.getTime() + 31000);
      await db.$transaction((tx) => recoverQqDeliveryLeases(tx, later));
      assert.equal(
        (await db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: one.delivery.id } })).status,
        'PENDING'
      );
      const two = await claim(f, later);
      assert.equal(two.delivery.id, one.delivery.id);
      assert.equal(two.delivery.fence, 2);
      assert.equal(await begin(f, one, later), null);
      assert.equal((await begin(f, two, later)).status, 'DISPATCHING');
      assert.equal(await complete(one, { kind: 'SENT', providerMessageId: 'stale' }, later), false);
      assert.equal(
        await complete(two, { kind: 'SENT', providerMessageId: 'synthetic-confirmed' }, later),
        true
      );
      assert.equal(await complete(two, { kind: 'SENT', providerMessageId: 'duplicate' }, later), false);
      assert.equal(
        (await db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: one.delivery.id } })).providerMessageId,
        'synthetic-confirmed'
      );
    }
  );
  await check('QQ notifications real PG duplicate begin cannot authorize duplicate dispatch', async () => {
    const f = await setup();
    await queue(f);
    const c = await claim(f);
    const results = await Promise.all([begin(f, c), begin(f, c)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(results.find(Boolean).status, 'DISPATCHING');
  });
  await check(
    'QQ notifications real PG crash after dispatch becomes terminal UNKNOWN with no automatic claim',
    async () => {
      const f = await setup();
      await queue(f);
      const c = await claim(f);
      await begin(f, c);
      const later = new Date(now.getTime() + 31000);
      await db.$transaction((tx) => recoverQqDeliveryLeases(tx, later));
      assert.equal(
        (await db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: c.delivery.id } })).status,
        'UNKNOWN'
      );
      assert.equal(await claim(f, later), null);
      assert.equal(await complete(c, { kind: 'SENT', providerMessageId: 'late-response' }, later), false);
    }
  );
  await check('QQ notifications real PG timeout UNKNOWN and permission DENIED never retry', async () => {
    for (const outcome of [{ kind: 'UNKNOWN' }, { kind: 'DENIED' }]) {
      const f = await setup();
      await queue(f);
      const c = await claim(f);
      await begin(f, c);
      assert.equal(await complete(c, outcome), true);
      assert.equal(
        (await db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: c.delivery.id } })).status,
        outcome.kind
      );
      assert.equal(await claim(f, new Date(now.getTime() + 10000)), null);
    }
  });
  await check(
    'QQ notifications real PG safe pre-send retries bounded at three and simulation stays distinct',
    async () => {
      const f = await setup();
      await queue(f);
      let at = now,
        lastId;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const c = await claim(f, at);
        assert.ok(c);
        lastId = c.delivery.id;
        assert.equal(c.delivery.attempts, attempt);
        await begin(f, c, at);
        assert.equal(await complete(c, { kind: 'SAFE_PRE_SEND_FAILURE' }, at), true);
        at = new Date(at.getTime() + 20000);
      }
      assert.equal(
        (await db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: lastId } })).status,
        'FAILED'
      );
      assert.equal(await claim(f, at), null);
      const g = await setup();
      g.target.deliveryMode = 'SIMULATION';
      await queue(g);
      const c = await claim(g);
      await begin(g, c);
      assert.equal(await complete(c, { kind: 'SENT', providerMessageId: 'must-not-confirm-mock' }), false);
      assert.equal(await complete(c, { kind: 'SIMULATED' }), true);
      const simulated = await db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: c.delivery.id } });
      assert.equal(simulated.status, 'SIMULATED');
      assert.equal(simulated.sentAt, null);
      assert.equal(simulated.providerMessageId, null);
    }
  );
  await check(
    'QQ notifications real PG cancelled or rescheduled activity rejects pending begin',
    async () => {
      for (const patch of [{ cancelledAt: now }, { startsAt: new Date('2032-06-01T05:00:00Z') }]) {
        const f = await setup();
        await queue(f);
        const c = await claim(f);
        assert.equal(await begin(f, c, now, { ...f.activity, ...patch }), null);
        assert.equal(
          (await db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: c.delivery.id } })).status,
          'CANCELLED'
        );
      }
    }
  );
  await check(
    'QQ notifications real PG changed/cancel hooks fence outstanding claim and replace schedules',
    async () => {
      const f = await setup();
      await queue(f);
      const old = await claim(f);
      const changed = { ...f.activity, revision: 1, title: '合成已修改' };
      await db.$transaction((tx) =>
        enqueueQqActivityNotifications(tx, changed, 'CHANGED', f.target, now, fixed)
      );
      assert.equal(await begin(f, old), null);
      assert.equal(
        (await db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: old.delivery.id } })).status,
        'CANCELLED'
      );
      const active = await db.qqOfficialDelivery.findMany({
        where: { appId: f.target.appId, status: 'PENDING' }
      });
      assert.deepEqual(active.map((row) => row.kind).sort(), ['CHANGED', 'REMINDER_1H', 'REMINDER_2H']);
      await db.$transaction((tx) =>
        enqueueQqActivityNotifications(
          tx,
          { ...changed, revision: 2, cancelledAt: now },
          'CANCELLED',
          f.target,
          now,
          fixed
        )
      );
      const remaining = await db.qqOfficialDelivery.findMany({
        where: { appId: f.target.appId, status: 'PENDING' }
      });
      assert.deepEqual(
        remaining.map((row) => row.kind),
        ['CANCELLED']
      );
    }
  );
  await check('QQ notifications real PG mismatched scope and expired reminder cannot begin', async () => {
    const f = await setup();
    await queue(f);
    const c = await claim(f);
    assert.equal(
      await db.$transaction((tx) =>
        beginQqDelivery(tx, identity(c), f.activity, { ...f.target, groupOpenId: 'wrong' }, now)
      ),
      null
    );
    assert.equal(
      (await db.qqOfficialDelivery.findUniqueOrThrow({ where: { id: c.delivery.id } })).status,
      'DENIED'
    );
    const g = await setup();
    await queue(g);
    const expired = new Date(g.activity.startsAt.getTime() - 3600000 + 60000);
    assert.equal(await claim(g, expired), null);
    const all = await db.qqOfficialDelivery.findMany({ where: { appId: g.target.appId } });
    assert.ok(all.every((row) => row.status === 'EXPIRED'));
  });
  await check(
    'QQ worker planner queues approved live target without bridge credential in real PG',
    async () => {
      const f = await setup(),
        organizer = await db.account.findFirstOrThrow({ select: { id: true } });
      // 本场景需要特定字段的活动，先删掉 setup 建的通用合成活动再重建。
      await db.activity.delete({ where: { id: f.activity.id } });
      const row = await db.activity.create({
        data: {
          id: f.activity.id,
          organizerId: organizer.id,
          idempotencyKey: randomUUID(),
          requestFingerprint: 'synthetic-planner-only',
          title: f.activity.title,
          description: 'Synthetic isolated planner fixture',
          category: 'SOCIAL',
          scene: 'GAME',
          mode: 'SINGLE',
          startsAt: f.activity.startsAt,
          endsAt: f.activity.endsAt,
          createdAt: f.activity.createdAt
        }
      });
      const values = {
        ARTZOO_QQ_MODE: 'live',
        ARTZOO_QQ_LIVE_SEND_ENABLED: '1',
        ARTZOO_QQ_PROACTIVE_ENABLED: '1',
        ARTZOO_QQ_TARGET_KIND: 'TEST',
        ARTZOO_QQ_TEST_GROUP_APPROVED: '1',
        ARTZOO_QQ_APP_ID: f.target.appId,
        ARTZOO_QQ_BOT_ID: f.target.botId,
        ARTZOO_QQ_GROUP_OPENID: f.target.groupOpenId,
        ARTZOO_QQ_ENABLED_AT: f.target.enabledAt.toISOString(),
        ARTZOO_QQ_BRIDGE_SECRET: undefined
      };
      const prior = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
      try {
        for (const [k, v] of Object.entries(values))
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        assert.equal(
          await db.$transaction((tx) =>
            enqueueConfiguredQqActivityNotifications(tx, row.id, 'PUBLISHED', now)
          ),
          3
        );
        const plans = await db.qqOfficialDelivery.findMany({ where: { activityId: row.id } });
        assert.equal(plans.length, 3);
        assert.ok(
          plans.every(
            (p) => p.appId === f.target.appId && p.deliveryMode === 'LIVE' && p.status === 'PENDING'
          )
        );
      } finally {
        for (const [k, v] of Object.entries(prior))
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
      }
    }
  );
}
