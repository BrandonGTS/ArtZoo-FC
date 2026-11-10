import { composeActivityDescription } from '../../../apps/web/lib/activity-description.ts';
import { randomUUID } from 'node:crypto';
import { ActivityService } from '../../../apps/web/server/activities/service.ts';
import { ActivitySeriesService } from '../../../apps/web/server/activities/series.ts';
export const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
export const now = new Date('2030-12-01T00:00:00Z');
export const offlineInput = (patch = {}) => ({
  idempotencyKey: id(800),
  scene: 'OFFLINE',
  mode: 'SINGLE',
  title: 'Synthetic meetup',
  description: composeActivityDescription('Synthetic arrangement', 'Synthetic participation'),
  category: 'SOCIAL',
  startsAt: '2030-12-30T23:30:00+08:00',
  endsAt: '2030-12-31T01:30:00+08:00',
  seats: [],
  dutySelection: null,
  offline: {
    location: 'Synthetic venue',
    meetingInstructions: '',
    capacity: 1,
    registrationClosesAt: '2030-12-30T23:00:00+08:00',
    ...patch
  }
});
export const seriesInput = () => ({
  ...offlineInput(),
  scene: 'GAME',
  mode: 'SERIES',
  offline: undefined,
  seats: [{ kind: 'ANY' }, { kind: 'ANY' }],
  series: { weekdays: [1, 3], durationMinutes: 120, end: { kind: 'COUNT', count: 3 } }
});
const person = (id) => ({ id, displayName: 'Synthetic', profile: null });
export function harness({ series = false, capacity = 1, full = false, points = 0 } = {}) {
  let state = { rows: [], series: null, events: [], commands: [] },
    clock = now,
    actor = id(90),
    fail = false,
    hook,
    pending = Promise.resolve();
  const locks = [];
  const seat = (row, i) => ({
    id: randomUUID(),
    activityId: row.id,
    position: i,
    kind: 'ANY',
    role: null,
    job: null,
    groupKey: null,
    registration: null
  });
  const row = (n) => ({
    id: id(n),
    scene: series ? 'GAME' : 'OFFLINE',
    mode: series ? 'SERIES' : 'SINGLE',
    seriesId: series ? id(500) : null,
    periodNumber: series ? n : null,
    title: 'Synthetic activity',
    description: composeActivityDescription('Synthetic arrangement', 'Synthetic participation'),
    category: 'SOCIAL',
    organizerId: id(90),
    organizer: person(id(90)),
    createdAt: now,
    startsAt: new Date('2030-12-30T15:30:00Z'),
    endsAt: new Date('2030-12-30T17:30:00Z'),
    registrationClosesAt: new Date('2030-12-30T15:00:00Z'),
    capacityUnlimited: capacity === null,
    revision: 0,
    cancelledAt: null,
    continuedAt: null,
    seats: [],
    registrations: []
  });
  for (let n = 1; n <= (series ? 3 : 1); n++) {
    const r = row(n);
    r.seats = Array.from({ length: capacity ?? 0 }, (_, i) => seat(r, i));
    state.rows.push(r);
  }
  if (series)
    state.series = {
      id: id(500),
      state: 'RECRUITING',
      formedAt: null,
      cancelledAt: null,
      readyNotifiedAt: null,
      totalPeriods: 3
    };
  const hydrate = (r) =>
    r
      ? structuredClone({ ...r, series: state.series ? { ...state.series, activities: state.rows } : null })
      : null;
  const add = (data) => {
    const r = state.rows.find((r) => r.id === data.activityId),
      s = r.seats.find((s) => s.id === data.seatId);
    if (
      s.registration ||
      r.registrations.some((v) => v.accountId === data.accountId && v.status === 'ACTIVE')
    )
      throw Error('Synthetic unique constraint');
    const reg = {
      id: randomUUID(),
      status: 'ACTIVE',
      exitedAt: null,
      rescheduleExitAllowed: false,
      ...data,
      account: person(data.accountId)
    };
    s.registration = reg;
    r.registrations.push(reg);
    return reg;
  };
  if (full)
    for (const [i, s] of state.rows[0].seats.entries())
      add({ activityId: id(1), seatId: s.id, accountId: id(10 + i), job: null, createdAt: now });
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async (strings, ...values) => {
      locks.push(values[0]);
      if (hook && String(values[0]).startsWith('activity:')) {
        const fn = hook;
        hook = null;
        fn();
      }
      if (strings?.sql?.includes('FROM "Account"') || strings?.text?.includes('FROM "Account"'))
        return strings.values.filter((value) => typeof value === 'string').map((id) => ({ id }));
      return [];
    },
    activity: {
      findUnique: async ({ where }) =>
        where.id
          ? hydrate(state.rows.find((r) => r.id === where.id))
          : (state.rows.find((r) => r.idempotencyKey === where.organizerId_idempotencyKey.idempotencyKey) ??
            null),
      findMany: async ({ where }) => state.rows.filter((r) => r.seriesId === where.seriesId).map(hydrate),
      update: async ({ where, data }) => {
        const r = state.rows.find((r) => r.id === where.id),
          { revision, ...rest } = data;
        Object.assign(r, rest);
        r.revision += revision?.increment ?? 0;
        return hydrate(r);
      },
      updateMany: async ({ data }) => {
        for (const r of state.rows) r.revision += data.revision.increment;
        return { count: state.rows.length };
      },
      create: async ({ data }) => {
        const { seats, ...rest } = data,
          r = { ...row(100), ...rest, id: randomUUID() };
        r.seats = seats.create.map((s, i) => ({ ...seat(r, i), ...s }));
        state.rows.push(r);
        return { id: r.id };
      }
    },
    activitySeries: {
      findUnique: async () =>
        state.series ? structuredClone({ ...state.series, activities: state.rows }) : null,
      update: async ({ data }) => Object.assign(state.series, data),
      create: async ({ data }) =>
        (state.series = {
          ...data,
          id: id(500),
          state: 'RECRUITING',
          formedAt: null,
          cancelledAt: null,
          readyNotifiedAt: null
        })
    },
    activitySeat: {
      create: async ({ data }) => {
        const r = state.rows.find((r) => r.id === data.activityId),
          s = { ...seat(r, data.position), ...data };
        r.seats.push(s);
        return structuredClone(s);
      }
    },
    activityRegistration: {
      create: async ({ data }) => add(data),
      update: async ({ where, data }) => {
        const row = state.rows.find((row) => row.registrations.some((reg) => reg.id === where.id)),
          reg = row.registrations.find((reg) => reg.id === where.id);
        if (data.seatId === null) {
          const seat = row.seats.find((seat) => seat.id === reg.seatId);
          if (seat) seat.registration = null;
        }
        Object.assign(reg, data);
        return structuredClone(reg);
      }
    },
    activityCommand: {
      findUnique: async ({ where }) => {
        const w = where.activityId_actorId_idempotencyKey;
        return (
          state.commands.find(
            (c) =>
              c.activityId === w.activityId &&
              c.actorId === w.actorId &&
              c.idempotencyKey === w.idempotencyKey
          ) ?? null
        );
      },
      create: async ({ data }) => {
        state.commands.push(structuredClone(data));
        return data;
      }
    },
    activityOutbox: {
      create: async ({ data }) => {
        if (fail) throw Error('Synthetic outbox failure');
        state.events.push(structuredClone(data));
        return data;
      }
    }
  };
  const transaction = (fn) => {
    const work = pending.then(async () => {
      const before = structuredClone(state);
      try {
        return await fn(tx);
      } catch (e) {
        state = before;
        throw e;
      }
    });
    pending = work.catch(() => {});
    return work;
  };
  const db = { ...tx, $transaction: transaction },
    auth = {
      db,
      now: () => clock,
      rate: async () => {},
      limitWriteSource: async () => {},
      requireAccount: async (_, token) => ({
        id: id(900),
        accountId: token ?? actor,
        account: {
          membership: 'MEMBER',
          adminRole: (token ?? actor) === id(91) ? 'OWNER' : 'NONE',
          phone: 'synthetic',
          activityPoints: points,
          activityDecayAt: null
        }
      }),
      transaction
    };
  return {
    auth,
    service: new ActivityService(auth),
    seriesService: new ActivitySeriesService(auth),
    get state() {
      return state;
    },
    get first() {
      return state.rows[0];
    },
    locks,
    time: (t) => (clock = new Date(t)),
    actor: (n) => (actor = n),
    fail: () => (fail = true),
    atLock: (fn) => (hook = fn)
  };
}
