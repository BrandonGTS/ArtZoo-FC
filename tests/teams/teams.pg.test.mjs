import { test } from 'node:test';
import { readFiveCategories } from './support/messages-five-categories.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  teamFixture,
  body,
  cleanBody,
  createTeamWithMembers,
  command,
  beijing,
  noPrivate
} from './support/teams-fixtures.mjs';
test('固定队：创建、加入、排期与权限（数据库）', async (t) => {
  const f = await teamFixture();
  let clock = new Date('2030-12-01T00:00:00Z');
  const { AccountService } = await import('../../apps/web/server/auth/service.ts');
  const { TeamService } = await import('../../apps/web/server/teams/service.ts');
  const { MessageService } = await import('../../apps/web/server/messages/service.ts');
  const { mainlandChinaPhone, unavailableSms } = await import('../../apps/web/server/auth/ports.ts');
  const auth = new AccountService(f.db, {
      phone: mainlandChinaPhone,
      sms: unavailableSms,
      environment: 'test',
      now: () => clock
    }),
    service = new TeamService(auth),
    messages = new MessageService(auth),
    token = (i) => f.tokens[i];
  const check = (name, fn) => t.test(name, fn);
  const create = async (ids = [f.ids[0], f.ids[1], f.ids[2]], group = null) =>
    await createTeamWithMembers(service, f, ids, group);
  const fetchTeam = (id) => service.get(id, token(0));
  const times = (n = 0) => ({
    startsAt: beijing(new Date(Date.parse('2030-12-30T12:00:00Z') + n * 86400000)),
    endsAt: beijing(new Date(Date.parse('2030-12-30T14:00:00Z') + n * 86400000))
  });
  const propose = async (team, n = 0) =>
    (await service.propose(team.id, command(team, times(n)), token(0))).team;
  const ordinary = async () => ({
    activities: await f.db.activity.count(),
    registrations: await f.db.activityRegistration.count(),
    penalties: await f.db.activityPenalty.count(),
    scores: await f.db.activityScoreChange.count(),
    outbox: await f.db.activityOutbox.count()
  });
  const before = await ordinary();
  try {
    await check(
      'formal creator only; score restriction never applies to independent fixed team',
      async () => {
        await assert.rejects(
          () => service.create(body(), token(5)),
          (e) => e.code === 'FORBIDDEN'
        );
        await f.db.account.update({
          where: { id: f.ids[0] },
          data: { activityPoints: 3, activityDecayAt: new Date('2031-01-01T00:00:00Z') }
        });
        const t = await create();
        assert.equal(t.seats.length, 8);
        assert.equal(t.seats.filter((s) => s.member).length, 3);
        noPrivate(t);
        await f.db.account.update({
          where: { id: f.ids[0] },
          data: { activityPoints: 0, activityDecayAt: null }
        });
        const unknown = body([randomUUID()]);
        await assert.rejects(
          () => service.create(unknown, token(0)),
          (e) => e.code === 'VALIDATION_ERROR'
        );
      }
    );
    await check('create retry under concurrency returns one team and one set of notifications', async () => {
      const b = cleanBody(),
        r = await Promise.all([service.create(b, token(0)), service.create(b, token(0))]);
      assert.equal(r[0].team.id, r[1].team.id);
      assert.equal(r.filter((x) => x.replayed).length, 1);
      assert.equal(await f.db.teamNotification.count({ where: { teamId: r[0].team.id } }), 0);
      await assert.rejects(
        () => service.create({ ...b, name: 'Changed' }, token(0)),
        (e) => e.code === 'CONFLICT'
      );
    });
    await check('friend application does not occupy; creator accepts and rejection never joins', async () => {
      let t = await create();
      t = (
        await service.apply(t.id, command(t, { position: 4, job: '武士', note: 'Synthetic note' }), token(5))
      ).team;
      assert.equal(t.sessions, null);
      assert.equal(t.seats[4].member, null);
      assert.equal(t.applications.length, 1);
      const app = t.applications[0];
      await assert.rejects(
        () => service.apply(t.id, command(t, { position: 4, job: '武士', note: 'Synthetic note' }), token(5)),
        (e) => e.code === 'CONFLICT'
      );
      await assert.rejects(
        () => service.decide(t.id, command(t, { applicationId: app.id, decision: 'ACCEPT' }), token(1)),
        (e) => e.code === 'FORBIDDEN'
      );
      t = (await service.decide(t.id, command(t, { applicationId: app.id, decision: 'ACCEPT' }), token(0)))
        .team;
      assert.equal(t.seats[4].member.person.id, f.ids[5]);
      assert.equal((await service.get(t.id, token(5))).isMember, true);
      t = (
        await service.apply(t.id, command(t, { position: 5, job: '武士', note: 'Synthetic note' }), token(6))
      ).team;
      const ownApp = t.applications[0];
      t = (await service.decide(t.id, command(t, { applicationId: ownApp.id, decision: 'REJECT' }), token(0)))
        .team;
      assert.equal(t.seats[5].member, null);
      assert.equal(await f.db.teamMembership.count({ where: { teamId: t.id, accountId: f.ids[6] } }), 0);
    });
    await check('same-seat approval race has one winner and ends competing pending application', async () => {
      let t = await create();
      t = (
        await service.apply(t.id, command(t, { position: 4, job: '武士', note: 'Synthetic note' }), token(6))
      ).team;
      t = (
        await service.apply(t.id, command(t, { position: 4, job: '武士', note: 'Synthetic note' }), token(7))
      ).team;
      t = await fetchTeam(t.id);
      const results = await Promise.allSettled(
        t.applications
          .filter((a) => a.state === 'PENDING')
          .map((a) => service.decide(t.id, command(t, { applicationId: a.id, decision: 'ACCEPT' }), token(0)))
      );
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'CONFLICT');
      assert.equal(
        await f.db.teamMembership.count({ where: { teamId: t.id, position: 4, state: 'ACTIVE' } }),
        1
      );
      assert.equal(await f.db.teamApplication.count({ where: { teamId: t.id, state: 'PENDING' } }), 0);
      assert.equal(await f.db.teamApplication.count({ where: { teamId: t.id, state: 'CANCELLED' } }), 1);
    });
    await check(
      'only creator manages even if another member is admin; direct add validates vacancies and jobs',
      async () => {
        let t = await create();
        await f.db.account.update({ where: { id: f.ids[3] }, data: { adminRole: 'ADMIN' } });
        for (const actor of [1, 3, 5])
          await assert.rejects(
            () => service.propose(t.id, command(t, times()), token(actor)),
            (e) => e.code === 'FORBIDDEN'
          );
        await assert.rejects(
          () =>
            service.addMember(t.id, command(t, { position: 4, memberId: f.ids[5], job: '骑士' }), token(0)),
          (e) => e.code === 'VALIDATION_ERROR'
        );
        await assert.rejects(
          () =>
            service.addMember(t.id, command(t, { position: 4, memberId: f.ids[1], job: '武士' }), token(0)),
          (e) => e.code === 'CONFLICT'
        );
        t = (
          await service.addMember(
            t.id,
            command(t, { position: 4, memberId: f.ids[5], job: '武士' }),
            token(0)
          )
        ).team;
        assert.equal(t.seats[4].member.person.id, f.ids[5]);
        await f.db.account.update({ where: { id: f.ids[3] }, data: { adminRole: 'NONE' } });
      }
    );
    await check(
      'outsider sees recruitment and own application only, never internal sessions or other notes',
      async () => {
        let t = await propose(await create());
        t = (
          await service.apply(
            t.id,
            command(t, { position: 4, job: '武士', note: 'private applicant' }),
            token(6)
          )
        ).team;
        t = await fetchTeam(t.id);
        const outsider = await service.get(t.id, token(7));
        assert.equal(outsider.sessions, null);
        assert.deepEqual(outsider.applications, []);
        assert.equal(outsider.qqGroupId, null);
        noPrivate(outsider);
        assert.equal((await service.get(t.id, token(6))).applications.length, 1);
        assert.ok(Array.isArray((await service.get(t.id, token(1))).sessions));
        assert.equal((await service.get(t.id, token(1))).applications.length, 1);
        assert.ok(
          (await service.get(t.id, token(1))).applications.every(
            (a) => a.person.id === f.ids[1] && a.state === 'ACCEPTED'
          )
        );
        assert.ok(!(await service.list(true, token(1))).items.some((i) => i.id === t.id));
        t = (await service.completeRecruitment(t.id, command(t, { confirmed: true }), token(0))).team;
        assert.ok((await service.list(true, token(1))).items.some((i) => i.id === t.id));
        assert.ok(!(await service.list(true, token(7))).items.some((i) => i.id === t.id));
      }
    );
    await check(
      'more than two future sessions permitted; no automatic vote confirmation and roster copied explicitly',
      async () => {
        let t = await create();
        for (let i = 0; i < 4; i++) t = await propose(t, i);
        assert.equal(t.sessions.length, 4);
        assert.ok(t.sessions.every((s) => s.state === 'PROPOSED'));
        const s = t.sessions[0];
        t = (
          await service.feedback(
            t.id,
            command(t, { choices: [{ sessionId: s.id, timeVersion: 0, choice: 'CANNOT' }] }),
            token(1)
          )
        ).team;
        assert.equal(t.sessions[0].state, 'PROPOSED');
        t = (await service.confirm(t.id, command(t, { sessionId: s.id }), token(0))).team;
        assert.equal(t.sessions[0].state, 'CONFIRMED');
        assert.equal(t.sessions[0].members.length, 3);
        assert.equal(t.sessions[0].feedback.filter((f) => !f.choice).length, 2);
        assert.deepEqual(
          t.sessions[0].members.map((m) => m.person.id).sort(),
          [f.ids[0], f.ids[1], f.ids[2]].sort()
        );
        assert.ok(t.sessions.slice(1).every((s) => s.state === 'PROPOSED'));
      }
    );
    await check(
      'feedback/edit version isolation retains history; confirmed edit requires explicit reconfirmation',
      async () => {
        let t = await propose(await propose(await create(), 0), 1),
          [a, b] = t.sessions;
        t = (
          await service.feedback(
            t.id,
            command(t, {
              choices: [
                { sessionId: a.id, timeVersion: 0, choice: 'CAN' },
                { sessionId: b.id, timeVersion: 0, choice: 'CANNOT' }
              ]
            }),
            token(1)
          )
        ).team;
        t = (await service.confirm(t.id, command(t, { sessionId: a.id }), token(0))).team;
        const other = await f.db.teamSession.findUniqueOrThrow({
          where: { id: b.id },
          include: { feedback: true, members: true }
        });
        t = (await service.editSession(t.id, command(t, { sessionId: a.id, ...times(2) }), token(0))).team;
        const edited = t.sessions.find((s) => s.id === a.id);
        assert.equal(edited.timeVersion, 1);
        assert.equal(edited.state, 'PROPOSED');
        assert.ok(edited.feedback.every((f) => f.choice === null));
        assert.deepEqual(edited.members, []);
        assert.deepEqual(
          await f.db.teamSession.findUniqueOrThrow({
            where: { id: b.id },
            include: { feedback: true, members: true }
          }),
          other
        );
        assert.equal(await f.db.teamFeedback.count({ where: { sessionId: a.id, timeVersion: 0 } }), 1);
        assert.equal(await f.db.teamSessionMember.count({ where: { sessionId: a.id, timeVersion: 0 } }), 3);
        await assert.rejects(
          () =>
            service.feedback(
              t.id,
              command(t, { choices: [{ sessionId: a.id, timeVersion: 0, choice: 'CAN' }] }),
              token(1)
            ),
          (e) => e.code === 'CONFLICT'
        );
        t = (await service.confirm(t.id, command(t, { sessionId: a.id }), token(0))).team;
        assert.equal(t.sessions.find((s) => s.id === a.id).members.length, 3);
        assert.equal(await f.db.teamSessionMember.count({ where: { sessionId: a.id } }), 6);
      }
    );
    await check(
      'single cancellation explicit and idempotent, retains snapshots and all other sessions',
      async () => {
        let t = await propose(await propose(await create(), 0), 1);
        const id = t.sessions[0].id;
        t = (await service.confirm(t.id, command(t, { sessionId: id }), token(0))).team;
        const other = await f.db.teamSession.findUniqueOrThrow({ where: { id: t.sessions[1].id } }),
          members = await f.db.teamSessionMember.findMany({ where: { sessionId: id } }),
          c = command(t, { sessionId: id, confirmed: true });
        await assert.rejects(
          () => service.cancelSession(t.id, { ...c, confirmed: false }, token(0)),
          (e) => e.code === 'VALIDATION_ERROR'
        );
        const r = await Promise.all([
          service.cancelSession(t.id, c, token(0)),
          service.cancelSession(t.id, c, token(0))
        ]);
        assert.equal(r.filter((x) => x.replayed).length, 1);
        assert.equal(r[0].team.sessions.find((s) => s.id === id).state, 'CANCELLED');
        assert.deepEqual(await f.db.teamSessionMember.findMany({ where: { sessionId: id } }), members);
        assert.deepEqual(await f.db.teamSession.findUniqueOrThrow({ where: { id: other.id } }), other);
        await assert.rejects(
          () => service.confirm(t.id, command(r[0].team, { sessionId: id }), token(0)),
          (e) => e.code === 'FORBIDDEN'
        );
        clock = new Date('2031-01-01');
        assert.equal((await service.cancelSession(t.id, c, token(0))).replayed, true);
        clock = new Date('2030-12-01');
      }
    );
    await check(
      'lock-wait clock at exact start rejects; one millisecond before start works without ordinary four-hour limit',
      async () => {
        let t = await propose(await create()),
          s = t.sessions[0];
        clock = new Date(Date.parse(s.startsAt) - 1);
        t = (await service.confirm(t.id, command(t, { sessionId: s.id }), token(0))).team;
        clock = new Date(s.startsAt);
        await assert.rejects(
          () => service.cancelSession(t.id, command(t, { sessionId: s.id, confirmed: true }), token(0)),
          (e) => e.code === 'FORBIDDEN'
        );
        clock = new Date('2030-12-01');
        t = await propose(await create());
        s = t.sessions[0];
        let release, ready;
        const acquired = new Promise((r) => (ready = r)),
          unblock = new Promise((r) => (release = r));
        const holder = f.db.$transaction(
          async (tx) => {
            await tx.$queryRawUnsafe(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text',
              'team:' + t.id
            );
            ready();
            await unblock;
          },
          { timeout: 15000 }
        );
        await acquired;
        const writing = service
          .cancelSession(t.id, command(t, { sessionId: s.id, confirmed: true }), token(0))
          .then(
            (value) => ({ value }),
            (error) => ({ error })
          );
        try {
          let waiting = false;
          for (let i = 0; i < 100; i++) {
            const [row] = await f.db.$queryRawUnsafe(
              "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted"
            );
            if (row.count) {
              waiting = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.ok(waiting);
          clock = new Date(s.startsAt);
          release();
          await holder;
          assert.equal((await writing).error?.code, 'FORBIDDEN');
          assert.equal((await fetchTeam(t.id)).sessions[0].state, 'PROPOSED');
        } finally {
          release();
          await holder;
          clock = new Date('2030-12-01');
        }
      }
    );
    await check(
      'notification persistence failure rolls back session, revision and command atomically',
      async () => {
        const t = await create(),
          c = command(t, times()),
          fake = await f.db.teamNotification.create({
            data: {
              teamId: t.id,
              eventKey: `team:${t.id}:${c.idempotencyKey}:${f.ids[0]}`,
              recipientId: f.ids[0],
              kind: 'SYNTHETIC',
              channel: 'IN_APP',
              payload: { synthetic: true },
              simulatedAt: clock
            }
          });
        await assert.rejects(() => service.propose(t.id, c, token(0)));
        assert.equal((await fetchTeam(t.id)).revision, t.revision);
        assert.equal(await f.db.teamSession.count({ where: { teamId: t.id } }), 0);
        assert.equal(
          await f.db.teamCommand.count({ where: { teamId: t.id, idempotencyKey: c.idempotencyKey } }),
          0
        );
        await f.db.teamNotification.delete({ where: { id: fake.id } });
      }
    );
    await check(
      'related-member messages and bound group only, recipient read/delete ownership enforced',
      async () => {
        let t = await propose(await create([f.ids[0], f.ids[1], f.ids[2]], 'synthetic-bound-group'));
        const notices = await f.db.teamNotification.findMany({
          where: { teamId: t.id, kind: 'TEAM_SCHEDULE_PROPOSED' }
        });
        assert.equal(notices.length, 4);
        assert.ok(
          notices.every(
            (n) => n.payload.sessionId === t.sessions[0].id && n.payload.startsAt === t.sessions[0].startsAt
          )
        );
        assert.deepEqual(
          notices
            .filter((n) => n.channel === 'IN_APP')
            .map((n) => n.recipientId)
            .sort(),
          [f.ids[0], f.ids[1], f.ids[2]].sort()
        );
        assert.equal(notices.find((n) => n.channel === 'QQ').qqGroupTarget, 'synthetic-bound-group');
        const note = notices.find((n) => n.recipientId === f.ids[1]),
          key = 'team:' + note.id;
        const inbox = await readFiveCategories(messages, token(1));
        assert.ok(inbox.items.some((m) => m.id === key && m.link.href === '/teams/' + t.id));
        noPrivate(inbox);
        await assert.rejects(
          () => messages.markRead(key, {}, token(7)),
          (e) => e.code === 'NOT_FOUND'
        );
        await assert.rejects(
          () => messages.remove(key, {}, token(7)),
          (e) => e.code === 'NOT_FOUND'
        );
        await messages.markRead(key, {}, token(1));
        await messages.remove(key, {}, token(1));
        assert.equal(
          (await f.db.teamNotification.findUniqueOrThrow({ where: { id: note.id } })).messageDeletedAt !==
            null,
          true
        );
        t = await propose(await create());
        assert.equal(await f.db.teamNotification.count({ where: { teamId: t.id, channel: 'QQ' } }), 0);
      }
    );
    await check(
      'all independent operations leave ordinary activity points, penalties, registrations and outbox unchanged',
      async () => {
        assert.deepEqual(await ordinary(), before);
      }
    );
  } finally {
    await f.cleanup();
  }
});
