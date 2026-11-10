import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AccountError } from '../../../packages/domain/src/index.ts';
import { addActivityPenaltyPoints } from '../../../packages/db/src/activity-standing.ts';
import { ActivityPenaltyAppealService } from '../../../apps/web/server/activities/penalty-appeals.ts';
import { harness } from './attendance-fixture.mjs';
import { id } from './activity-input.mjs';
export async function fixture({ reason = 'LATE_WITHDRAWAL', points = 1, base = 0, enabled = true } = {}) {
  const h = harness();
  h.state.penaltyAppeals = [];
  h.state.audits = [];
  h.state.appealSequence = 0n;
  let allowed = true,
    fail = false;
  const activityFor = (row) =>
    row?.activity ??
    (row?.activityId === h.state.activity.id
      ? { scene: 'GAME', mode: 'SINGLE', title: 'Fixture activity', ...h.state.activity }
      : null);
  const related = (row, key) =>
    key === 'activity'
      ? activityFor(row)
      : key === 'penalty'
        ? h.state.penalties.find((p) => p.id === row?.penaltyId)
        : key === 'completion'
          ? (h.state.completions.find((c) => c.id === row?.completionId) ?? null)
          : row?.[key];
  const compare = (actual, condition) => {
    if (condition === null || typeof condition !== 'object') return actual === condition;
    if (condition instanceof Date) return actual instanceof Date && +actual === +condition;
    return Object.entries(condition).every(([operator, value]) => {
      if (operator === 'in') return value.includes(actual);
      if (operator === 'notIn') return !value.includes(actual);
      if (operator === 'equals') return compare(actual, value);
      if (operator === 'not') return !compare(actual, value);
      if (operator === 'is') return value === null ? actual === null : match(actual, value);
      if (operator === 'isNot') return value === null ? actual !== null : !match(actual, value);
      if (operator === 'gte') return actual >= value;
      if (operator === 'gt') return actual > value;
      if (operator === 'lte') return actual <= value;
      if (operator === 'lt') return actual < value;
      return actual != null && compare(related(actual, operator), value);
    });
  };
  const match = (row, where) =>
    row != null &&
    Object.entries(where).every(([key, value]) => {
      if (key === 'OR') return value.some((branch) => match(row, branch));
      if (key === 'AND')
        return (Array.isArray(value) ? value : [value]).every((branch) => match(row, branch));
      if (key === 'NOT')
        return (Array.isArray(value) ? value : [value]).every((branch) => !match(row, branch));
      return compare(related(row, key), value);
    });
  const joined = (row) => (row ? structuredClone({ ...row, activity: activityFor(row) }) : null);
  const latest = (penaltyId) =>
    h.state.penaltyAppeals
      .filter((x) => x.penaltyId === penaltyId)
      .sort((a, b) => (a.sequence > b.sequence ? -1 : 1))[0] ?? null;
  const patch = (row, data) => {
    for (const [k, v] of Object.entries(data))
      row[k] = v?.increment ? row[k] + v.increment : structuredClone(v);
    return structuredClone(row);
  };
  h.tx.account.findUniqueOrThrow = async ({ where }) => structuredClone(h.state.accounts[where.id]);
  h.tx.activityPenalty.findUnique = async ({ where }) =>
    joined(h.state.penalties.find((x) => x.id === where.id));
  h.tx.activityPenalty.findUniqueOrThrow = async ({ where }) => {
    const row = joined(h.state.penalties.find((x) => x.id === where.id));
    assert.ok(row, 'penalty fixture record exists');
    return row;
  };
  h.tx.activityScoreChange.findFirstOrThrow = async ({ where }) => {
    const row = h.state.scores
      .filter((x) => match(x, where))
      .sort((a, b) => (a.sequence < b.sequence ? -1 : 1))[0];
    assert.ok(row, 'score replay anchor must satisfy actual relation filters');
    return structuredClone(row);
  };
  h.tx.activityPenalty.count = async ({ where }) => h.state.penalties.filter((x) => match(x, where)).length;
  h.tx.activityPenalty.findMany = async ({ where, skip, take }) =>
    h.state.penalties
      .filter((x) => match(x, where))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(skip, skip + take)
      .map((x) => ({ ...joined(x), appeals: latest(x.id) ? [structuredClone(latest(x.id))] : [] }));
  const appeals = {
    findUnique: async ({ where }) => {
      const found = where.id
        ? h.state.penaltyAppeals.find((x) => x.id === where.id)
        : where.accountId_submissionKey
          ? h.state.penaltyAppeals.find((x) => match(x, where.accountId_submissionKey))
          : h.state.penaltyAppeals.find((x) => match(x, where.decidedById_decisionKey));
      return structuredClone(found ?? null);
    },
    findFirst: async ({ where }) => structuredClone(latest(where.penaltyId)),
    create: async ({ data }) => {
      assert.ok(
        !h.state.penaltyAppeals.some((x) => x.penaltyId === data.penaltyId && x.status === 'PENDING')
      );
      assert.ok(
        !h.state.penaltyAppeals.some(
          (x) => x.accountId === data.accountId && x.submissionKey === data.submissionKey
        )
      );
      const row = {
        id: randomUUID(),
        sequence: ++h.state.appealSequence,
        status: 'PENDING',
        revision: 0,
        decisionReason: null,
        decidedAt: null,
        decidedById: null,
        decisionKey: null,
        decisionFingerprint: null,
        ...structuredClone(data)
      };
      h.state.penaltyAppeals.push(row);
      return structuredClone(row);
    },
    update: async ({ where, data }) =>
      patch(
        h.state.penaltyAppeals.find((x) => x.id === where.id),
        data
      ),
    count: async ({ where }) => h.state.penaltyAppeals.filter((x) => match(x, where)).length,
    findMany: async ({ where, skip, take }) =>
      h.state.penaltyAppeals
        .filter((x) => match(x, where))
        .sort((a, b) => b.createdAt - a.createdAt || Number(b.sequence - a.sequence))
        .slice(skip, skip + take)
        .map((x) => ({
          ...structuredClone(x),
          account: { displayName: 'Participant' },
          penalty: joined(h.state.penalties.find((p) => p.id === x.penaltyId))
        }))
  };
  h.tx.activityPenaltyAppeal = h.db.activityPenaltyAppeal = appeals;
  h.tx.accountAudit = h.db.accountAudit = {
    create: async ({ data }) => {
      h.state.audits.push(structuredClone(data));
      return data;
    }
  };
  const original = h.tx.activityOutbox.create;
  h.tx.activityOutbox.create = async (arg) => {
    if (fail) throw Error('Synthetic result fault');
    return original(arg);
  };
  const auth = {
    ...h.auth,
    requireAccount: async (tx, token, admin = false) => {
      if (!allowed || !token || !h.state.accounts[id(Number(token))])
        throw new AccountError('UNAUTHENTICATED', 'Login', 401);
      const account = h.state.accounts[id(Number(token))];
      if (admin && account.adminRole === 'NONE') throw new AccountError('FORBIDDEN', 'Admin only', 403);
      return {
        id: id(Number(token) + 100),
        accountId: account.id,
        expiresAt: new Date('2035-01-01T00:00:00Z'),
        account: { ...account, phone: 'synthetic-' + token }
      };
    }
  };
  h.state.accounts[id(7)].activityPoints = base;
  const createdAt = new Date('2030-06-01T12:00:00Z');
  const penalty = await h.tx.activityPenalty.create({
    data: {
      eventKey: randomUUID(),
      accountId: id(7),
      activityId: id(1),
      registrationId: reason === 'LATE_CANCELLATION' ? null : id(2),
      reason,
      points,
      createdAt,
      appealEnabledAt: enabled ? createdAt : null
    }
  });
  await addActivityPenaltyPoints(h.tx, id(7), points, createdAt, penalty.eventKey, penalty.id);
  h.locks.length = 0;
  return {
    ...h,
    get state() {
      return h.state;
    },
    service: new ActivityPenaltyAppealService(auth),
    penaltyId: penalty.id,
    token: (n) => String(n),
    deny: () => (allowed = false),
    fault: (value) => (fail = value),
    latest: () => structuredClone(latest(penalty.id))
  };
}
export const submission = (patch = {}) => ({
  idempotencyKey: randomUUID(),
  expectedLatestAppealId: null,
  reason: 'Please review the documented circumstances',
  ...patch
});
export const decision = (patch = {}) => ({
  idempotencyKey: randomUUID(),
  expectedAppealRevision: 0,
  decision: 'APPROVE',
  reason: 'Verified circumstances',
  ...patch
});
