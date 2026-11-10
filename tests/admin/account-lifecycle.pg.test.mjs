// 账号停用与恢复（真实 PostgreSQL）：只有超级管理员能操作，不能停用自己和其他超管；
// 停用时连带取消活动、报名，解散 / 移出固定队，作废会话；恢复不复原任何关系；审计只追加。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, body, effects, state, noPrivate, diagnostic } from './support/lifecycle-fixture.mjs';

test('账号停用与恢复：真实 PostgreSQL', async (t) => {
  const f = await fixture(),
    { db, service, ids, tokens } = f;
  const preview = (key = 'target', value = false, actor = 'owner') =>
    service.preview(ids[key], new URL('http://test?active=' + (value ? '1' : '0')), tokens[actor]);
  const reject = (fn, status) => assert.rejects(fn, (e) => e.status === status);
  const check = (name, fn) => t.test(name, fn);
  const change = async (key, value, extra = {}) =>
    service.change(ids[key], body(await preview(key, value), extra), tokens.owner);
  async function waitFor(kind) {
    let waiting = false;
    for (let n = 0; n < 250; n++) {
      const [row] = await db.$queryRawUnsafe(
        'SELECT count(*)::int AS count FROM pg_locks WHERE locktype=$1 AND NOT granted',
        kind
      );
      if (row.count) {
        waiting = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(waiting, 'real PostgreSQL ' + kind + ' wait observed');
  }
  async function installWait(table) {
    await db.$executeRawUnsafe(
      "CREATE OR REPLACE FUNCTION lifecycle_test_pg_wait() RETURNS trigger LANGUAGE plpgsql AS $artzoo$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-pg-final',0)); RETURN NEW; END; $artzoo$"
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER lifecycle_test_pg_wait BEFORE INSERT ON "' +
        table +
        '" FOR EACH ROW EXECUTE FUNCTION lifecycle_test_pg_wait()'
    );
  }
  async function removeWait(table) {
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS lifecycle_test_pg_wait ON "' + table + '"');
    await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS lifecycle_test_pg_wait()');
  }
  try {
    await check(
      'super-only search preview change and audits reject guest member friend ordinary admin',
      async () => {
        const awaitablePreview = await preview(),
          before = await state(db);
        for (const actor of [null, 'admin', 'member', 'friend']) {
          const token = actor ? tokens[actor] : null,
            status = actor ? 403 : 401;
          await reject(() => service.accounts(new URL('http://test?query=合成'), token), status);
          await reject(() => service.audits(new URL('http://test?page=1'), token), status);
          await reject(() => service.preview(ids.target, new URL('http://test?active=0'), token), status);
          await reject(() => service.change(ids.target, body(awaitablePreview), token), status);
        }
        assert.deepEqual(await state(db), before);
        for (const key of ['owner', 'owner2']) await reject(() => preview(key), 403);
        const found = await service.accounts(
          new URL('http://test?query=' + encodeURIComponent(f.people.target.displayName)),
          tokens.owner
        );
        noPrivate(found);
        assert.ok(JSON.stringify(found).includes(ids.target));
      }
    );
    await check(
      'strict fields confirmation reason UUID and preview payload validate without writes',
      async () => {
        const p = await preview(),
          input = body(p),
          before = await state(db);
        for (const extra of [
          { confirmed: false },
          { active: 'false' },
          { expectedRevision: -1 },
          { previewFingerprint: 'invalid' },
          { reason: '' },
          { reason: '测'.repeat(1001) },
          { idempotencyKey: 'invalid' },
          { unexpected: true }
        ])
          await reject(() => service.change(ids.target, { ...input, ...extra }, tokens.owner), 400);
        assert.deepEqual(await state(db), before);
      }
    );
    await check('impact changes and a wall boundary invalidate stale previews atomically', async () => {
      const p = await preview();
      await f.activity({ kind: 'future' });
      let before = await state(db);
      await reject(() => service.change(ids.target, body(p), tokens.owner), 409);
      assert.deepEqual(await state(db), before);
      const sameCount = await preview();
      const existing = await db.activity.findFirstOrThrow({
        where: { organizerId: ids.other, endsAt: { gt: f.now } }
      });
      await db.activity.update({ where: { id: existing.id }, data: { revision: { increment: 1 } } });
      before = await state(db);
      await reject(() => service.change(ids.target, body(sameCount), tokens.owner), 409);
      assert.deepEqual(await state(db), before);
      const edge = await f.activity({ kind: 'ongoing' }),
        q = await preview();
      f.now = edge.endsAt;
      before = await state(db);
      await reject(() => service.change(ids.target, body(q), tokens.owner), 409);
      assert.deepEqual(await state(db), before);
      f.now = new Date('2030-12-01T12:00:00Z');
    });
    let graph,
      deactivated,
      expectedSessionMembers,
      excludedSessionMembers = [];
    await check(
      'deactivation cancels eligible participation and owned activity while preserving ended histories and points',
      async () => {
        graph = await f.impactFixture();
        const future = graph.otherTeam.sessions.find((s) => s.kind === 'future');
        await db.teamSession.update({ where: { id: future.id }, data: { timeVersion: 1 } });
        future.timeVersion = 1;
        await db.teamSessionMember.update({
          where: { id: future.sessionMember.id },
          data: { timeVersion: 1 }
        });
        future.sessionMember.timeVersion = 1;
        await db.teamSessionSubstitute.updateMany({
          where: { sessionId: future.id },
          data: { timeVersion: 1 }
        });
        for (const sub of graph.substitutes.filter((s) => s.sessionId === future.id)) sub.timeVersion = 1;
        excludedSessionMembers.push(
          await db.teamSessionMember.create({
            data: {
              sessionId: future.id,
              timeVersion: 0,
              membershipId: graph.otherTeam.membership.id,
              accountId: ids.target,
              position: 4,
              job: '武士',
              confirmedStartsAt: future.startsAt,
              confirmedEndsAt: future.endsAt
            }
          })
        );
        const proposed = await db.teamSession.create({
          data: { teamId: graph.otherTeam.id, startsAt: f.time(48), endsAt: f.time(50), state: 'PROPOSED' }
        });
        excludedSessionMembers.push(
          await db.teamSessionMember.create({
            data: {
              sessionId: proposed.id,
              timeVersion: 0,
              membershipId: graph.otherTeam.membership.id,
              accountId: ids.target,
              position: 4,
              job: '武士',
              confirmedStartsAt: proposed.startsAt,
              confirmedEndsAt: proposed.endsAt
            }
          })
        );
        expectedSessionMembers = [
          {
            id: future.sessionMember.id,
            sessionId: future.id,
            teamId: graph.otherTeam.id,
            teamName: graph.otherTeam.name,
            timeVersion: 1,
            startsAt: future.startsAt.toISOString(),
            endsAt: future.endsAt.toISOString(),
            beforeState: 'MEMBER',
            afterState: 'NEEDS_SUBSTITUTE'
          }
        ];
        const before = await effects(db),
          account = await db.account.findUniqueOrThrow({ where: { id: ids.target } }),
          statusBefore = await db.lotteryAccountStatus.findUniqueOrThrow({
            where: { accountId: ids.target }
          });
        const p = await preview();
        noPrivate(p);
        assert.equal(p.active, false);
        assert.ok(p.impact && p.previewFingerprint);
        for (const a of graph.activities)
          assert.equal(
            p.impact.registrations.some((r) => r.id === a.registration.id),
            a.endsAt > f.now
          );
        for (const a of graph.owned)
          assert.equal(
            p.impact.activities.some((r) => r.id === a.id),
            a.endsAt > f.now
          );
        assert.ok(p.impact.dissolvedTeams.some((t) => t.id === graph.ownedTeam.id));
        assert.ok(p.impact.memberships.some((m) => m.id === graph.otherTeam.membership.id));
        assert.ok(p.impact.applications.some((a) => a.id === graph.pending.id));
        assert.deepEqual(p.impact.sessionMembers, expectedSessionMembers);
        assert.equal(
          p.impact.sessionsRevoked,
          await db.accountSession.count({ where: { accountId: ids.target, revokedAt: null } })
        );
        deactivated = await service.change(ids.target, body(p), tokens.owner);
        assert.equal(deactivated.account.active, false);
        assert.equal(deactivated.account.lifecycleRevision, statusBefore.revision + 1);
        const current = await db.account.findUniqueOrThrow({ where: { id: ids.target } });
        const preserved = (value) =>
          Object.fromEntries(
            Object.entries(value).filter(
              ([key]) => !['active', 'lifecycleRevision', 'updatedAt'].includes(key)
            )
          );
        assert.deepEqual(preserved(current), preserved(account));
        assert.deepEqual(await effects(db), before);
        for (const a of graph.activities) {
          const row = await db.activityRegistration.findUniqueOrThrow({ where: { id: a.registration.id } });
          assert.deepEqual(row.seatSnapshot, a.registration.seatSnapshot);
          assert.equal(row.attendanceStatus, a.registration.attendanceStatus);
          assert.equal(row.attendanceRevision, 2);
          if (a.endsAt > f.now) {
            assert.notEqual(row.status, 'ACTIVE');
            assert.equal(row.seatId, null);
            assert.ok(row.exitedAt);
          } else assert.deepEqual(row, a.registration);
          assert.deepEqual(
            (await db.activity.findUniqueOrThrow({ where: { id: a.id } })).cancelledAt,
            a.cancelledAt
          );
        }
        for (const a of graph.owned) {
          const row = await db.activity.findUniqueOrThrow({ where: { id: a.id } }),
            registration = await db.activityRegistration.findUniqueOrThrow({
              where: { id: a.registration.id }
            });
          if (a.endsAt > f.now) {
            assert.ok(row.cancelledAt);
            assert.notEqual(registration.status, 'ACTIVE');
            assert.equal(registration.seatId, null);
          } else {
            const { seat, registration: originalRegistration, ...originalActivity } = a;
            assert.deepEqual(row, originalActivity);
            assert.deepEqual(registration, originalRegistration);
          }
        }
        const mixedSeries = await db.activitySeries.findUniqueOrThrow({
          where: { id: graph.ownedSeries.id }
        });
        assert.equal(mixedSeries.state, 'FORMED');
        assert.equal(mixedSeries.cancelledAt, null);
        const mixedPeriods = graph.owned
          .filter((a) => a.seriesId === graph.ownedSeries.id)
          .sort((a, b) => a.periodNumber - b.periodNumber);
        assert.equal(
          mixedPeriods[0].endsAt < f.now,
          true,
          'owned series starts with an ended historical first period'
        );
        const futureSeries = await db.activitySeries.findUniqueOrThrow({
          where: { id: graph.allFutureOwnedSeries.id }
        });
        assert.equal(futureSeries.state, 'CANCELLED');
        assert.ok(futureSeries.cancelledAt);
        assert.equal(await db.accountSession.count({ where: { accountId: ids.target, revokedAt: null } }), 0);
        const lottery = await db.lotteryAccountStatus.findUniqueOrThrow({ where: { accountId: ids.target } });
        assert.equal(lottery.active, false);
        assert.equal(await db.accountLifecycleAudit.count({ where: { targetAccountId: ids.target } }), 1);
      }
    );
    await check(
      'owned team future-only cancellation and other-team removal preserve ongoing snapshots',
      async () => {
        const audit = await db.accountLifecycleAudit.findUniqueOrThrow({
          where: { id: deactivated.auditId }
        });
        assert.deepEqual(audit.impact.sessionMembers, expectedSessionMembers);
        assert.equal(audit.beforeActive, true);
        assert.equal(audit.afterActive, false);
        const command = await db.teamCommand.findFirstOrThrow({
          where: { teamId: graph.otherTeam.id, kind: 'ACCOUNT_DISABLED_REMOVE_RELATIONS' }
        });
        assert.deepEqual(command.after.affected.sessionMembers, expectedSessionMembers);
        for (const member of excludedSessionMembers)
          assert.deepEqual(
            await db.teamSessionMember.findUniqueOrThrow({ where: { id: member.id } }),
            member
          );
        const owned = await db.fixedTeam.findUniqueOrThrow({ where: { id: graph.ownedTeam.id } });
        assert.equal(owned.state, 'DISSOLVED');
        for (const s of graph.ownedTeam.sessions) {
          const row = await db.teamSession.findUniqueOrThrow({ where: { id: s.id } });
          if (s.startsAt > f.now) assert.equal(row.state, 'CANCELLED');
          else assert.equal(row.state, s.state);
        }
        const member = await db.teamMembership.findUniqueOrThrow({
          where: { id: graph.otherTeam.membership.id }
        });
        assert.notEqual(member.state, 'ACTIVE');
        assert.equal(member.seatId, null);
        assert.ok(member.leftAt);
        for (const s of graph.otherTeam.sessions) {
          const row = await db.teamSessionMember.findUniqueOrThrow({ where: { id: s.sessionMember.id } });
          if (s.startsAt > f.now) assert.equal(row.state, 'NEEDS_SUBSTITUTE');
          else assert.equal(row.state, s.sessionMember.state);
          assert.equal(row.job, s.sessionMember.job);
          assert.equal(row.confirmedStartsAt.toISOString(), s.startsAt.toISOString());
        }
        const cancelledApplication = await db.teamApplication.findUniqueOrThrow({
          where: { id: graph.pending.id }
        });
        assert.equal(cancelledApplication.state, 'CANCELLED');
        assert.ok(cancelledApplication.decidedAt);
        const checkViolation = (error) =>
          error?.meta?.driverAdapterError?.cause?.originalCode === '23514' ||
          String(error?.message).includes('23514');
        await assert.rejects(
          () => db.teamApplication.update({ where: { id: graph.pending.id }, data: { state: 'PENDING' } }),
          checkViolation
        );
        await assert.rejects(
          () => db.teamApplication.update({ where: { id: graph.pending.id }, data: { decidedAt: null } }),
          checkViolation
        );
        assert.deepEqual(
          await db.teamApplication.findUniqueOrThrow({ where: { id: graph.pending.id } }),
          cancelledApplication
        );
        for (const sub of graph.substitutes) {
          const row = await db.teamSessionSubstitute.findUniqueOrThrow({ where: { id: sub.id } });
          if (sub.confirmedStartsAt > f.now) assert.ok(row.endedAt);
          else assert.equal(row.endedAt, null);
        }
      }
    );
    await check(
      'restore changes activation only and never resurrects sessions seats activities memberships or notifications',
      async () => {
        const names = [
            'activity',
            'activityRegistration',
            'activitySeries',
            'fixedTeam',
            'teamMembership',
            'teamSession',
            'teamSessionMember',
            'teamSessionSubstitute',
            'teamApplication',
            'accountSession'
          ],
          before = await state(db),
          originalEffects = await effects(db);
        const result = await change('target', true);
        assert.equal(result.account.active, true);
        assert.equal(result.account.lifecycleRevision, 2);
        const after = await state(db);
        for (const name of names) assert.deepEqual(after[name], before[name]);
        assert.deepEqual(await effects(db), originalEffects);
        await reject(() => f.auth.requireAccount(db, tokens.target), 401);
        assert.equal(
          (await db.lotteryAccountStatus.findUniqueOrThrow({ where: { accountId: ids.target } })).active,
          true
        );
      }
    );
    await check(
      'concurrent same key writes one command one audit and modified payload conflicts',
      async () => {
        const input = body(await preview('friendTarget')),
          before = await db.accountLifecycleAudit.count();
        const result = await Promise.all([
          service.change(ids.friendTarget, input, tokens.owner),
          service.change(ids.friendTarget, input, tokens.owner)
        ]);
        assert.deepEqual(result.map((r) => r.replayed).sort(), [false, true]);
        assert.equal(new Set(result.map((r) => r.auditId)).size, 1);
        assert.equal(await db.accountLifecycleAudit.count(), before + 1);
        const snapshot = await state(db);
        assert.equal((await service.change(ids.friendTarget, input, tokens.owner)).replayed, true);
        assert.deepEqual(await state(db), snapshot);
        await reject(
          () =>
            service.change(ids.friendTarget, { ...input, reason: input.reason + ' changed' }, tokens.owner),
          409
        );
        assert.deepEqual(await state(db), snapshot);
      }
    );
    await check('ABA cannot reuse old revision or impact and audit rows remain append only', async () => {
      const old = await preview('target', false);
      await change('target', false);
      await change('target', true);
      const before = await state(db);
      await reject(() => service.change(ids.target, body(old), tokens.owner), 409);
      assert.deepEqual(await state(db), before);
      const audits = await service.audits(new URL('http://test?page=1&pageSize=10'), tokens.owner);
      noPrivate(audits);
      assert.ok(JSON.stringify(audits).includes(ids.target));
      const row = await db.accountLifecycleAudit.findFirstOrThrow();
      await assert.rejects(() =>
        db.accountLifecycleAudit.update({
          where: { id: row.id },
          data: { reason: 'forbidden synthetic rewrite' }
        })
      );
      await assert.rejects(() => db.accountLifecycleAudit.delete({ where: { id: row.id } }));
    });
    await check(
      'inactive targets cannot enter registered create acceptance add substitute or confirmation-copy paths',
      async () => {
        await change('target', false);
        const { TeamService } = await import('../../apps/web/server/teams/service.ts'),
          { ActivitySeriesService } = await import('../../apps/web/server/activities/series.ts');
        const teams = new TeamService(f.auth),
          seriesService = new ActivitySeriesService(f.auth);
        const command = (team, extra) => ({
          idempotencyKey: randomUUID(),
          expectedRevision: team.revision,
          ...extra
        });
        const createBody = {
          idempotencyKey: randomUUID(),
          name: '合成inactive guard',
          description: '合成说明',
          commonTimes: '',
          qqGroupId: null,
          seats: Array.from({ length: 8 }, (_, position) => ({
            position,
            requirement: { kind: 'ROLE', role: position < 2 ? 'TANK' : position < 4 ? 'HEALER' : 'DAMAGE' },
            memberId: position === 4 ? ids.target : null,
            memberJob: position === 4 ? '武士' : null
          }))
        };
        const empty = await f.team({ member: null }),
          stale = await f.team({ member: ids.target });
        const application = await db.teamApplication.create({
          data: {
            teamId: empty.id,
            seatId: empty.seats[4].id,
            accountId: ids.target,
            job: '武士',
            note: '合成陈旧申请'
          }
        });
        const proposed = await db.teamSession.create({
          data: { teamId: stale.id, startsAt: f.time(48), endsAt: f.time(50), state: 'PROPOSED' }
        });
        const series = await db.activitySeries.create({
          data: { weekdays: [1], durationMinutes: 120, totalPeriods: 2, state: 'RECRUITING' }
        });
        const first = await f.activity({
            mode: 'SERIES',
            seriesId: series.id,
            periodNumber: 1,
            registered: ids.target
          }),
          second = await f.activity({
            mode: 'SERIES',
            seriesId: series.id,
            periodNumber: 2,
            registered: null
          });
        const calls = [
          () => teams.create(createBody, tokens.other),
          () =>
            teams.decide(
              empty.id,
              command(empty, { applicationId: application.id, decision: 'ACCEPT' }),
              tokens.other
            ),
          () =>
            teams.addMember(
              empty.id,
              command(empty, { position: 4, memberId: ids.target, job: '武士' }),
              tokens.other
            ),
          () =>
            teams.substitute(
              empty.id,
              command(empty, {
                sessionId: empty.sessions[0].id,
                position: 4,
                kind: 'REGISTERED',
                accountId: ids.target,
                job: '武士'
              }),
              tokens.other
            ),
          () => teams.confirm(stale.id, command(stale, { sessionId: proposed.id }), tokens.other),
          () =>
            seriesService.confirm(
              first.id,
              { idempotencyKey: randomUUID(), expectedRevision: first.revision },
              tokens.other
            )
        ];
        for (const call of calls) {
          const before = await state(db),
            beforeEffects = await effects(db);
          await reject(call, 400);
          assert.deepEqual(await state(db), before);
          assert.deepEqual(await effects(db), beforeEffects);
        }
        assert.equal(await db.activityRegistration.count({ where: { activityId: second.id } }), 0);
      }
    );
    await check(
      'business target share lock wins first then stale lifecycle preview rolls back after re-enumeration',
      async () => {
        await change('target', true);
        const { TeamService } = await import('../../apps/web/server/teams/service.ts'),
          teams = new TeamService(f.auth),
          team = await f.team({ member: null });
        const input = body(await preview()),
          add = {
            idempotencyKey: randomUUID(),
            expectedRevision: team.revision,
            position: 4,
            memberId: ids.target,
            job: '武士'
          };
        await installWait('TeamCommand');
        let release, ready;
        const acquired = new Promise((r) => (ready = r)),
          unblock = new Promise((r) => (release = r));
        const holder = db.$transaction(
          async (tx) => {
            await tx.$queryRawUnsafe(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text',
              'lifecycle-pg-final'
            );
            ready();
            await unblock;
          },
          { timeout: 20000 }
        );
        await acquired;
        const adding = teams.addMember(team.id, add, tokens.other).then(
          (value) => ({ value }),
          (error) => ({ error })
        );
        try {
          await waitFor('advisory');
          const stopping = service.change(ids.target, input, tokens.owner).then(
            (value) => ({ value }),
            (error) => ({ error })
          );
          await waitFor('transactionid');
          release();
          await holder;
          assert.equal((await adding).error, undefined);
          assert.equal((await stopping).error?.status, 409);
          assert.equal(
            (await db.lotteryAccountStatus.findUniqueOrThrow({ where: { accountId: ids.target } })).active,
            true
          );
          assert.equal(
            await db.teamMembership.count({
              where: { teamId: team.id, accountId: ids.target, state: 'ACTIVE' }
            }),
            1
          );
        } finally {
          release();
          await holder;
          await removeWait('TeamCommand');
        }
        await change('target', false);
        assert.equal(
          await db.teamMembership.count({
            where: { teamId: team.id, accountId: ids.target, state: 'ACTIVE' }
          }),
          0
        );
      }
    );
    await check(
      'lifecycle target lock wins first and unrelated-team NOWAIT conflict rolls back the business operation',
      async () => {
        await change('target', true);
        const { TeamService } = await import('../../apps/web/server/teams/service.ts'),
          teams = new TeamService(f.auth),
          team = await f.team({ member: null }),
          input = body(await preview());
        await installWait('AccountLifecycleAudit');
        let release, ready;
        const acquired = new Promise((r) => (ready = r)),
          unblock = new Promise((r) => (release = r));
        const holder = db.$transaction(
          async (tx) => {
            await tx.$queryRawUnsafe(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text',
              'lifecycle-pg-final'
            );
            ready();
            await unblock;
          },
          { timeout: 20000 }
        );
        await acquired;
        const stopping = service.change(ids.target, input, tokens.owner).then(
          (value) => ({ value }),
          (error) => ({ error })
        );
        try {
          await waitFor('advisory');
          await assert.rejects(
            () =>
              db.$transaction((tx) =>
                tx.$queryRawUnsafe('SELECT id FROM "Account" WHERE id=$1 FOR SHARE NOWAIT', ids.target)
              ),
            (error) => error?.meta?.code === '55P03' || String(error?.message).includes('55P03')
          );
          const before = await db.fixedTeam.findUniqueOrThrow({ where: { id: team.id } }),
            commandCount = await db.teamCommand.count(),
            noticeCount = await db.teamNotification.count();
          const started = Date.now();
          await reject(
            () =>
              teams.addMember(
                team.id,
                {
                  idempotencyKey: randomUUID(),
                  expectedRevision: team.revision,
                  position: 4,
                  memberId: ids.target,
                  job: '武士'
                },
                tokens.other
              ),
            409
          );
          assert.ok(Date.now() - started < 5000, 'target NOWAIT must not hang behind lifecycle');
          assert.deepEqual(await db.fixedTeam.findUniqueOrThrow({ where: { id: team.id } }), before);
          assert.equal(await db.teamMembership.count({ where: { teamId: team.id } }), 0);
          assert.equal(await db.teamCommand.count(), commandCount);
          assert.equal(await db.teamNotification.count(), noticeCount);
          release();
          await holder;
          assert.equal((await stopping).error, undefined);
        } finally {
          release();
          await holder;
          await removeWait('AccountLifecycleAudit');
        }
      }
    );
    await check(
      'final Audit and Command SQL waits crossing an affected end time roll back with a still-valid actor session',
      async () => {
        await change('friendTarget', true);
        const initialClock = f.now;
        for (const table of ['AccountLifecycleAudit', 'AccountLifecycleCommand']) {
          const edge = await f.activity({ kind: 'ongoing', registered: ids.friendTarget }),
            input = body(await preview('friendTarget', false)),
            before = await state(db),
            beforeEffects = await effects(db);
          await installWait(table);
          let release, ready;
          const acquired = new Promise((r) => (ready = r)),
            unblock = new Promise((r) => (release = r));
          const holder = db.$transaction(
            async (tx) => {
              await tx.$queryRawUnsafe(
                'SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text',
                'lifecycle-pg-final'
              );
              ready();
              await unblock;
            },
            { timeout: 20000 }
          );
          await acquired;
          const writing = service.change(ids.friendTarget, input, tokens.owner).then(
            (value) => ({ value }),
            (error) => ({ error })
          );
          try {
            await waitFor('advisory');
            f.now = edge.endsAt;
            assert.ok(f.now < new Date('2035-01-01T00:00:00Z'));
            release();
            await holder;
            assert.equal(
              (await writing).error?.status,
              409,
              'final ' + table + ' boundary must reject after SQL wait'
            );
            assert.deepEqual(await state(db), before);
            assert.deepEqual(await effects(db), beforeEffects);
          } finally {
            release();
            await holder;
            await removeWait(table);
            f.now = initialClock;
          }
        }
      }
    );
  } finally {
    await f.close();
  }
});
