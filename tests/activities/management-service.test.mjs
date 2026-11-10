import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AccountError } from '../../packages/domain/src/index.ts';
import { ActivityManagementService } from '../../apps/web/server/activities/management.ts';
import { ActivityService } from '../../apps/web/server/activities/service.ts';
import { input, id } from './support/activity-input.mjs';

// Synthetic rollback adapter. These checks execute production methods; SQL contention is separate.
function harness() {
  let now = new Date('2030-06-01T10:00:00Z'),
    actorId = id(9),
    allowed = true,
    failEvent = false;
  const person = (accountId) => ({ id: accountId, displayName: 'Synthetic', profile: null });
  let state = {
    row: {
      id: id(1),
      organizerId: id(9),
      organizer: person(id(9)),
      title: 'Fixture',
      description: '',
      category: 'DUNGEON',
      createdAt: now,
      startsAt: new Date('2030-06-01T12:00:00Z'),
      endsAt: new Date('2030-06-01T14:00:00Z'),
      revision: 0,
      cancelledAt: null,
      cancellationReason: null,
      continuedAt: null,
      dutyId: null,
      dutySnapshot: {
        id: null,
        name: 'Fixture',
        type: 'OTHER',
        capacity: 2,
        partyComposition: 'CUSTOM',
        catalogVersion: null,
        entryRevision: null,
        finalSeats: Array.from({ length: 2 }, () => ({ groupKey: null, requirement: { kind: 'ANY' } }))
      },
      seats: [0, 1].map((i) => ({
        id: id(i + 2),
        activityId: id(1),
        position: i,
        kind: 'ANY',
        role: null,
        job: null,
        groupKey: null
      }))
    },
    registrations: [0, 1].map((i) => ({
      id: id(i + 4),
      activityId: id(1),
      seatId: id(i + 2),
      accountId: id(i + 7),
      job: i ? '白魔法师' : '骑士',
      createdAt: now,
      status: 'ACTIVE',
      exitedAt: null,
      rescheduleExitAllowed: false,
      account: person(id(i + 7))
    })),
    commands: [],
    events: [],
    penalties: [],
    scoreChanges: [],
    standings: Object.fromEntries([7, 8, 9].map((n) => [id(n), { activityPoints: 0, activityDecayAt: null }]))
  };
  const view = () =>
    structuredClone({
      ...state.row,
      registrations: [...state.registrations].reverse(),
      seats: state.row.seats
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((seat) => ({
          ...seat,
          registration: state.registrations.find((r) => r.seatId === seat.id) ?? null
        }))
    });
  const patch = (row, data) => {
    for (const [key, value] of Object.entries(data))
      row[key] = value?.increment ? row[key] + value.increment : structuredClone(value);
    return row;
  };
  const tx = {
    $queryRaw: async (chunks, ...values) =>
      chunks.join('').includes('activityPoints') ? [structuredClone(state.standings[values[0]])] : [],
    $executeRawUnsafe: async () => 0,
    $executeRaw: async () => {
      state.row.dutySnapshot = null;
      return 1;
    },
    account: { update: async ({ where, data }) => patch(state.standings[where.id], data) },
    activityScoreChange: {
      create: async ({ data }) => {
        state.scoreChanges.push(structuredClone(data));
        return data;
      }
    },
    activity: {
      findUnique: async ({ where }) => (where.id === state.row.id ? view() : null),
      findUniqueOrThrow: async () => view(),
      update: async ({ data }) => patch(state.row, data)
    },
    activityCommand: {
      findUnique: async ({ where }) =>
        state.commands.find((c) =>
          ['activityId', 'actorId', 'idempotencyKey'].every(
            (k) => c[k] === where.activityId_actorId_idempotencyKey[k]
          )
        ) ?? null,
      create: async ({ data }) => {
        state.commands.push(structuredClone(data));
        return data;
      }
    },
    activityPenalty: {
      create: async ({ data }) => {
        assert.ok(!state.penalties.some((p) => p.eventKey === data.eventKey));
        state.penalties.push(structuredClone(data));
        return { ...data, id: randomUUID() };
      }
    },
    activityOutbox: {
      create: async ({ data }) => {
        if (failEvent) throw new Error('Synthetic notification failure');
        assert.ok(!state.events.some((event) => event.eventKey === data.eventKey));
        state.events.push(structuredClone(data));
        return data;
      }
    },
    activityRegistration: {
      findUniqueOrThrow: async ({ where }) =>
        structuredClone(state.registrations.find((r) => r.id === where.id)),
      update: async ({ where, data }) =>
        patch(
          state.registrations.find((r) => r.id === where.id),
          data
        ),
      updateMany: async ({ where, data }) => {
        const rows = state.registrations.filter(
          (r) => r.activityId === where.activityId && r.status === where.status
        );
        rows.forEach((r) => patch(r, data));
        return { count: rows.length };
      }
    },
    activitySeat: {
      deleteMany: async ({ where }) => {
        const before = state.row.seats.length;
        state.row.seats = state.row.seats.filter((s) => where.id.notIn.includes(s.id));
        return { count: before - state.row.seats.length };
      },
      update: async ({ where, data }) =>
        patch(
          state.row.seats.find((s) => s.id === where.id),
          data
        ),
      create: async ({ data }) => {
        const seat = { ...structuredClone(data), id: randomUUID() };
        state.row.seats.push(seat);
        return seat;
      }
    }
  };
  const auth = {
    db: tx,
    now: () => now,
    rate: async () => {},
    requireAccount: async () => {
      if (!allowed) throw new AccountError('UNAUTHENTICATED', 'Login', 401);
      return {
        id: id(99),
        accountId: actorId,
        account: { phone: 'synthetic-' + actorId, membership: 'MEMBER', ...state.standings[actorId] }
      };
    },
    transaction: async (fn) => {
      const before = structuredClone(state);
      try {
        return await fn(tx);
      } catch (error) {
        state = before;
        throw error;
      }
    }
  };
  const catalog = {
    findById: async () => {
      throw new Error('Unchanged saved selection must not reread catalog');
    }
  };
  return {
    service: new ActivityManagementService(auth, catalog),
    basic: new ActivityService(auth, catalog),
    get state() {
      return state;
    },
    get now() {
      return now;
    },
    view,
    time(value) {
      now = new Date(value);
    },
    actor(n) {
      actorId = id(n);
    },
    deny() {
      allowed = false;
    },
    fail() {
      failEvent = true;
    }
  };
}
const command = (revision = 0) => ({ idempotencyKey: randomUUID(), expectedRevision: revision });
const withdraw = (revision = 0) => ({
  ...command(revision),
  expectedRegistrationId: id(4),
  expectedPenaltyPoints: 0
});
const withdrawalFor = (h, revision = 0) => ({
  ...withdraw(revision),
  expectedPenaltyPoints:
    !h.state.registrations.find((r) => r.id === id(4))?.rescheduleExitAllowed &&
    h.state.row.startsAt.getTime() - h.now.getTime() < 2 * 3600000
      ? 1
      : 0
});
const cancellationFor = (h, revision = 0) => ({
  ...command(revision),
  expectedPenaltyPoints:
    h.now.getTime() >= h.state.row.startsAt.getTime() - 30 * 60000 &&
    h.state.registrations.filter((r) => r.status === 'ACTIVE').length < h.state.row.seats.length &&
    !h.state.row.continuedAt
      ? 0
      : h.state.row.startsAt.getTime() - h.now.getTime() < 4 * 3600000
        ? 2
        : 0
});
const edit = (h, extra = {}) => ({
  ...input(),
  ...command(h.state.row.revision),
  title: 'Updated',
  dutySelection: { type: 'OTHER', name: 'Fixture', partyComposition: 'CUSTOM' },
  seats: h.state.row.seats.map((seat) => ({ id: seat.id, requirement: { kind: 'ANY' } })),
  ...extra
});
const rejects = (fn, code) => assert.rejects(fn, (error) => error.code === code);

for (const [time, points] of [
  ['2030-06-01T09:59:59.999Z', 0],
  ['2030-06-01T10:00:00Z', 0],
  ['2030-06-01T10:00:00.001Z', 1]
]) {
  test('withdraw exact two-hour boundary ' + time, async () => {
    const h = harness();
    h.actor(7);
    h.time(time);
    const result = await h.service.withdraw(id(1), withdrawalFor(h));
    assert.equal(result.activity.seats[0].registration, null);
    assert.equal(result.activity.registeredCount, 1);
    assert.equal(result.activity.myRegistration, null);
    assert.equal(result.activity.myParticipation.status, 'WITHDRAWN');
    assert.equal(h.state.registrations.length, 2);
    assert.equal(h.state.registrations[0].seatSnapshot.id, id(2));
    assert.equal(
      h.state.penalties.reduce((sum, p) => sum + p.points, 0),
      points
    );
    assert.deepEqual(
      h.state.events
        .filter((e) => e.kind === 'REGISTRATION_WITHDRAWN')
        .map((e) => [e.channel, e.recipientId]),
      [['IN_APP', id(9)]]
    );
    assert.equal(
      h.state.events.some((e) => e.channel === 'QQ'),
      false
    );
  });
}
for (const [time, points] of [
  ['2030-06-01T07:59:59.999Z', 0],
  ['2030-06-01T08:00:00Z', 0],
  ['2030-06-01T08:00:00.001Z', 2]
]) {
  test('cancel exact four-hour boundary ' + time, async () => {
    const h = harness();
    h.time(time);
    const result = await h.service.cancel(id(1), cancellationFor(h));
    assert.equal(result.activity.status, 'CANCELLED');
    assert.equal(result.activity.registeredCount, 0);
    assert.ok(h.state.registrations.every((r) => r.status === 'CANCELLED' && r.seatId === null));
    assert.equal(
      h.state.penalties.reduce((sum, p) => sum + p.points, 0),
      points
    );
    const cancellations = h.state.events.filter((e) => e.kind === 'ACTIVITY_CANCELLED');
    assert.deepEqual(
      cancellations
        .filter((e) => e.channel === 'IN_APP')
        .map((e) => e.recipientId)
        .sort(),
      [id(7), id(8)].sort()
    );
    assert.equal(cancellations.filter((e) => e.channel === 'QQ').length, 1);
    assert.ok(h.state.penalties.every((p) => p.accountId === id(9)));
  });
}
test('management replays identical commands without duplicate audit events or points even after start', async () => {
  for (const kind of ['cancel', 'withdraw']) {
    const h = harness();
    h.time('2030-06-01T10:01:00Z');
    if (kind === 'withdraw') h.actor(7);
    const body = kind === 'withdraw' ? withdrawalFor(h) : cancellationFor(h);
    await h.service[kind](id(1), body);
    const before = structuredClone(h.state);
    h.time('2030-06-01T12:00:01Z');
    assert.equal((await h.service[kind](id(1), body)).replayed, true);
    assert.deepEqual(h.state, before);
    await rejects(() => h.service[kind](id(1), { ...body, expectedRevision: 1 }), 'CONFLICT');
  }
});
test('all new management operations deny exact start and later without any mutation', async () => {
  for (const time of ['2030-06-01T12:00:00Z', '2030-06-01T12:00:00.001Z'])
    for (const kind of ['withdraw', 'cancel', 'edit', 'continueActivity']) {
      const h = harness();
      h.time(time);
      if (kind === 'withdraw') h.actor(7);
      const before = structuredClone(h.state);
      await rejects(
        () =>
          h.service[kind](
            id(1),
            kind === 'withdraw'
              ? withdrawalFor(h)
              : kind === 'edit'
                ? edit(h)
                : kind === 'cancel'
                  ? cancellationFor(h)
                  : command()
          ),
        'FORBIDDEN'
      );
      assert.deepEqual(h.state, before);
    }
});
test('organizer identity and own registration are checked with stale-version protection', async () => {
  for (const kind of ['cancel', 'edit', 'continueActivity']) {
    const h = harness();
    h.actor(7);
    await rejects(
      () =>
        h.service[kind](
          id(1),
          kind === 'edit' ? edit(h) : kind === 'cancel' ? cancellationFor(h) : command()
        ),
      'FORBIDDEN'
    );
  }
  const h = harness();
  await rejects(() => h.service.withdraw(id(1), withdrawalFor(h)), 'CONFLICT');
  h.actor(7);
  await rejects(
    () => h.service.withdraw(id(1), { ...withdrawalFor(h), expectedRegistrationId: id(5) }),
    'CONFLICT'
  );
  await rejects(() => h.service.withdraw(id(1), withdrawalFor(h, 99)), 'CONFLICT');
  h.deny();
  await rejects(() => h.service.withdraw(id(1), withdrawalFor(h)), 'UNAUTHENTICATED');
  assert.equal(h.state.commands.length, 0);
});
test('notification failure rolls back cancellation withdrawal edits audit and penalties', async () => {
  for (const kind of ['cancel', 'withdraw', 'edit']) {
    const h = harness();
    h.fail();
    if (kind === 'withdraw') h.actor(7);
    h.time('2030-06-01T08:00:00Z');
    const before = structuredClone(h.state),
      body =
        kind === 'withdraw'
          ? withdrawalFor(h)
          : kind === 'edit'
            ? edit(h, { startsAt: '2030-06-01T21:00:00+08:00' })
            : cancellationFor(h);
    await assert.rejects(() => h.service[kind](id(1), body));
    assert.deepEqual(h.state, before);
  }
});
test('shortage cancellation is free only from cutoff until start and no previous continue', async () => {
  for (const [time, free] of [
    ['2030-06-01T11:29:59.999Z', false],
    ['2030-06-01T11:30:00Z', true],
    ['2030-06-01T11:59:59.999Z', true]
  ]) {
    const h = harness();
    h.state.registrations.pop();
    h.time(time);
    await h.service.cancel(id(1), cancellationFor(h));
    assert.equal(h.state.row.cancellationReason, free ? 'RECRUITMENT_SHORTAGE' : 'ORGANIZER_CANCELLED');
    assert.equal(h.state.penalties.length, free ? 0 : 1);
  }
  const h = harness();
  h.state.registrations.pop();
  h.time('2030-06-01T11:30:00Z');
  await h.service.continueActivity(id(1), command());
  assert.equal(h.state.events.length, 0);
  await h.service.cancel(id(1), cancellationFor(h, 1));
  assert.equal(h.state.penalties[0].points, 2);
});
test('continue decision denies full activities and before-cutoff decisions', async () => {
  const h = harness();
  h.time('2030-06-01T11:30:00Z');
  await rejects(() => h.service.continueActivity(id(1), command()), 'FORBIDDEN');
  h.state.registrations.pop();
  h.time('2030-06-01T11:29:59.999Z');
  await rejects(() => h.service.continueActivity(id(1), command()), 'FORBIDDEN');
});
test('late withdrawal penalty survives later shortage cancellation', async () => {
  const h = harness();
  h.actor(7);
  h.time('2030-06-01T11:40:00Z');
  await h.service.withdraw(id(1), withdrawalFor(h));
  h.actor(9);
  await h.service.cancel(id(1), cancellationFor(h, 1));
  assert.equal(h.state.registrations[0].status, 'WITHDRAWN');
  assert.equal(h.state.penalties.length, 1);
  assert.equal(h.state.penalties[0].accountId, id(7));
  assert.equal(h.state.penalties[0].points, 1);
});
for (const [time, allowed] of [
  ['2030-06-01T08:00:00Z', true],
  ['2030-06-01T08:00:00.001Z', false]
]) {
  test('reschedule with participants respects original four-hour boundary ' + time, async () => {
    const h = harness();
    h.time(time);
    const body = edit(h, { startsAt: '2030-06-01T21:00:00+08:00' });
    if (!allowed) {
      await rejects(() => h.service.edit(id(1), body), 'FORBIDDEN');
      assert.equal(h.state.events.length, 0);
      return;
    }
    await h.service.edit(id(1), body);
    assert.ok(h.state.registrations.every((r) => r.rescheduleExitAllowed));
    assert.equal(h.state.events.filter((e) => e.kind === 'ACTIVITY_RESCHEDULED').length, 3);
    h.actor(7);
    h.time('2030-06-01T12:59:00Z');
    await h.service.withdraw(id(1), withdrawalFor(h, 1));
    assert.equal(h.state.penalties.length, 0);
  });
}
test('edit preserves registration identities and unchanged saved duty even if catalog disappears', async () => {
  const h = harness();
  const registrations = structuredClone(h.state.registrations);
  const result = await h.service.edit(id(1), edit(h));
  assert.equal(result.activity.title, 'Updated');
  assert.equal(result.activity.duty.name, 'Fixture');
  assert.deepEqual(h.state.registrations, registrations);
  assert.equal(h.state.events.length, 0);
});
test('edit rejects member removal and incompatible requirement before mutation', async () => {
  for (const body of [
    (h) => edit(h, { seats: [{ id: id(2), requirement: { kind: 'ANY' } }] }),
    (h) =>
      edit(h, {
        seats: [
          { id: id(2), requirement: { kind: 'ROLE', role: 'HEALER' } },
          { id: id(3), requirement: { kind: 'ANY' } }
        ]
      })
  ]) {
    const h = harness(),
      before = structuredClone(h.state);
    await rejects(() => h.service.edit(id(1), body(h)), 'CONFLICT');
    assert.deepEqual(h.state, before);
  }
});
test('cancelled activities forbid new registration move withdrawal and edit and retain their history', async () => {
  const h = harness();
  await h.service.cancel(id(1), cancellationFor(h));
  h.actor(7);
  await rejects(() => h.basic.register(id(1), { seatId: id(2), job: '骑士' }), 'FORBIDDEN');
  await rejects(
    () => h.basic.moveRegistration(id(1), { expectedSeatId: id(2), seatId: id(3), job: '骑士' }),
    'FORBIDDEN'
  );
  await rejects(() => h.service.withdraw(id(1), withdrawalFor(h, 1)), 'FORBIDDEN');
  h.actor(9);
  await rejects(() => h.service.edit(id(1), edit(h)), 'FORBIDDEN');
  assert.equal(h.state.registrations.length, 2);
  assert.equal(h.state.commands.length, 1);
});

test('three-point restriction denies new signup and publication but preserves existing replay and management', async () => {
  const h = harness();
  h.state.standings[id(9)] = { activityPoints: 3, activityDecayAt: new Date('2030-06-08T10:00:00Z') };
  await rejects(() => h.basic.create(input()), 'FORBIDDEN');
  await rejects(() => h.basic.register(id(1), { seatId: id(2), job: '骑士' }), 'FORBIDDEN');
  h.actor(7);
  h.state.standings[id(7)] = { activityPoints: 3, activityDecayAt: new Date('2030-06-08T10:00:00Z') };
  assert.equal((await h.basic.register(id(1), { seatId: id(2), job: '骑士' })).replayed, true);
  await h.service.withdraw(id(1), withdrawalFor(h));
  assert.equal(h.state.registrations[0].status, 'WITHDRAWN');
});
test('lock wait crossing the start boundary cannot execute a lifecycle operation', async () => {
  const h = harness();
  h.time('2030-06-01T11:59:59.999Z');
  const original = h.service.auth.requireAccount;
  let reads = 0;
  h.service.auth.requireAccount = async (...args) => {
    const actor = await original(...args);
    if (++reads === 3) h.time('2030-06-01T12:00:00Z');
    return actor;
  };
  await rejects(() => h.service.cancel(id(1), cancellationFor(h)), 'FORBIDDEN');
  assert.equal(h.state.commands.length, 0);
});

test('withdrawal and cancellation never silently charge an unconfirmed boundary-crossing penalty', async () => {
  for (const kind of ['withdraw', 'cancel']) {
    const h = harness();
    if (kind === 'withdraw') h.actor(7);
    h.time(kind === 'withdraw' ? '2030-06-01T10:00:00.001Z' : '2030-06-01T08:00:00.001Z');
    const body = kind === 'withdraw' ? withdrawalFor(h) : cancellationFor(h);
    body.expectedPenaltyPoints = 0;
    const before = structuredClone(h.state);
    await rejects(() => h.service[kind](id(1), body), 'CONFLICT');
    assert.deepEqual(h.state, before);
    const accepted = await h.service[kind](
      id(1),
      kind === 'withdraw' ? withdrawalFor(h) : cancellationFor(h)
    );
    assert.equal(accepted.replayed, false);
    assert.equal(h.state.penalties.length, 1);
  }
});
