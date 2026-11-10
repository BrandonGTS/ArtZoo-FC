// 活动：在真实 PostgreSQL 上验证报名唯一性、最后一席并发、跨活动席位、会话失效复查、
// 写入失败整体回滚，以及发起者管理（退出、取消、改期、自动取消）的完整流程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, noPrivate } from './support/pg-fixture.mjs';
import { input } from './support/activity-input.mjs';

test('活动：真实 PostgreSQL', async (t) => {
  const f = await fixture();
  let now = new Date('2030-06-01T10:00:00Z');
  const check = (name, fn) => t.test(name, fn);
  const reject = (fn, code) => assert.rejects(fn, (e) => e.code === code);
  try {
    const { AccountService } = await import('../../apps/web/server/auth/service.ts');
    const { ActivityService } = await import('../../apps/web/server/activities/service.ts');
    const { mainlandChinaPhone, unavailableSms } = await import('../../apps/web/server/auth/ports.ts');
    const auth = new AccountService(f.db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      environment: 'test',
      now: () => now
    });
    const service = new ActivityService(auth),
      token = (i) => f.tokens[i],
      fresh = (extra = {}) => input({ idempotencyKey: randomUUID(), ...extra });
    let primary;
    await check('anonymous reads and writes deny', async () => {
      for (const fn of [
        () => service.list(new URL('http://test?month=2030-06')),
        () => service.mine(),
        () => service.detail(randomUUID()),
        () => service.create(fresh()),
        () => service.register(randomUUID(), { seatId: randomUUID(), job: '骑士' })
      ])
        await reject(fn, 'UNAUTHENTICATED');
    });
    await check(
      'friend publication denied; member publication stores explicit Beijing instants',
      async () => {
        await reject(() => service.create(fresh(), token(5)), 'FORBIDDEN');
        primary = await service.create(fresh(), token(0));
        assert.equal(primary.replayed, false);
        assert.equal(primary.activity.startsAt, '2030-06-01T12:00:00.000Z');
        assert.equal(primary.activity.endsAt, '2030-06-01T14:00:00.000Z');
        assert.equal(primary.activity.registrationClosesAt, '2030-06-01T11:30:00.000Z');
        assert.equal(primary.activity.registeredCount, 0);
      }
    );
    await check(
      'concurrent identical publication creates one activity and one QQ simulated receipt',
      async () => {
        const body = fresh(),
          results = await Promise.all([service.create(body, token(0)), service.create(body, token(0))]);
        assert.equal(results[0].activity.id, results[1].activity.id);
        assert.equal(results.filter((r) => !r.replayed).length, 1);
        const events = await f.db.activityOutbox.findMany({
          where: { activityId: results[0].activity.id },
          include: { mockDelivery: true }
        });
        assert.equal(events.length, 1);
        assert.equal(events[0].channel, 'QQ');
        assert.equal(events[0].kind, 'ACTIVITY_PUBLISHED');
        assert.ok(events[0].mockDelivery);
        await reject(() => service.create({ ...body, title: 'changed' }, token(0)), 'CONFLICT');
      }
    );
    await check('unknown and private write fields cannot cross service boundary', async () => {
      await reject(() => service.create(fresh({ organizerId: f.ids[1] }), token(0)), 'VALIDATION_ERROR');
      await reject(
        () =>
          service.register(
            primary.activity.id,
            { seatId: primary.activity.seats[0].id, job: '骑士', accountId: f.ids[1] },
            token(2)
          ),
        'VALIDATION_ERROR'
      );
    });
    await check('friend can read and register; role/exact-job/null mismatch rejected', async () => {
      await service.detail(primary.activity.id, token(5));
      await reject(
        () =>
          service.register(
            primary.activity.id,
            { seatId: primary.activity.seats[1].id, job: '白魔法师' },
            token(5)
          ),
        'VALIDATION_ERROR'
      );
      await reject(
        () =>
          service.register(
            primary.activity.id,
            { seatId: primary.activity.seats[2].id, job: '学者' },
            token(5)
          ),
        'VALIDATION_ERROR'
      );
      await reject(
        () =>
          service.register(
            primary.activity.id,
            { seatId: primary.activity.seats[0].id, job: null },
            token(5)
          ),
        'VALIDATION_ERROR'
      );
      const out = await service.register(
        primary.activity.id,
        { seatId: primary.activity.seats[1].id, job: '骑士' },
        token(5)
      );
      assert.equal(out.activity.myRegistration.participant.id, f.ids[5]);
    });
    await check('retry registration has one row and one organizer-only IN_APP receipt', async () => {
      const body = { seatId: primary.activity.seats[1].id, job: '骑士' };
      for (let i = 0; i < 2; i++)
        assert.equal((await service.register(primary.activity.id, body, token(5))).replayed, true);
      assert.equal(
        await f.db.activityRegistration.count({
          where: { activityId: primary.activity.id, accountId: f.ids[5] }
        }),
        1
      );
      const events = await f.db.activityOutbox.findMany({
        where: { activityId: primary.activity.id, kind: 'REGISTRATION_CREATED' },
        include: { mockDelivery: true }
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].recipientId, f.ids[0]);
      assert.equal(events[0].channel, 'IN_APP');
      assert.ok(events[0].mockDelivery);
      assert.equal(Object.hasOwn(await service.mine(token(0)), 'notifications'), false);
      assert.equal(Object.hasOwn(await service.mine(token(1)), 'notifications'), false);
    });
    await check('last seat race commits exactly one winner', async () => {
      const a = (await service.create(fresh({ seats: [{ kind: 'ANY' }] }), token(0))).activity;
      const result = await Promise.allSettled(
        [1, 2, 3, 4, 5].map((i) => service.register(a.id, { seatId: a.seats[0].id, job: '骑士' }, token(i)))
      );
      assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
      for (const r of result.filter((r) => r.status === 'rejected')) assert.equal(r.reason.code, 'CONFLICT');
      assert.equal(await f.db.activityRegistration.count({ where: { activityId: a.id } }), 1);
      assert.equal(
        await f.db.activityOutbox.count({ where: { activityId: a.id, kind: 'REGISTRATION_CREATED' } }),
        1
      );
      assert.equal((await service.detail(a.id, token(0))).status, 'FULL');
    });
    await check('same account concurrent two seats occupies exactly one', async () => {
      const a = (await service.create(fresh({ seats: [{ kind: 'ANY' }, { kind: 'ANY' }] }), token(0)))
        .activity;
      const result = await Promise.allSettled(
        a.seats.map((s) => service.register(a.id, { seatId: s.id, job: '骑士' }, token(1)))
      );
      assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(result.find((r) => r.status === 'rejected').reason.code, 'CONFLICT');
      assert.equal(await f.db.activityRegistration.count({ where: { activityId: a.id } }), 1);
    });
    await check(
      'exact cutoff rejects while cutoff minus 1 ms accepts; existing retry stays idempotent',
      async () => {
        const a = (await service.create(fresh({ seats: [{ kind: 'ANY' }, { kind: 'ANY' }] }), token(0)))
          .activity;
        now = new Date('2030-06-01T11:29:59.999Z');
        const body = { seatId: a.seats[0].id, job: '骑士' };
        await service.register(a.id, body, token(1));
        now = new Date('2030-06-01T11:30:00.000Z');
        await reject(
          () => service.register(a.id, { seatId: a.seats[1].id, job: '骑士' }, token(2)),
          'FORBIDDEN'
        );
        assert.equal((await service.register(a.id, body, token(1))).replayed, true);
        assert.equal((await service.detail(a.id, token(2))).status, 'REGISTRATION_CLOSED');
        now = new Date('2030-06-01T10:00:00Z');
      }
    );
    await check('social null job works and supplied job is rejected', async () => {
      const a = (
        await service.create(
          fresh({ category: 'SOCIAL', seats: [{ kind: 'ANY' }, { kind: 'ANY' }] }),
          token(0)
        )
      ).activity;
      await reject(
        () => service.register(a.id, { seatId: a.seats[0].id, job: '骑士' }, token(2)),
        'VALIDATION_ERROR'
      );
      await service.register(a.id, { seatId: a.seats[0].id, job: null }, token(2));
    });
    await check('another activity seat cannot be submitted', async () => {
      const a = (await service.create(fresh(), token(0))).activity;
      await reject(
        () => service.register(a.id, { seatId: primary.activity.seats[0].id, job: '骑士' }, token(2)),
        'VALIDATION_ERROR'
      );
    });
    await check('fresh service sees same detail/list/my registration and public-only DTO', async () => {
      const reloaded = new ActivityService(
        new AccountService(f.db, {
          phone: mainlandChinaPhone,
          sms: unavailableSms,
          environment: 'test',
          now: () => now
        })
      );
      const detail = await reloaded.detail(primary.activity.id, token(5)),
        list = await reloaded.list(new URL('http://test?month=2030-06'), token(5)),
        mine = await reloaded.mine(token(5));
      const summary = list.items.find((a) => a.id === detail.id);
      assert.equal(summary.registeredCount, detail.registeredCount);
      assert.deepEqual(summary.myRegistration, detail.myRegistration);
      assert.deepEqual(
        mine.registered.find((a) => a.id === detail.id),
        summary
      );
      for (const data of [detail, list, mine, await reloaded.mine(token(0))]) noPrivate(data);
    });
    await check('Beijing month boundary uses local month rather than UTC month', async () => {
      const a = (
        await service.create(
          fresh({ startsAt: '2030-07-01T00:15:00+08:00', endsAt: '2030-07-01T01:15:00+08:00' }),
          token(0)
        )
      ).activity;
      assert.equal(
        (await service.list(new URL('http://test?month=2030-06'), token(1))).items.some((x) => x.id === a.id),
        false
      );
      assert.equal(
        (await service.list(new URL('http://test?month=2030-07'), token(1))).items.some((x) => x.id === a.id),
        true
      );
    });
    await check('event write failure rolls back activity and all seats', async () => {
      const body = fresh(),
        failing = Object.create(auth);
      failing.transaction = (fn) =>
        auth.transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(target, key) {
                if (key === 'activityOutbox')
                  return {
                    create: async () => {
                      throw Error('synthetic failure');
                    }
                  };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              }
            })
          )
        );
      await assert.rejects(() => new ActivityService(failing).create(body, token(0)));
      assert.equal(
        await f.db.activity.count({ where: { organizerId: f.ids[0], idempotencyKey: body.idempotencyKey } }),
        0
      );
    });
    await check(
      'request received before cutoff remains valid after waiting; exact arrival cutoff denies',
      async () => {
        const a = (await service.create(fresh({ seats: [{ kind: 'ANY' }, { kind: 'ANY' }] }), token(0)))
          .activity;
        now = new Date('2030-06-01T11:30:01Z');
        const result = await service.register(
          a.id,
          { seatId: a.seats[0].id, job: '骑士' },
          token(1),
          new Date('2030-06-01T11:29:59.999Z')
        );
        assert.equal(result.activity.registeredCount, 1);
        await reject(
          () =>
            service.register(
              a.id,
              { seatId: a.seats[1].id, job: '骑士' },
              token(2),
              new Date('2030-06-01T11:30:00Z')
            ),
          'FORBIDDEN'
        );
        now = new Date('2030-06-01T10:00:00Z');
      }
    );
    await (
      await import('./support/pg-registration-cases.mjs')
    ).eightPostgresCases({ f, auth, service, check, token, fresh });
    await check(
      'membership downgrade between initial check and locked recheck forbids publication',
      async () => {
        const raced = Object.create(auth);
        let first = true;
        raced.requireAccount = async (tx, t) => {
          const actor = await auth.requireAccount(tx, t);
          if (first) {
            first = false;
            await f.db.account.update({ where: { id: f.ids[3] }, data: { membership: 'FRIEND' } });
          }
          return actor;
        };
        try {
          await reject(() => new ActivityService(raced).create(fresh(), token(3)), 'FORBIDDEN');
        } finally {
          await f.db.account.update({ where: { id: f.ids[3] }, data: { membership: 'MEMBER' } });
        }
      }
    );
    await check('logout between initial check and locked recheck prevents registration', async () => {
      const raced = Object.create(auth);
      let first = true;
      raced.requireAccount = async (tx, t) => {
        const actor = await auth.requireAccount(tx, t);
        if (first) {
          first = false;
          await f.db.accountSession.updateMany({ where: { accountId: f.ids[3] }, data: { revokedAt: now } });
        }
        return actor;
      };
      await reject(
        () =>
          new ActivityService(raced).register(
            primary.activity.id,
            { seatId: primary.activity.seats[0].id, job: '骑士' },
            token(3)
          ),
        'UNAUTHENTICATED'
      );
      assert.equal(
        await f.db.activityRegistration.count({
          where: { activityId: primary.activity.id, accountId: f.ids[3] }
        }),
        0
      );
    });
    await check('session revocation denies stale browser registration and publication', async () => {
      await f.db.accountSession.updateMany({ where: { accountId: f.ids[4] }, data: { revokedAt: now } });
      await reject(() => service.create(fresh(), token(4)), 'UNAUTHENTICATED');
      await reject(
        () =>
          service.register(
            primary.activity.id,
            { seatId: primary.activity.seats[0].id, job: '骑士' },
            token(4)
          ),
        'UNAUTHENTICATED'
      );
    });
    await (
      await import('./support/pg-duty-cases.mjs')
    ).dutyPostgresCases({ f, auth, service, check, token, fresh });
    await (await import('./support/pg-management-cases.mjs')).managementPostgresCases({ f, check });
  } finally {
    await f.cleanup();
  }
});
