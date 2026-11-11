import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AccountError,
  DUTY_TYPE_LABELS,
  dutyPresetSeats,
  validateCreateActivity
} from '../../packages/domain/src/index.ts';
import { ActivityService } from '../../apps/web/server/activities/service.ts';
import { staticDutyCatalog } from '../../apps/web/server/activities/duty-catalog.ts';
import { handleActivities } from '../../apps/web/server/activities/http.ts';
import { setRuntime } from './support/runtime-stub.mjs';
import { input, id } from './support/activity-input.mjs';
const invalid = (fn) => assert.throws(fn, (e) => e.code === 'VALIDATION_ERROR');
const any = (n) => Array.from({ length: n }, () => ({ kind: 'ANY' }));
function harness({ entry, member = 'MEMBER' } = {}) {
  let current = entry ?? {
      id: 'synthetic-duty',
      name: 'Saved name',
      type: 'RAID',
      capacity: 8,
      partyComposition: 'FULL',
      defaultSeats: dutyPresetSeats('FULL'),
      enabled: true,
      entryRevision: 1
    },
    version = 'test-v1',
    lookups = 0;
  const rows = [],
    events = [];
  const actor = { id: id(90), accountId: id(99), account: { phone: 'synthetic', membership: member } };
  const tx = {
    $queryRaw: async () => [],
    activity: {
      findUnique: async ({ where }) =>
        where.id
          ? rows.find((r) => r.id === where.id)
          : rows.find((r) => r.idempotencyKey === where.organizerId_idempotencyKey.idempotencyKey),
      count: async () => rows.length,
      findMany: async () => rows,
      create: async ({ data }) => {
        const row = {
          ...structuredClone(data),
          id: randomUUID(),
          organizer: { id: id(99), displayName: 'Synthetic' },
          seats: data.seats.create.map((s) => ({
            ...structuredClone(s),
            id: randomUUID(),
            registration: null
          }))
        };
        rows.push(row);
        return { id: row.id };
      }
    },
    activityOutbox: {
      create: async ({ data }) => {
        events.push(data);
        return data;
      },
      findMany: async () => []
    }
  };
  tx.$transaction = async (fn) => fn(tx);
  const auth = {
    db: tx,
    requireAccount: async () => actor,
    rate: async () => {},
    transaction: async (fn) => fn(tx),
    now: () => new Date('2030-06-01T10:00:00Z'),
    limitWriteSource: async () => {}
  };
  const catalog = {
    list: async () => ({ catalogVersion: version, items: current ? [structuredClone(current)] : [] }),
    findById: async (key) => {
      lookups++;
      return current && current.id === key
        ? { catalogVersion: version, entry: structuredClone(current) }
        : null;
    }
  };
  return {
    service: new ActivityService(auth, catalog),
    auth,
    rows,
    events,
    get lookups() {
      return lookups;
    },
    setCatalog(e, v = 'test-v2') {
      current = e;
      version = v;
    },
    get entry() {
      return structuredClone(current);
    }
  };
}
const selected = (extra = {}) =>
  input({ dutySelection: { type: 'RAID', dutyId: 'synthetic-duty' }, seats: any(8), ...extra });
test('duty types expose the exact ten agreed choices and no legacy alliance alias', () => {
  assert.deepEqual(Object.keys(DUTY_TYPE_LABELS), [
    'ULTIMATE',
    'SAVAGE',
    'VARIANT',
    'TRIAL',
    'EXTREME',
    'ALLIANCE_RAID',
    'RAID',
    'DUNGEON',
    'UNREAL',
    'OTHER'
  ]);
});
for (const selection of [
  undefined,
  null,
  {},
  [],
  { type: 'GUILDHEST', dutyId: 'x' },
  { type: 'RAID', dutyId: 'x', name: 'forged' },
  { type: 'RAID', dutyId: 'x', capacity: 200 },
  { type: 'RAID', dutyId: 'x', enabled: true },
  { type: 'OTHER', name: 'x', partyComposition: 'CUSTOM', dutyId: 'x' },
  { type: 'OTHER', name: ' ', partyComposition: 'CUSTOM' },
  { type: 'OTHER', name: 'x', partyComposition: 'BAD' }
])
  test('duty strict selection rejects ' + JSON.stringify(selection), () =>
    invalid(() => validateCreateActivity(input({ dutySelection: selection })))
  );
test('duty rejects client snapshot or group fields', () => {
  for (const patch of [{ duty: {} }, { dutySnapshot: {} }, { seats: [{ kind: 'ANY', groupKey: 'A' }] }])
    invalid(() => validateCreateActivity(input(patch)));
});
test('duty OTHER presets enforce size while custom retains 1 through 200 and SOCIAL remains null', () => {
  for (const [composition, n] of [
    ['LIGHT', 4],
    ['FULL', 8],
    ['ALLIANCE', 24]
  ]) {
    const selection = { type: 'OTHER', name: '  Custom  ', partyComposition: composition };
    assert.equal(
      validateCreateActivity(input({ dutySelection: selection, seats: any(n) })).dutySelection.name,
      'Custom'
    );
    invalid(() => validateCreateActivity(input({ dutySelection: selection, seats: any(n - 1) })));
  }
  for (const n of [1, 200]) assert.equal(validateCreateActivity(input({ seats: any(n) })).seats.length, n);
  const social = input({ category: 'SOCIAL', seats: any(2) });
  delete social.dutySelection;
  assert.equal(validateCreateActivity(social).dutySelection, null);
  invalid(() =>
    validateCreateActivity({
      ...social,
      dutySelection: { type: 'OTHER', name: 'x', partyComposition: 'CUSTOM' }
    })
  );
});
test('duty presets and catalog reads return independent nested arrays', async () => {
  const first = dutyPresetSeats('ALLIANCE');
  first[0].requirement.role = 'DAMAGE';
  assert.equal(dutyPresetSeats('ALLIANCE')[0].requirement.role, 'TANK');
  const list = await staticDutyCatalog.list(),
    entry = list.items[0],
    original = structuredClone(entry);
  entry.name = 'Mutated';
  entry.defaultSeats[0].requirement.kind = 'ANY';
  assert.deepEqual((await staticDutyCatalog.findById(original.id)).entry, original);
  const found = await staticDutyCatalog.findById(original.id);
  found.entry.defaultSeats[0].groupKey = 'C';
  assert.deepEqual((await staticDutyCatalog.findById(original.id)).entry, original);
  assert.equal(await staticDutyCatalog.findById('missing-id'), null);
  const filtered = await staticDutyCatalog.list({ type: original.type, search: ' ' + original.name + ' ' });
  assert.ok(filtered.items.length);
  assert.ok(filtered.items.every((e) => e.type === original.type && e.name.includes(original.name)));
});
for (const kind of ['unknown', 'disabled', 'forged type', 'wrong size'])
  test('duty service rejects ' + kind + ' before any insert', async () => {
    const h = harness();
    let body = selected();
    if (kind === 'unknown') h.setCatalog(null);
    if (kind === 'disabled') h.setCatalog({ ...h.entry, enabled: false });
    if (kind === 'forged type') body.dutySelection.type = 'SAVAGE';
    if (kind === 'wrong size') body.seats = any(9);
    await assert.rejects(
      () => h.service.create(body),
      (e) => e.code === 'VALIDATION_ERROR'
    );
    assert.equal(h.rows.length, 0);
    assert.equal(h.events.length, 0);
  });
test('duty service makes trusted snapshot with edited requirements and ABC groups', async () => {
  const entry = {
    id: 'synthetic-alliance',
    name: 'Trusted alliance',
    type: 'ALLIANCE_RAID',
    capacity: 24,
    partyComposition: 'ALLIANCE',
    defaultSeats: dutyPresetSeats('ALLIANCE'),
    enabled: true,
    entryRevision: 7
  };
  const h = harness({ entry }),
    seats = any(24);
  seats[0] = { kind: 'JOB', job: '白魔法师' };
  seats[8] = { kind: 'ROLE', role: 'DAMAGE' };
  const result = await h.service.create(
    input({ dutySelection: { type: entry.type, dutyId: entry.id }, seats })
  );
  assert.deepEqual(result.activity.duty, {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    capacity: 24,
    partyComposition: 'ALLIANCE',
    catalogVersion: 'test-v1',
    entryRevision: 7,
    finalSeats: seats.map((requirement, i) => ({ requirement, groupKey: ['A', 'B', 'C'][Math.floor(i / 8)] }))
  });
  assert.deepEqual(
    result.activity.seats.map((s) => s.groupKey),
    ['A', 'B', 'C'].flatMap((g) => Array(8).fill(g))
  );
  assert.equal(h.events.length, 1);
});
test('duty success replay and saved reads survive catalog rename disable version change and removal', async () => {
  const h = harness(),
    body = selected(),
    first = await h.service.create(body),
    lookups = h.lookups;
  for (const next of [{ ...h.entry, name: 'Renamed', enabled: false, entryRevision: 2 }, null]) {
    h.setCatalog(next);
    const replay = await h.service.create(body);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.activity.duty, first.activity.duty);
    assert.equal(h.lookups, lookups);
    assert.deepEqual((await h.service.detail(first.activity.id)).duty, first.activity.duty);
    assert.deepEqual(
      (await h.service.list(new URL('http://test?month=2030-06'))).items[0].duty,
      first.activity.duty
    );
  }
  assert.equal(h.rows.length, 1);
  assert.equal(h.events.length, 1);
  await assert.rejects(
    () => h.service.create({ ...body, seats: [{ kind: 'JOB', job: '骑士' }, ...body.seats.slice(1)] }),
    (e) => e.code === 'CONFLICT'
  );
});
test('duty legacy null snapshot and seat group stays null without catalog lookup', async () => {
  const h = harness();
  const first = await h.service.create(input());
  h.rows[0].dutySnapshot = null;
  h.rows[0].dutyId = null;
  h.rows[0].seats.forEach((s) => (s.groupKey = null));
  h.setCatalog(null);
  const before = h.lookups,
    d = await h.service.detail(first.activity.id);
  assert.equal(d.duty, null);
  assert.ok(d.seats.every((s) => s.groupKey === null));
  assert.equal((await h.service.list(new URL('http://test?month=2030-06'))).items[0].duty, null);
  assert.equal(h.lookups, before);
});
test('duty catalog HTTP reuses authenticated read boundary and no-store errors', async () => {
  const h = harness();
  setRuntime({
    ...h.auth,
    requireAccount: async () => {
      throw new AccountError('UNAUTHENTICATED', 'Login', 401);
    }
  });
  const denied = await handleActivities(new Request('http://localhost:3000/api/activities/duties'), 'duties');
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('cache-control'), 'no-store');
  for (const member of ['MEMBER', 'FRIEND']) {
    setRuntime(harness({ member }).auth);
    const response = await handleActivities(
      new Request('http://localhost:3000/api/activities/duties?type=UNREAL'),
      'duties'
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.data.items.length);
    assert.ok(body.data.items.every((e) => e.type === 'UNREAL'));
  }
  for (const query of ['type=OTHER', 'type=forged', 'search=' + 'a'.repeat(101)]) {
    const response = await handleActivities(
      new Request('http://localhost:3000/api/activities/duties?' + query),
      'duties'
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});
