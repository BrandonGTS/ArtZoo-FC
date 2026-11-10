import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, beijing, noPrivate } from '../activities/support/pg-fixture.mjs';
test('心愿：发布、表态、评论、转为活动与权限（数据库）', async (t) => {
  const f = await fixture();
  let clock = new Date('2030-12-01T00:00:00Z');
  const { WishService } = await import('../../apps/web/server/wishes/service.ts'),
    { AccountService, lock } = await import('../../apps/web/server/auth/service.ts'),
    { mainlandChinaPhone, unavailableSms } = await import('../../apps/web/server/auth/ports.ts');
  const auth = new AccountService(f.db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      environment: 'test',
      now: () => clock
    }),
    s = new WishService(auth);
  const body = () => ({
      category: 'OTHER',
      convenientTime: 'Synthetic time',
      idempotencyKey: randomUUID(),
      title: '一起钓鱼',
      body: '周末想一起看看风景'
    }),
    token = (i) => f.tokens[i],
    get = (id, i = 0) => s.get(id, new URL('http://localhost/wishes'), token(i));
  const check = (name, fn) => t.test(name, fn);
  const create = async () => (await s.create(body(), token(0))).wish;
  const activity = () => ({
    idempotencyKey: randomUUID(),
    title: '合成正式活动',
    description: '既有活动规则\n\n参与要求：\nSynthetic participation',
    category: 'SOCIAL',
    startsAt: beijing(new Date('2030-12-30T12:00:00Z')),
    endsAt: beijing(new Date('2030-12-30T14:00:00Z')),
    seats: [{ kind: 'ANY' }, { kind: 'ANY' }]
  });
  const count = async (table, id) =>
    Number(
      (await f.db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "' + table + '" WHERE "wishId"=$1', id))[0]
        .n
    );
  async function expiryUnderWishLock(wish, action) {
    let unlock, entered;
    const ready = new Promise((r) => (entered = r)),
      hold = new Promise((r) => (unlock = r));
    const holder = f.db.$transaction(
      async (tx) => {
        await lock(tx, 'wish:' + wish.id);
        entered();
        await hold;
      },
      { timeout: 15000 }
    );
    await ready;
    const promise = action().then(
      () => ({ ok: true }),
      (error) => ({ error })
    );
    // Confirm the service is actually blocked on the wish advisory lock.
    let waiting = false;
    for (let i = 0; i < 150; i++) {
      const rows = await f.db
        .$queryRaw`SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND datname=current_database()`;
      if (rows.length) {
        waiting = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(waiting, 'write reached contended lock');
    clock = new Date('2036-01-01T00:00:00Z');
    unlock();
    await holder;
    const result = await promise;
    assert.equal(result.error?.code, 'UNAUTHENTICATED');
    clock = new Date('2030-12-01T00:00:00Z');
  }
  try {
    // 迁移时补充：成功路径（作者本人修改）和被拒绝路径（其他成员修改 / 删除）。
    await check(
      'only the author edits or deletes a wish; another member is rejected and nothing changes',
      async () => {
        const wish = await create();
        const { idempotencyKey: _ignored, ...rest } = body();
        void _ignored;
        const change = (extra = {}) => ({
          ...rest,
          idempotencyKey: randomUUID(),
          expectedRevision: 0,
          ...extra
        });
        await assert.rejects(
          () => s.edit(wish.id, change({ title: '别人改的标题' }), token(1)),
          (e) => e.code === 'FORBIDDEN'
        );
        await assert.rejects(
          () => s.remove(wish.id, { idempotencyKey: randomUUID(), confirmed: true }, token(1)),
          (e) => e.code === 'FORBIDDEN'
        );
        const untouched = await f.db.wish.findUniqueOrThrow({ where: { id: wish.id } });
        assert.equal(untouched.title, '一起钓鱼');
        assert.equal(untouched.revision, 0);
        assert.equal(untouched.deletedAt, null);
        await s.edit(wish.id, change({ title: '作者改的标题' }), token(0));
        const edited = await f.db.wish.findUniqueOrThrow({ where: { id: wish.id } });
        assert.equal(edited.title, '作者改的标题');
        assert.equal(edited.revision, 1);
      }
    );
    await check(
      'anonymous writes and reads rejected, friends browse/comment/interest but cannot publish',
      async () => {
        const input = body();
        await assert.rejects(
          () => s.create(input),
          (e) => e.code === 'UNAUTHENTICATED'
        );
        await assert.rejects(
          () => s.list(new URL('http://localhost')),
          (e) => e.code === 'UNAUTHENTICATED'
        );
        await assert.rejects(
          () => s.create(input, token(5)),
          (e) => e.code === 'FORBIDDEN'
        );
        const w = await create();
        assert.equal((await get(w.id, 5)).id, w.id);
        assert.equal((await s.list(new URL('http://localhost'), token(5))).canPublish, false);
        await s.interest(w.id, {}, token(5));
        await s.comment(w.id, { idempotencyKey: randomUUID(), body: '朋友也能讨论' }, token(5));
        assert.equal((await get(w.id)).interestCount, 1);
        assert.equal((await get(w.id)).commentCount, 1);
      }
    );
    await check(
      'concurrent publishing replays once and key/content conflict never creates a second wish',
      async () => {
        const input = body(),
          results = await Promise.all([s.create(input, token(0)), s.create(input, token(0))]);
        assert.equal(results.filter((x) => x.replayed).length, 1);
        assert.equal(results[0].wish.id, results[1].wish.id);
        await assert.rejects(
          () =>
            s.create(
              { category: 'OTHER', convenientTime: 'Synthetic time', ...input, title: 'changed' },
              token(0)
            ),
          (e) => e.code === 'CONFLICT'
        );
        noPrivate(results);
      }
    );
    await check(
      'same-person concurrent interest deduplicates independently of request keys, no score/registration changes',
      async () => {
        const w = await create(),
          before = await f.db.activityRegistration.count();
        await Promise.all(Array.from({ length: 6 }, () => s.interest(w.id, {}, token(5))));
        assert.equal((await get(w.id)).interestCount, 1);
        assert.equal(await count('WishInterest', w.id), 1);
        assert.equal(await f.db.activityRegistration.count(), before);
        assert.ok(
          (
            await f.db.account.findMany({ where: { id: { in: f.ids } }, select: { activityPoints: true } })
          ).every((a) => a.activityPoints === 0)
        );
      }
    );
    await check('comment concurrency, replay conflict, pagination and privacy', async () => {
      const w = await create(),
        input = { idempotencyKey: randomUUID(), body: '重复提交只保留一条' };
      const results = await Promise.all([s.comment(w.id, input, token(5)), s.comment(w.id, input, token(5))]);
      assert.equal(results.filter((x) => x.replayed).length, 1);
      await assert.rejects(
        () => s.comment(w.id, { ...input, body: 'changed' }, token(5)),
        (e) => e.code === 'CONFLICT'
      );
      assert.equal((await get(w.id)).commentTotal, 1);
      noPrivate(await get(w.id));
    });
    await check(
      'non-author member, friend and admin cannot take over, invalid activity rolls back all linking',
      async () => {
        const w = await create(),
          before = await f.db.activity.count();
        await f.db.account.update({ where: { id: f.ids[7] }, data: { adminRole: 'ADMIN' } });
        for (const i of [1, 5, 7])
          await assert.rejects(
            () => s.convert(w.id, { activity: activity() }, token(i)),
            (e) => e.code === 'FORBIDDEN'
          );
        await assert.rejects(
          () => s.convert(w.id, { activity: { ...activity(), startsAt: 'invalid' } }, token(0)),
          (e) => e.code === 'VALIDATION_ERROR'
        );
        assert.equal((await get(w.id)).activity, null);
        assert.equal(await f.db.activity.count(), before);
        assert.equal(await count('WishNotification', w.id), 0);
      }
    );
    await check(
      'author converts via existing rules atomically, single related activity, interest never copied to enrollment, notification once per person',
      async () => {
        const w = await create();
        await Promise.all([s.interest(w.id, {}, token(1)), s.interest(w.id, {}, token(5))]);
        const input = { activity: activity() },
          results = await Promise.all([s.convert(w.id, input, token(0)), s.convert(w.id, input, token(0))]);
        assert.equal(results.filter((x) => x.replayed).length, 1);
        const linked = results[0].wish.activity.id;
        assert.equal(results[1].activity.id, linked);
        assert.equal(await f.db.activityRegistration.count({ where: { activityId: linked } }), 0);
        assert.equal(await count('WishNotification', w.id), 2);
        const recipients = await f.db
          .$queryRaw`SELECT "recipientId" FROM "WishNotification" WHERE "wishId"=${w.id}`;
        assert.deepEqual(new Set(recipients.map((x) => x.recipientId)), new Set([f.ids[1], f.ids[5]]));
        await assert.rejects(
          () => s.convert(w.id, { activity: activity() }, token(0)),
          (e) => e.code === 'CONFLICT'
        );
        assert.equal(await count('WishConversion', w.id), 1);
        noPrivate(results);
      }
    );
    await check('cannot steal an existing activity via a previously used activity command key', async () => {
      const { ActivityService } = await import('../../apps/web/server/activities/service.ts'),
        input = activity(),
        w = await create();
      await new ActivityService(auth).create(input, token(0));
      await assert.rejects(
        () => s.convert(w.id, { activity: input }, token(0)),
        (e) => e.code === 'CONFLICT'
      );
      assert.equal((await get(w.id)).activity, null);
    });
    await check('existing activity restriction is reused and failure leaves wish unlinked', async () => {
      const w = await create();
      await f.db.account.update({
        where: { id: f.ids[0] },
        data: { activityPoints: 3, activityDecayAt: new Date('2031-01-01') }
      });
      await assert.rejects(
        () => s.convert(w.id, { activity: activity() }, token(0)),
        (e) => e.code === 'FORBIDDEN'
      );
      assert.equal((await get(w.id)).activity, null);
      await f.db.account.update({
        where: { id: f.ids[0] },
        data: { activityPoints: 0, activityDecayAt: null }
      });
    });
    await check(
      'session expiry while waiting for final wish lock rolls back interest, comment and conversion',
      async () => {
        const w = await create();
        await expiryUnderWishLock(w, () => s.interest(w.id, {}, token(2)));
        assert.equal(await count('WishInterest', w.id), 0);
        await expiryUnderWishLock(w, () =>
          s.comment(w.id, { idempotencyKey: randomUUID(), body: 'expired' }, token(2))
        );
        assert.equal(await count('WishComment', w.id), 0);
        const before = await f.db.activity.count();
        await expiryUnderWishLock(w, () => s.convert(w.id, { activity: activity() }, token(0)));
        assert.equal(await f.db.activity.count(), before);
        assert.equal(await count('WishConversion', w.id), 0);
      }
    );
    await check('publishing also revalidates after its final idempotency lock', async () => {
      const input = body();
      let unlock, entered;
      const ready = new Promise((r) => (entered = r)),
        hold = new Promise((r) => (unlock = r));
      const holder = f.db.$transaction(
        async (tx) => {
          await lock(tx, 'wish-create:' + f.ids[0] + ':' + input.idempotencyKey);
          entered();
          await hold;
        },
        { timeout: 15000 }
      );
      await ready;
      const pending = s.create(input, token(0)).then(
        () => ({ ok: true }),
        (error) => ({ error })
      );
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        if (
          (
            await f.db
              .$queryRaw`SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND datname=current_database()`
          ).length
        ) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(waiting);
      clock = new Date('2036-01-01');
      unlock();
      await holder;
      assert.equal((await pending).error?.code, 'UNAUTHENTICATED');
      clock = new Date('2030-12-01');
      const rows = await f.db
        .$queryRaw`SELECT id FROM "Wish" WHERE "authorId"=${f.ids[0]} AND "idempotencyKey"=${input.idempotencyKey}`;
      assert.equal(rows.length, 0);
    });
  } finally {
    await f.cleanup();
  }
});
