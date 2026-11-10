import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AccountError } from '../../../packages/domain/src/index.ts';
import { ActivityAttendanceService } from '../../../apps/web/server/activities/attendance.ts';
import { id } from './activity-input.mjs';
export function harness() {
  let now = new Date('2030-06-01T12:00:00Z'),
    actor = 9,
    allowed = true,
    failEvent = false,
    onLock = null;
  let state = {
    activity: {
      scene: 'GAME',
      mode: 'SINGLE',
      autoAbsenceEnabledAt: null,
      id: id(1),
      organizerId: id(9),
      startsAt: new Date('2030-06-01T12:00:00Z'),
      endsAt: new Date('2030-06-01T14:00:00Z'),
      attendanceEnabledAt: new Date('2030-05-01T00:00:00Z'),
      cancelledAt: null,
      revision: 0,
      completionEnabledAt: null,
      managementEnabledAt: new Date('2030-05-01'),
      continuedAt: null,
      seats: [{ registration: { id: id(2) } }]
    },
    reg: {
      id: id(2),
      activityId: id(1),
      accountId: id(7),
      status: 'ACTIVE',
      attendanceStatus: null,
      attendanceSource: null,
      attendanceRevision: 0,
      attendanceRecordedAt: null,
      attendanceUpdatedAt: null,
      attendancePenaltyId: null
    },
    accounts: Object.fromEntries(
      [6, 7, 8, 9].map((n) => [
        id(n),
        { id: id(n), activityPoints: 0, activityDecayAt: null, adminRole: n === 8 ? 'ADMIN' : 'NONE' }
      ])
    ),
    penalties: [],
    scores: [],
    completions: [],
    commands: [],
    appeals: [],
    events: [],
    sequence: 0n
  };
  const locks = [];
  const patch = (row, data) => {
    for (const [k, v] of Object.entries(data))
      row[k] = v?.increment ? row[k] + v.increment : structuredClone(v);
    return row;
  };
  const appealMatch = (a, w) =>
    Object.entries(w).every(([k, v]) => (typeof v === 'object' ? v.in.includes(a[k]) : a[k] === v));
  const grantPenalty = (s) => (s.penaltyId ? state.penalties.find((p) => p.id === s.penaltyId) : null);
  const grantCompletion = (s) =>
    s.completionId ? state.completions.find((c) => c.id === s.completionId) : null;
  const tx = {
    $queryRaw: async (chunks, ...values) => {
      const query = chunks.join('');
      locks.push({ query, values });
      if (query.includes('pg_advisory') && String(values[0]).startsWith('activity:') && onLock) {
        const fn = onLock;
        onLock = null;
        fn();
      }
      if (query.includes('activityPoints')) return [structuredClone(state.accounts[values[0]])];
      return [];
    },
    account: { update: async ({ where, data }) => patch(state.accounts[where.id], data) },
    activity: {
      fields: { autoAbsenceEnabledAt: 'autoAbsenceEnabledAt' },
      findUnique: async (q) =>
        q.where.id !== id(1)
          ? null
          : structuredClone(
              q.select.registrations
                ? {
                    ...state.activity,
                    registrations:
                      state.reg.status === 'ACTIVE'
                        ? [
                            {
                              ...state.reg,
                              completion:
                                state.completions.find((c) => c.registrationId === state.reg.id) ?? null,
                              account: { id: id(7), displayName: 'Participant' },
                              attendanceAppeals: state.appeals
                                .filter(
                                  (a) =>
                                    a.accountId ===
                                    q.select.registrations.select.attendanceAppeals.where.accountId
                                )
                                .slice()
                                .reverse()
                                .slice(0, 1)
                            }
                          ]
                        : []
                  }
                : state.activity
            ),
      update: async ({ data }) => patch(state.activity, data)
    },
    activityRegistration: {
      findUnique: async ({ where, include }) =>
        where.id === id(2)
          ? structuredClone({ ...state.reg, ...(include?.activity ? { activity: state.activity } : {}) })
          : null,
      update: async ({ data }) => structuredClone(patch(state.reg, data)),
      findMany: async ({ where }) => {
        const a = state.activity,
          q = state.reg;
        if (where.attendanceStatus === null)
          return q.status === 'ACTIVE' &&
            q.attendanceStatus === null &&
            q.attendanceRecordedAt === null &&
            q.attendancePenaltyId === null &&
            a.autoAbsenceEnabledAt &&
            a.startsAt >= a.autoAbsenceEnabledAt &&
            !a.cancelledAt &&
            a.endsAt <= where.activity.endsAt.lte &&
            (a.continuedAt || a.seats.every((s) => s.registration))
            ? [{ id: q.id, accountId: q.accountId, activityId: q.activityId }]
            : [];
        return q.status === 'ACTIVE' &&
          ['PRESENT', 'ABSENT'].includes(q.attendanceStatus) &&
          q.attendanceRecordedAt &&
          !state.completions.length &&
          a.completionEnabledAt &&
          !a.cancelledAt &&
          a.endsAt <= where.activity.endsAt.lte &&
          (a.continuedAt || a.seats.every((s) => s.registration))
          ? [{ id: q.id, accountId: q.accountId, activityId: q.activityId }]
          : [];
      }
    },
    activityCompletion: {
      findUnique: async ({ where }) =>
        structuredClone(
          state.completions.find(
            (c) =>
              c.activityId === where.activityId_accountId.activityId &&
              c.accountId === where.activityId_accountId.accountId
          ) ?? null
        ),
      create: async ({ data }) => {
        assert.ok(
          !state.completions.some((c) => c.activityId === data.activityId && c.accountId === data.accountId)
        );
        const c = { id: randomUUID(), revision: 0, ...structuredClone(data) };
        state.completions.push(c);
        return structuredClone(c);
      },
      update: async ({ where, data }) =>
        structuredClone(
          patch(
            state.completions.find((c) => c.id === where.id),
            data
          )
        )
    },
    activityCommand: {
      findUnique: async ({ where }) =>
        state.commands.find((c) =>
          ['activityId', 'actorId', 'idempotencyKey'].every(
            (k) => c[k] === where.activityId_actorId_idempotencyKey[k]
          )
        ) ?? null,
      create: async ({ data }) => {
        const c = { id: randomUUID(), ...structuredClone(data) };
        state.commands.push(c);
        return c;
      }
    },
    activityPenalty: {
      create: async ({ data }) => {
        assert.equal(
          state.penalties.some((p) => p.eventKey === data.eventKey),
          false
        );
        const p = { id: randomUUID(), reversedAt: null, ...structuredClone(data) };
        state.penalties.push(p);
        return p;
      },
      findUniqueOrThrow: async ({ where }) => structuredClone(state.penalties.find((p) => p.id === where.id)),
      update: async ({ where, data }) =>
        patch(
          state.penalties.find((p) => p.id === where.id),
          data
        )
    },
    activityScoreChange: {
      create: async ({ data }) => {
        assert.equal(
          state.scores.some((s) => s.eventKey === data.eventKey),
          false
        );
        const s = { ...structuredClone(data), sequence: ++state.sequence };
        state.scores.push(s);
        return s;
      },
      findFirstOrThrow: async ({ where }) => {
        const a = state.scores.find(
          (s) =>
            s.accountId === where.accountId &&
            ((s.reason === 'PENALTY' &&
              (grantPenalty(s)?.reason === 'NO_SHOW' ||
                (['LATE_WITHDRAWAL', 'LATE_CANCELLATION'].includes(grantPenalty(s)?.reason) &&
                  grantPenalty(s)?.reversedAt))) ||
              (s.reason === 'NORMAL_COMPLETION' && grantCompletion(s)))
        );
        if (!a) throw new Error('Missing anchor');
        return structuredClone(a);
      },
      findMany: async ({ where }) =>
        state.scores
          .filter((s) => s.accountId === where.accountId && s.sequence >= where.sequence.gte)
          .map((s) => ({
            ...structuredClone(s),
            penalty: grantPenalty(s) ? structuredClone(grantPenalty(s)) : null,
            completion: grantCompletion(s) ? structuredClone(grantCompletion(s)) : null
          }))
    },
    activityOutbox: {
      create: async ({ data }) => {
        if (failEvent) throw new Error('Synthetic event failure');
        assert.equal(
          state.events.some((e) => e.eventKey === data.eventKey),
          false
        );
        state.events.push(structuredClone(data));
        return data;
      }
    },
    activityAttendanceAppeal: {
      findFirst: async ({ where }) =>
        structuredClone(state.appeals.find((a) => appealMatch(a, where)) ?? null),
      findUnique: async ({ where }) => {
        const a = state.appeals.find((a) => a.id === where.id);
        return a ? { ...structuredClone(a), registration: { activityId: id(1) } } : null;
      },
      create: async ({ data }) => {
        const a = {
          id: randomUUID(),
          status: 'PENDING',
          revision: 0,
          decisionReason: null,
          decidedAt: null,
          ...structuredClone(data)
        };
        state.appeals.push(a);
        return a;
      },
      update: async ({ where, data }) =>
        patch(
          state.appeals.find((a) => a.id === where.id),
          data
        ),
      count: async ({ where }) => state.appeals.filter((a) => appealMatch(a, where)).length,
      findMany: async ({ where, skip, take }) =>
        state.appeals
          .filter((a) => appealMatch(a, where))
          .slice(skip, skip + take)
          .map((a) => ({
            ...structuredClone(a),
            account: { displayName: 'Participant' },
            registration: {
              attendanceStatus: state.reg.attendanceStatus,
              activity: {
                scene: 'GAME',
                mode: 'SINGLE',
                autoAbsenceEnabledAt: null,
                id: id(1),
                title: 'Fixture'
              }
            }
          }))
    }
  };
  let serial = Promise.resolve();
  const transaction = (fn) => {
    const work = serial.then(async () => {
      const before = structuredClone(state);
      try {
        return await fn(tx);
      } catch (e) {
        state = before;
        throw e;
      }
    });
    serial = work.catch(() => {});
    return work;
  };
  const db = { ...tx, $transaction: transaction };
  const auth = {
    db,
    now: () => now,
    rate: async () => {},
    requireAccount: async (_, token, admin = false) => {
      if (!allowed) throw new AccountError('UNAUTHENTICATED', 'Login', 401);
      const account = state.accounts[id(actor)];
      if (admin && account.adminRole === 'NONE') throw new AccountError('FORBIDDEN', 'Admin only', 403);
      return {
        id: id(actor + 100),
        accountId: id(actor),
        account: { ...account, phone: 'synthetic-' + actor }
      };
    },
    transaction
  };
  return {
    db,
    tx,
    auth,
    service: new ActivityAttendanceService(auth),
    locks,
    get state() {
      return state;
    },
    time: (s) => (now = new Date(s)),
    actor: (n) => (actor = n),
    deny: () => (allowed = false),
    fail: () => (failEvent = true),
    atActivityLock: (fn) => (onLock = fn)
  };
}
