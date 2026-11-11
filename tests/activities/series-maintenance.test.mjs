import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileSeriesRecruitment,
  processSeriesRecruitment
} from '../../packages/db/src/activity-series.ts';
import { processActivityMaintenance } from '../../packages/db/src/activity-maintenance.ts';
import { completionEligible, processActivityCompletions } from '../../packages/db/src/activity-completion.ts';

const startsAt = new Date('2030-06-01T12:00:00Z');
const cutoff = new Date('2030-06-01T11:30:00Z');
function harness({ full = false } = {}) {
  const registration = (id, accountId, seatId) => ({
    id,
    accountId,
    seatId,
    status: 'ACTIVE',
    exitedAt: null,
    seatSnapshot: null
  });
  const activity = (id, periodNumber) => ({
    id,
    periodNumber,
    seriesId: 'series-1',
    scene: 'GAME',
    mode: 'SERIES',
    organizerId: 'owner',
    title: 'Synthetic series',
    startsAt,
    endsAt: new Date('2030-06-01T14:00:00Z'),
    cancelledAt: null,
    cancellationReason: null,
    continuedAt: null,
    revision: 0,
    seats: [1, 2].map((position) => ({
      id: id + '-seat-' + position,
      position,
      kind: 'ANY',
      groupKey: null,
      role: null,
      job: null
    })),
    registrations: [
      registration(id + '-reg-1', 'member-1', id + '-seat-1'),
      ...(full ? [registration(id + '-reg-2', 'member-2', id + '-seat-2')] : [])
    ]
  });
  const state = {
    series: {
      id: 'series-1',
      state: 'RECRUITING',
      formedAt: null,
      cancelledAt: null,
      readyNotifiedAt: null,
      createdAt: new Date('2030-01-01'),
      activities: [activity('first', 1), activity('second', 2)]
    },
    events: [],
    commands: []
  };
  let fail = false,
    hook = null,
    pending = Promise.resolve();
  const locks = [],
    queries = [];
  const hydrate = () =>
    state.series &&
    structuredClone({
      ...state.series,
      activities: state.series.activities.map((row) => ({
        ...row,
        registrations: row.registrations.filter((reg) => reg.status === 'ACTIVE'),
        seats: row.seats.map((seat) => ({
          ...seat,
          registration: row.registrations.find((reg) => reg.seatId === seat.id) ?? null
        }))
      }))
    });
  const tx = {
    $queryRaw: async (strings, ...values) => {
      locks.push(values[0]);
      if (hook && values[0] === 'activity:second') {
        const next = hook;
        hook = null;
        next();
      }
      return [];
    },
    activitySeries: {
      findUnique: async () => hydrate(),
      update: async ({ data }) => Object.assign(state.series, data),
      findMany: async ({ where }) => {
        queries.push(['series', where]);
        const first = state.series?.activities.find((row) => row.periodNumber === 1);
        const actionable =
          !state.series?.readyNotifiedAt ||
          first?.startsAt <= where.OR[1].activities.some.startsAt.lte ||
          !first?.seats.length ||
          first.seats.some(
            (seat) => !first.registrations.some((reg) => reg.seatId === seat.id && reg.status === 'ACTIVE')
          );
        return actionable &&
          state.series?.state === 'RECRUITING' &&
          !state.series.formedAt &&
          !state.series.cancelledAt &&
          first?.scene === 'GAME' &&
          first.mode === 'SERIES' &&
          !first.cancelledAt &&
          first.startsAt <= where.activities.some.startsAt.lte
          ? [{ id: state.series.id }]
          : [];
      }
    },
    activity: {
      findMany: async ({ where }) => {
        queries.push(['single', where]);
        return state.series ? [{ id: 'first' }] : [];
      },
      findUnique: async ({ where }) => hydrate()?.activities.find((row) => row.id === where.id) ?? null,
      update: async ({ where, data }) => {
        const row = state.series.activities.find((item) => item.id === where.id);
        const { revision, ...rest } = data;
        Object.assign(row, rest);
        if (revision) row.revision += revision.increment;
        return row;
      }
    },
    activityRegistration: {
      findMany: async ({ where }) => {
        queries.push(['completion', where]);
        return [];
      },
      update: async ({ where, data }) => {
        const row = state.series.activities
          .flatMap((item) => item.registrations)
          .find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      }
    },
    activityOutbox: {
      upsert: async ({ where, create }) => {
        if (fail) throw new Error('Synthetic outbox failure');
        let event = state.events.find((item) => item.eventKey === where.eventKey);
        if (!event) {
          event = structuredClone(create);
          state.events.push(event);
        }
        return event;
      }
    },
    activityCommand: {
      create: async ({ data }) => {
        state.commands.push(structuredClone(data));
        return data;
      }
    },
    account: { findMany: async () => [] }
  };
  const db = {
    ...tx,
    $transaction: (fn) => {
      const run = pending.then(async () => {
        const before = structuredClone(state);
        try {
          return await fn(tx);
        } catch (error) {
          Object.assign(state, before);
          throw error;
        }
      });
      pending = run.catch(() => {});
      return run;
    }
  };
  return {
    state,
    db,
    tx,
    locks,
    queries,
    atLock(fn) {
      hook = fn;
    },
    fail() {
      fail = true;
    },
    reconcile: (now) => db.$transaction((t) => reconcileSeriesRecruitment(t, 'series-1', now))
  };
}

test('first recruitment remains open until the exact thirty-minute boundary', async () => {
  const h = harness();
  assert.equal((await h.reconcile(new Date(cutoff.getTime() - 1))).action, 'NONE');
  assert.equal(h.state.events.length, 0);
  assert.equal(h.state.series.state, 'RECRUITING');
  assert.equal((await h.reconcile(cutoff)).reason, 'SERIES_INSUFFICIENT');
  assert.deepEqual(h.locks.slice(0, 3), ['series:series-1', 'activity:first', 'activity:second']);
});

test('insufficient cancellation frees every period, preserves history and notifies each active member once', async () => {
  const h = harness(),
    second = h.state.series.activities[1];
  const oldTime = new Date('2030-01-05'),
    snapshot = { position: 99, retained: true };
  second.registrations[0].exitedAt = oldTime;
  second.registrations[0].seatSnapshot = snapshot;
  second.registrations.push({
    id: 'withdrawn',
    accountId: 'past-member',
    status: 'WITHDRAWN',
    seatId: null,
    exitedAt: oldTime,
    seatSnapshot: snapshot
  });
  const beforeHistory = structuredClone(second.registrations[1]);
  await h.reconcile(cutoff);
  for (const activity of h.state.series.activities) {
    assert.equal(activity.cancelledAt.toISOString(), cutoff.toISOString());
    assert.equal(activity.revision, 1);
    assert.equal(activity.registrations[0].status, 'CANCELLED');
    assert.equal(activity.registrations[0].seatId, null);
    assert.ok(activity.registrations[0].seatSnapshot);
  }
  assert.deepEqual(second.registrations[1], beforeHistory);
  assert.deepEqual(second.registrations[0].exitedAt, oldTime);
  assert.deepEqual(second.registrations[0].seatSnapshot, snapshot);
  assert.equal(h.state.events.length, 1);
  const event = h.state.events[0];
  assert.equal(event.recipientId, 'member-1');
  assert.equal(event.activityId, 'first');
  assert.equal(event.kind, 'ACTIVITY_CANCELLED');
  assert.equal(event.channel, 'IN_APP');
  assert.equal(event.payload.reason, 'SERIES_INSUFFICIENT');
  assert.equal(event.payload.activityLink, '/activities/first');
  assert.ok(event.mockDelivery.create.deliveredAt);
  assert.equal(h.state.commands[0].kind, 'SERIES_AUTO_CANCEL');
  assert.equal(h.state.commands[0].actorId, null);
  const before = structuredClone(h.state);
  assert.equal((await h.reconcile(startsAt)).action, 'NONE');
  assert.deepEqual(h.state, before);
});

test('full first period reminds only the organizer once and stays recruiting until confirmed', async () => {
  const h = harness({ full: true });
  assert.equal((await h.reconcile(cutoff)).action, 'READY');
  assert.equal((await h.reconcile(new Date(startsAt.getTime() - 1))).action, 'NONE');
  assert.equal(h.state.series.state, 'RECRUITING');
  assert.equal(h.state.events.length, 1);
  assert.equal(h.state.events[0].kind, 'SERIES_READY');
  assert.equal(h.state.events[0].recipientId, 'owner');
  assert.equal(h.state.events[0].channel, 'IN_APP');
  assert.equal(h.state.commands[0].kind, 'SERIES_READY');
});

test('full but unconfirmed first period cancels at start and never sends a late ready reminder', async () => {
  const h = harness({ full: true });
  const result = await h.reconcile(startsAt);
  assert.equal(result.reason, 'SERIES_UNCONFIRMED');
  assert.equal(h.state.events.length, 2);
  assert.ok(h.state.events.every((event) => event.kind === 'ACTIVITY_CANCELLED'));
  assert.equal(h.state.series.readyNotifiedAt, null);
});

test('a prior ready reminder does not prevent unconfirmed cancellation at start', async () => {
  const h = harness({ full: true });
  await h.reconcile(cutoff);
  assert.equal((await h.reconcile(startsAt)).action, 'CANCELLED');
  assert.equal(h.state.events.filter((event) => event.kind === 'SERIES_READY').length, 1);
  assert.equal(h.state.commands.filter((command) => command.kind === 'SERIES_AUTO_CANCEL').length, 1);
});

for (const mutate of [
  (h) => {
    h.state.series.state = 'FORMED';
    h.state.series.formedAt = cutoff;
  },
  (h) => {
    h.state.series.formedAt = cutoff;
  }
])
  test('formed series is excluded even when the first period is incomplete', async () => {
    const h = harness();
    mutate(h);
    assert.equal((await h.reconcile(startsAt)).state, 'FORMED');
    assert.deepEqual(await processSeriesRecruitment(h.db, startsAt), { cancelled: 0, ready: 0 });
    assert.equal(h.state.events.length, 0);
  });

test('a formation committed while worker waits for locks is rechecked', async () => {
  const h = harness();
  h.atLock(() => {
    h.state.series.state = 'FORMED';
    h.state.series.formedAt = cutoff;
  });
  assert.equal((await h.reconcile(startsAt)).state, 'FORMED');
  assert.equal(h.state.events.length, 0);
});

test('live clock is read after locks so a wait crossing the cutoff cannot keep recruitment open', async () => {
  const h = harness();
  let time = new Date(cutoff.getTime() - 1);
  h.atLock(() => {
    time = cutoff;
  });
  assert.equal((await h.reconcile(() => time)).action, 'CANCELLED');
});

for (const mutate of [
  (h) => {
    h.state.series.activities[0].seats = [];
  },
  (h) => {
    h.state.series.activities[0].registrations[1].status = 'WITHDRAWN';
  }
])
  test('zero seats or an inactive seat never qualifies as full', async () => {
    const h = harness({ full: true });
    mutate(h);
    assert.equal((await h.reconcile(cutoff)).reason, 'SERIES_INSUFFICIENT');
  });

test('concurrent batches serialize the series and emit one transition audit and recipient event', async () => {
  const h = harness();
  const result = await Promise.all([
    processSeriesRecruitment(h.db, cutoff),
    processSeriesRecruitment(h.db, cutoff)
  ]);
  assert.equal(
    result.reduce((total, row) => total + row.cancelled, 0),
    1
  );
  assert.equal(h.state.commands.length, 1);
  assert.equal(h.state.events.length, 1);
});

for (const full of [false, true])
  test('outbox failure rolls back every series mutation: full=' + full, async () => {
    const h = harness({ full });
    h.fail();
    const before = structuredClone(h.state);
    await assert.rejects(h.reconcile(cutoff), /Synthetic outbox failure/);
    assert.deepEqual(h.state, before);
  });

test('maintenance invokes the new series batch while old workers explicitly filter scene and mode', async () => {
  const h = harness();
  const result = await processActivityMaintenance(h.db, cutoff);
  assert.equal(result.cancelled, 0);
  assert.equal(result.seriesCancelled, 1);
  for (const key of ['single', 'completion']) {
    const query = h.queries.find(([kind]) => kind === key)[1];
    const activity = key === 'completion' ? query.activity : query;
    assert.equal(activity.scene, 'GAME');
    assert.equal(activity.mode, 'SINGLE');
  }
});

for (const fields of [
  { scene: 'OFFLINE', mode: 'SINGLE' },
  { scene: 'GAME', mode: 'SERIES' }
]) {
  test(
    'stale ordinary auto-cancel candidates are rechecked under lock: ' + JSON.stringify(fields),
    async () => {
      const h = harness();
      Object.assign(h.state.series.activities[0], fields);
      h.state.series.state = 'FORMED';
      const result = await processActivityMaintenance(h.db, startsAt);
      assert.equal(result.cancelled, 0);
      assert.equal(h.state.series.activities[0].cancelledAt, null);
      assert.equal(h.state.events.length, 0);
    }
  );
  test('completion eligibility rejects the new activity type: ' + JSON.stringify(fields), () => {
    const activity = {
      id: 'one',
      startsAt,
      endsAt: startsAt,
      cancelledAt: null,
      continuedAt: cutoff,
      seats: [],
      ...fields
    };
    const registration = {
      status: 'ACTIVE',
      attendanceStatus: 'PRESENT',
      attendanceRecordedAt: new Date(startsAt.getTime() - 1)
    };
    activity.startsAt = cutoff;
    assert.equal(completionEligible(activity, registration, startsAt), false);
    delete activity.scene;
    delete activity.mode;
    assert.equal(completionEligible(activity, registration, startsAt), true);
  });
}

test('completion batch queries exclude offline and series activity', async () => {
  const h = harness();
  await processActivityCompletions(h.db, startsAt);
  const query = h.queries.find(([kind]) => kind === 'completion')[1];
  assert.equal(query.activity.scene, 'GAME');
  assert.equal(query.activity.mode, 'SINGLE');
});

test('already reminded full series does not occupy the next batch before start', async () => {
  const h = harness({ full: true });
  assert.deepEqual(await processSeriesRecruitment(h.db, cutoff), { cancelled: 0, ready: 1 });
  const lockCount = h.locks.length;
  assert.deepEqual(await processSeriesRecruitment(h.db, new Date(cutoff.getTime() + 1)), {
    cancelled: 0,
    ready: 0
  });
  assert.equal(h.locks.length, lockCount);
  assert.deepEqual(await processSeriesRecruitment(h.db, startsAt), { cancelled: 1, ready: 0 });
});

test('a newly empty seat after ready remains a cancellation candidate before start', async () => {
  const h = harness({ full: true });
  await processSeriesRecruitment(h.db, cutoff);
  h.state.series.activities[0].registrations[1].status = 'WITHDRAWN';
  assert.deepEqual(await processSeriesRecruitment(h.db, new Date(cutoff.getTime() + 1)), {
    cancelled: 1,
    ready: 0
  });
});
