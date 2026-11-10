import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityService } from '../../apps/web/server/activities/service.ts';
import { dutyPresetSeats, AccountError } from '../../packages/domain/src/index.ts';
import { parseQqSignup, qqSignupInput } from '../../apps/web/server/qq-official/signup-parser.ts';
import { id } from '../activities/support/activity-input.mjs';

function harness() {
  let now = new Date('2030-06-01T10:00:00Z'),
    revalidate = async () => {};
  const actor = {
    accountId: id(99),
    account: { phone: 'synthetic', membership: 'FRIEND', activityPoints: 0 }
  };
  const calls = [],
    events = [],
    created = [];
  const row = {
    id: id(1),
    scene: 'GAME',
    mode: 'SINGLE',
    category: 'DUNGEON',
    title: 'Fixture',
    description: '',
    startsAt: new Date('2030-06-01T12:00:00Z'),
    endsAt: new Date('2030-06-01T14:00:00Z'),
    registrationClosesAt: new Date('2030-06-01T11:30:00Z'),
    createdAt: now,
    organizerId: id(2),
    organizer: { id: id(2), displayName: 'Organizer', profile: null },
    revision: 0,
    registrations: [],
    cancelledAt: null,
    dutySnapshot: { partyComposition: 'FULL' },
    seats: dutyPresetSeats('FULL').map((s, position) => ({
      id: id(position + 10),
      position,
      groupKey: s.groupKey,
      kind: s.requirement.kind,
      role: s.requirement.role,
      job: null,
      registration: null
    }))
  };
  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async () => {
      calls.push('organizer-message');
      return 1;
    },
    activity: {
      findUnique: async () => row,
      update: async () => {
        row.revision++;
      }
    },
    activitySeat: { create: async ({ data }) => ({ id: id(80), ...data }) },
    activityRegistration: {
      create: async ({ data }) => {
        const registration = {
          id: id(70),
          ...data,
          account: { id: actor.accountId, displayName: 'Bound', profile: null }
        };
        created.push(registration);
        let seat = row.seats.find((s) => s.id === data.seatId);
        if (!seat) {
          seat = {
            id: data.seatId,
            position: row.seats.length,
            kind: 'ANY',
            role: null,
            job: null,
            groupKey: null,
            registration: null
          };
          row.seats.push(seat);
        }
        seat.registration = registration;
        return { id: registration.id };
      }
    }
  };
  const auth = {
    db: tx,
    now: () => now,
    rate: async () => {},
    requireAccount: async () => {
      throw Error('QQ must not create or use sessions');
    },
    transaction: async (fn) => fn(tx)
  };
  class TrustedTestService extends ActivityService {
    async lockActivityScope() {
      calls.push('activity-lock');
    }
    async event(_tx, event) {
      events.push(event);
    }
    registerCommand(text) {
      const command = parseQqSignup(text);
      return this.registerResolved(
        async (actual) => {
          assert.equal(actual, tx);
          calls.push('actor-lock');
          return {
            id: row.id,
            actor,
            revalidate: async () => {
              calls.push('revalidate');
              await revalidate();
            }
          };
        },
        (r) => qqSignupInput(r, command)
      );
    }
  }
  return {
    service: new TrustedTestService(auth),
    row,
    actor,
    events,
    created,
    calls,
    setNow: (value) => {
      now = new Date(value);
    },
    setRevalidate: (value) => {
      revalidate = value;
    }
  };
}
const rejects = (fn, code) => assert.rejects(fn, (e) => e.code === code);
test('QQ trusted actor uses same registration core without session; FRIEND keeps website registration rights', async () => {
  const h = harness(),
    out = await h.service.registerCommand('报名 H1 白魔');
  assert.equal(out.replayed, false);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].accountId, h.actor.accountId);
  assert.equal(h.created[0].seatId, id(12));
  assert.equal(h.created[0].job, '白魔法师');
  assert.deepEqual(h.calls.slice(0, 3), ['actor-lock', 'activity-lock', 'revalidate']);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].kind, 'REGISTRATION_CREATED');
  assert.equal(h.events[0].channel, 'IN_APP');
  assert.equal(h.events[0].recipientId, id(2));
});
test('identical registration retries replay; move/job/second-seat requests never mutate existing registration', async () => {
  const h = harness();
  await h.service.registerCommand('报名 H1 白魔');
  h.setNow('2030-06-01T12:00:00Z');
  assert.equal((await h.service.registerCommand('报名 H1 白魔')).replayed, true);
  await rejects(() => h.service.registerCommand('报名 H2 白魔'), 'CONFLICT');
  await rejects(() => h.service.registerCommand('报名 H1 学者'), 'CONFLICT');
  assert.equal(h.created.length, 1);
  assert.equal(h.events.length, 1);
  assert.equal(h.row.revision, 1);
});
test('binding/account revalidation runs after activity lock and prevents any insert when revoked', async () => {
  const h = harness();
  h.setRevalidate(async () => {
    throw new AccountError('FORBIDDEN', 'binding changed', 403);
  });
  await rejects(() => h.service.registerCommand('报名 H1 白魔'), 'FORBIDDEN');
  assert.deepEqual(h.calls, ['actor-lock', 'activity-lock', 'revalidate']);
  assert.equal(h.created.length, 0);
});
test('shared guards reject occupied seat, wrong role/job, penalties, cancelled activity, and current cutoff', async () => {
  const cases = [
    (h) => {
      h.row.seats[2].registration = { accountId: id(88) };
      return 'CONFLICT';
    },
    (h) => {
      h.row.seats[2].role = 'TANK';
      return 'VALIDATION_ERROR';
    },
    (h) => {
      h.row.seats[2].kind = 'JOB';
      h.row.seats[2].job = '学者';
      return 'VALIDATION_ERROR';
    },
    (h) => {
      h.actor.account.activityPoints = 3;
      return 'FORBIDDEN';
    },
    (h) => {
      h.row.cancelledAt = new Date();
      return 'FORBIDDEN';
    },
    (h) => {
      h.setNow('2030-06-01T11:30:00Z');
      return 'FORBIDDEN';
    },
    (h) => {
      h.setRevalidate(async () => h.setNow('2030-06-01T11:30:00Z'));
      return 'FORBIDDEN';
    }
  ];
  for (const configure of cases) {
    const h = harness(),
      code = configure(h);
    await rejects(() => h.service.registerCommand('报名 H1 白魔'), code);
    assert.equal(h.created.length + h.events.length, 0);
  }
});
test('series first-period recruiting guard is unchanged', async () => {
  for (const patch of [
    { periodNumber: 2, series: { state: 'RECRUITING' } },
    { periodNumber: 1, series: { state: 'FORMED' } }
  ]) {
    const h = harness();
    Object.assign(h.row, { mode: 'SERIES', ...patch });
    await rejects(() => h.service.registerCommand('报名 H1 白魔'), 'FORBIDDEN');
    assert.equal(h.created.length, 0);
  }
});
test('offline shared capacity/points/message behavior is retained with only bare signup', async () => {
  const h = harness();
  Object.assign(h.row, { scene: 'OFFLINE', category: 'SOCIAL', capacityUnlimited: true, seats: [] });
  h.actor.account.activityPoints = 3;
  const out = await h.service.registerCommand('报名');
  assert.equal(out.replayed, false);
  assert.equal(h.created[0].job, null);
  assert.equal(h.row.seats.length, 1);
  assert.equal(h.events[0].kind, 'REGISTRATION_CONFIRMED');
  assert.equal(h.events[0].recipientId, h.actor.accountId);
  assert.equal(h.calls.includes('organizer-message'), true);
  assert.equal((await h.service.registerCommand('报名')).replayed, true);
  assert.equal(h.created.length, 1);
  const full = harness();
  Object.assign(full.row, { scene: 'OFFLINE', category: 'SOCIAL', capacityUnlimited: false, seats: [] });
  await rejects(() => full.service.registerCommand('报名'), 'CONFLICT');
  assert.equal(full.created.length, 0);
});
