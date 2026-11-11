// 处罚申诉（真实 PostgreSQL）：7 天期限、同时只有一条待处理、驳回后换理由可再申诉；
// 批准后撤销处罚并按流水重算点数与限制。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, noPrivate } from '../activities/support/pg-fixture.mjs';
import { input } from './support/activity-input.mjs';

test('处罚申诉：真实 PostgreSQL', async (t) => {
  const f = await fixture();
  let now = new Date('2030-06-01T10:00:00Z');
  const check = (name, fn) => t.test(name, fn);
  try {
    const { AccountService } = await import('../../apps/web/server/auth/service.ts'),
      { ActivityService } = await import('../../apps/web/server/activities/service.ts'),
      { ActivityManagementService } = await import('../../apps/web/server/activities/management.ts'),
      { ActivityPenaltyAppealService } = await import('../../apps/web/server/activities/penalty-appeals.ts'),
      { ActivityAttendanceService } = await import('../../apps/web/server/activities/attendance.ts'),
      { mainlandChinaPhone, unavailableSms } = await import('../../apps/web/server/auth/ports.ts'),
      { processActivityCompletions } = await import('../../packages/db/src/activity-completion.ts'),
      { addActivityPenaltyPoints, reverseAttendancePenalty } =
        await import('../../packages/db/src/activity-standing.ts');
    const authFor = (db) =>
        new AccountService(db, {
          phone: mainlandChinaPhone,
          sms: unavailableSms,
          environment: 'test',
          now: () => now
        }),
      auth = authFor(f.db),
      basic = new ActivityService(auth),
      management = new ActivityManagementService(auth),
      service = new ActivityPenaltyAppealService(auth),
      attendance = new ActivityAttendanceService(auth),
      token = (i) => f.tokens[i];
    await f.db.account.update({ where: { id: f.ids[2] }, data: { adminRole: 'ADMIN' } });
    await f.db.account.update({ where: { id: f.ids[5] }, data: { membership: 'MEMBER' } });
    const balance = (i) =>
        f.db.account.findUniqueOrThrow({
          where: { id: f.ids[i] },
          select: { activityPoints: true, activityDecayAt: true }
        }),
      submit = (v, extra = {}) =>
        service.appeal(
          v.p.id,
          {
            idempotencyKey: randomUUID(),
            expectedLatestAppealId: null,
            reason: 'Synthetic documented circumstances',
            ...extra
          },
          token(v.member)
        ),
      decision = (extra = {}) => ({
        idempotencyKey: randomUUID(),
        expectedAppealRevision: 0,
        decision: 'APPROVE',
        reason: 'Verified synthetic circumstances',
        ...extra
      }),
      decide = (a, body = decision(), i = 2) => service.decide(a.id, body, token(i));
    async function make(member, cancel = false, base = 0) {
      now = new Date('2030-06-01T10:00:00Z');
      await f.db.account.update({
        where: { id: f.ids[member] },
        data: { activityPoints: base, activityDecayAt: null }
      });
      const a = (
        await basic.create(
          input({
            idempotencyKey: randomUUID(),
            category: 'SOCIAL',
            dutySelection: null,
            seats: [{ kind: 'ANY' }]
          }),
          token(cancel ? member : 0)
        )
      ).activity;
      let r;
      if (!cancel) {
        const joined = await basic.register(a.id, { seatId: a.seats[0].id, job: null }, token(member));
        r = await f.db.activityRegistration.findFirstOrThrow({
          where: { activityId: a.id, accountId: f.ids[member] }
        });
        now = new Date('2030-06-01T11:00:00Z');
        await management.withdraw(
          a.id,
          {
            idempotencyKey: randomUUID(),
            expectedRevision: joined.activity.revision,
            expectedRegistrationId: r.id,
            expectedPenaltyPoints: 1
          },
          token(member)
        );
      } else {
        now = new Date('2030-06-01T11:00:00Z');
        await management.cancel(
          a.id,
          { idempotencyKey: randomUUID(), expectedRevision: a.revision, expectedPenaltyPoints: 2 },
          token(member)
        );
      }
      const p = await f.db.activityPenalty.findFirstOrThrow({
        where: { activityId: a.id, accountId: f.ids[member] }
      });
      return { a, r, p, member };
    }
    const v = await make(1);
    await check(
      'real withdrawal creates appealable penalty and member sees only own public DTO',
      async () => {
        const list = await service.minePenalties(new URL('http://local/?page=99'), token(1));
        noPrivate(list);
        assert.equal(list.page, 1);
        assert.equal(list.items[0].canAppeal, true);
        assert.equal((await service.minePenalties(new URL('http://local/'), token(3))).items.length, 0);
        await assert.rejects(
          () =>
            service.appeal(
              v.p.id,
              { idempotencyKey: randomUUID(), expectedLatestAppealId: null, reason: 'Not mine' },
              token(3)
            ),
          (e) => e.code === 'NOT_FOUND'
        );
        await assert.rejects(
          () => service.appeals(new URL('http://local/'), token(1)),
          (e) => e.code === 'FORBIDDEN'
        );
      }
    );
    let a;
    await check(
      'parallel duplicate/different-key submissions create one pending and one private audit',
      async () => {
        const body = {
          idempotencyKey: randomUUID(),
          expectedLatestAppealId: null,
          reason: 'Synthetic documented circumstances'
        };
        const results = await Promise.all([
          service.appeal(v.p.id, body, token(1)),
          service.appeal(v.p.id, body, token(1))
        ]);
        a = results[0].appeal;
        assert.equal(results.filter((x) => x.replayed).length, 1);
        await assert.rejects(
          () => submit(v),
          (e) => e.code === 'CONFLICT'
        );
        assert.equal(
          await f.db.activityPenaltyAppeal.count({ where: { penaltyId: v.p.id, status: 'PENDING' } }),
          1
        );
        assert.equal(
          await f.db.accountAudit.count({
            where: { action: 'PENALTY_APPEAL_SUBMITTED', targetAccountId: f.ids[1] }
          }),
          1
        );
        assert.equal((await balance(1)).activityPoints, 1);
      }
    );
    await check(
      'database enforces one pending and private result route including null registration',
      async () => {
        await assert.rejects(() =>
          f.db.activityPenaltyAppeal.create({
            data: {
              penaltyId: v.p.id,
              accountId: f.ids[1],
              reason: 'Duplicate',
              submissionKey: randomUUID(),
              submissionFingerprint: 'synthetic'
            }
          })
        );
        await assert.rejects(() =>
          f.db.activityOutbox.create({
            data: {
              eventKey: randomUUID(),
              activityId: v.a.id,
              kind: 'PENALTY_APPEAL_RESULT',
              channel: 'QQ',
              recipientId: f.ids[1]
            }
          })
        );
        await assert.rejects(() =>
          f.db.activityOutbox.create({
            data: {
              eventKey: randomUUID(),
              activityId: v.a.id,
              kind: 'PENALTY_APPEAL_RESULT',
              channel: 'IN_APP'
            }
          })
        );
      }
    );
    let b;
    await check(
      'rejection replays once and supplemental reapplication preserves old result and stable latest ordering',
      async () => {
        const body = decision({ decision: 'REJECT' });
        await decide(a, body);
        assert.equal((await decide(a, body)).replayed, true);
        await assert.rejects(
          () => submit(v, { expectedLatestAppealId: a.id }),
          (e) => e.code === 'VALIDATION_ERROR'
        );
        b = (await submit(v, { expectedLatestAppealId: a.id, reason: 'Supplemental synthetic evidence' }))
          .appeal;
        const list = await service.minePenalties(new URL('http://local/'), token(1));
        assert.equal(list.items[0].latestAppeal.id, b.id);
        assert.equal(list.items[0].expiresAt, '2030-06-08T11:00:00.000Z');
        assert.equal(await f.db.activityPenaltyAppeal.count({ where: { penaltyId: v.p.id } }), 2);
        assert.equal((await balance(1)).activityPoints, 1);
      }
    );
    await check(
      'pending approval after seven days reverses once without restoring withdrawn registration',
      async () => {
        now = new Date('2030-06-10T11:00:00Z');
        const body = decision();
        await decide(b, body);
        assert.equal((await decide(b, body)).replayed, true);
        await assert.rejects(
          () => decide(b, decision()),
          (e) => e.code === 'CONFLICT'
        );
        assert.equal((await balance(1)).activityPoints, 0);
        assert.equal(
          (await f.db.activityRegistration.findUniqueOrThrow({ where: { id: v.r.id } })).status,
          'WITHDRAWN'
        );
        assert.equal(await f.db.activityScoreChange.count({ where: { eventKey: 'reverse:' + v.p.id } }), 1);
      }
    );
    const c = await make(3, true, 1),
      ca = (await submit(c)).appeal;
    await check(
      'late rejection settles overdue natural decay and sends current restriction state',
      async () => {
        now = new Date('2030-06-10T11:00:00Z');
        await decide(ca, decision({ decision: 'REJECT' }));
        assert.equal((await balance(3)).activityPoints, 2);
        const event = await f.db.activityOutbox.findUniqueOrThrow({
          where: { eventKey: 'penalty-appeal-result:' + ca.id },
          include: { mockDelivery: true }
        });
        assert.equal(event.registrationId, null);
        assert.equal(event.channel, 'IN_APP');
        assert.equal(event.payload.points, 2);
        assert.equal(event.payload.restricted, false);
        assert.ok(event.mockDelivery);
        assert.ok((await f.db.activity.findUniqueOrThrow({ where: { id: c.a.id } })).cancelledAt);
      }
    );
    const r = await make(4),
      ra = (await submit(r)).appeal;
    await check(
      'real transaction rolls reversal decision audit and outbox back together on notification failure',
      async () => {
        const proxy = new Proxy(f.db, {
            get(target, key) {
              if (key === '$transaction')
                return (fn, options) =>
                  target.$transaction(
                    (tx) =>
                      fn(
                        new Proxy(tx, {
                          get(t, k) {
                            if (k === 'activityOutbox')
                              return {
                                ...t.activityOutbox,
                                create: async () => {
                                  throw Error('Synthetic result failure');
                                }
                              };
                            return t[k];
                          }
                        })
                      ),
                    options
                  );
              return target[key];
            }
          }),
          fault = new ActivityPenaltyAppealService(authFor(proxy)),
          body = decision();
        await assert.rejects(() => fault.decide(ra.id, body, token(2)), /Synthetic result failure/);
        assert.equal(
          (await f.db.activityPenaltyAppeal.findUniqueOrThrow({ where: { id: ra.id } })).status,
          'PENDING'
        );
        assert.equal(
          (await f.db.activityPenalty.findUniqueOrThrow({ where: { id: r.p.id } })).reversedAt,
          null
        );
        assert.equal((await balance(4)).activityPoints, 1);
        await decide(ra, body);
        assert.equal((await balance(4)).activityPoints, 0);
        assert.equal(
          await f.db.activityOutbox.count({ where: { eventKey: 'penalty-appeal-result:' + ra.id } }),
          1
        );
      }
    );
    const edge = await make(5);
    const edgeBody = {
      idempotencyKey: randomUUID(),
      expectedLatestAppealId: null,
      reason: 'At final millisecond'
    };
    await check('exact seven-day cutoff rejects new request but successful retry is durable', async () => {
      now = new Date(edge.p.createdAt.getTime() + 7 * 86400000 - 1);
      const first = await service.appeal(edge.p.id, edgeBody, token(5));
      now = new Date(+now + 1);
      assert.equal((await service.appeal(edge.p.id, edgeBody, token(5))).replayed, true);
      await decide(first.appeal, decision({ decision: 'REJECT' }));
      await assert.rejects(
        () => submit(edge, { expectedLatestAppealId: first.appeal.id, reason: 'Too late' }),
        (e) => e.code === 'FORBIDDEN'
      );
    });
    const race = await make(6),
      raceA = (await submit(race)).appeal;
    await f.db.account.update({ where: { id: f.ids[0] }, data: { adminRole: 'ADMIN' } });
    await check(
      'two real administrators racing approve/reject cannot duplicate reversal or notifications',
      async () => {
        const out = await Promise.allSettled([
          decide(raceA, decision(), 2),
          decide(raceA, decision({ decision: 'REJECT' }), 0)
        ]);
        assert.equal(out.filter((x) => x.status === 'fulfilled').length, 1);
        assert.equal(out.find((x) => x.status === 'rejected').reason.code, 'CONFLICT');
        assert.equal(
          await f.db.activityOutbox.count({ where: { eventKey: 'penalty-appeal-result:' + raceA.id } }),
          1
        );
        assert.equal(
          await f.db.accountAudit.count({
            where: {
              targetAccountId: f.ids[6],
              action: { in: ['PENALTY_APPEAL_APPROVED', 'PENALTY_APPEAL_REJECTED'] }
            }
          }),
          1
        );
      }
    );
    const worker = await make(7, true),
      wa = (await submit(worker)).appeal;
    await check(
      'completion worker and approval serialize on recipient without deadlock or duplicate points',
      async () => {
        now = new Date('2030-06-01T10:00:00Z');
        const other = (
          await basic.create(
            input({
              idempotencyKey: randomUUID(),
              category: 'SOCIAL',
              dutySelection: null,
              seats: [{ kind: 'ANY' }]
            }),
            token(0)
          )
        ).activity;
        await basic.register(other.id, { seatId: other.seats[0].id, job: null }, token(7));
        const reg = await f.db.activityRegistration.findFirstOrThrow({
          where: { activityId: other.id, accountId: f.ids[7] }
        });
        now = new Date(other.startsAt);
        await attendance.record(
          other.id,
          {
            idempotencyKey: randomUUID(),
            registrationId: reg.id,
            expectedAttendanceRevision: 0,
            status: 'PRESENT'
          },
          token(0)
        );
        now = new Date(other.endsAt);
        await Promise.all([processActivityCompletions(f.db, now), decide(wa)]);
        assert.equal((await balance(7)).activityPoints, 0);
        assert.equal(await f.db.activityCompletion.count({ where: { registrationId: reg.id } }), 1);
        assert.equal(
          await f.db.activityScoreChange.count({ where: { eventKey: 'reverse:' + worker.p.id } }),
          1
        );
      }
    );
    const replay = await make(8),
      replayA = (await submit(replay)).appeal;
    let absence;
    await check('later absence correction cannot resurrect an earlier reversed withdrawal', async () => {
      now = new Date('2030-06-01T14:00:00Z');
      absence = await f.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${f.ids[8]} FOR NO KEY UPDATE`;
        const p = await tx.activityPenalty.create({
          data: {
            eventKey: randomUUID(),
            accountId: f.ids[8],
            activityId: replay.a.id,
            reason: 'NO_SHOW',
            points: 2,
            createdAt: now
          }
        });
        await addActivityPenaltyPoints(tx, f.ids[8], 2, now, p.eventKey, p.id);
        return p;
      });
      await decide(replayA);
      assert.equal((await balance(8)).activityPoints, 2);
      await f.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${f.ids[8]} FOR NO KEY UPDATE`;
        await reverseAttendancePenalty(tx, f.ids[8], absence.id, now, 'VERIFIED');
      });
      assert.equal((await balance(8)).activityPoints, 0);
    });
  } finally {
    await f.cleanup();
  }
});
