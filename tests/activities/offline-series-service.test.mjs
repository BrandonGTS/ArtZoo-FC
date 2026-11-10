import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityManagementService } from '../../apps/web/server/activities/management.ts';
import { ActivityAttendanceService } from '../../apps/web/server/activities/attendance.ts';
import { harness, id, offlineInput, seriesInput } from './support/series-fixture.mjs';
const signup = { seatId: null, job: null },
  command = { idempotencyKey: id(700), expectedRevision: 0 };
const rejects = (fn, code) => assert.rejects(fn, (e) => e.code === code);
test('restricted game account may create offline while GAME/SERIES remains restricted', async () => {
  const h = harness({ points: 3 });
  await h.service.create(offlineInput());
  assert.equal(h.state.events.length, 0);
  await rejects(() => h.service.create({ ...seriesInput(), idempotencyKey: id(801) }), 'FORBIDDEN');
});
test('offline cutoff must exceed trusted publication time', async () => {
  const h = harness();
  h.time('2030-12-30T15:00:00Z');
  const before = structuredClone(h.state);
  await rejects(() => h.service.create(offlineInput()), 'VALIDATION_ERROR');
  assert.deepEqual(h.state, before);
});
test('offline publication idempotency replays and rejects changed content', async () => {
  const h = harness();
  const first = await h.service.create(offlineInput()),
    count = h.state.rows.length;
  const second = await h.service.create(offlineInput());
  assert.equal(second.replayed, true);
  assert.equal(second.activity.id, first.activity.id);
  assert.equal(h.state.rows.length, count);
  await rejects(() => h.service.create({ ...offlineInput(), title: 'Changed' }), 'CONFLICT');
});
test('offline restricted member registers once, own IN_APP only, duplicates replay', async () => {
  const h = harness({ points: 3 });
  const result = await h.service.register(id(1), signup, id(10));
  assert.equal(result.activity.myRegistration.participant.id, id(10));
  assert.equal((await h.service.register(id(1), signup, id(10))).replayed, true);
  assert.equal(h.state.events.length, 1);
  assert.equal(h.state.events[0].recipientId, id(10));
  assert.equal(h.state.events[0].kind, 'REGISTRATION_CONFIRMED');
  assert.equal(h.state.events[0].channel, 'IN_APP');
});
test('offline last-place concurrent transactions allow exactly one signup', async () => {
  const h = harness(),
    results = await Promise.allSettled([
      h.service.register(id(1), signup, id(10)),
      h.service.register(id(1), signup, id(11))
    ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'CONFLICT');
  assert.equal(h.first.registrations.length, 1);
  assert.equal(h.state.events.length, 1);
  assert.equal(h.locks.filter((v) => v === 'activity:' + id(1)).length, 2);
});
test('concurrent duplicate signup writes once', async () => {
  const h = harness();
  const results = await Promise.all([
    h.service.register(id(1), signup, id(10)),
    h.service.register(id(1), signup, id(10))
  ]);
  assert.deepEqual(
    results.map((r) => r.replayed),
    [false, true]
  );
  assert.equal(h.state.events.length, 1);
});
test('unlimited offline dynamically appends seats and remains open after signup', async () => {
  const h = harness({ capacity: null });
  assert.equal(h.first.seats.length, 0);
  for (const member of [10, 11, 12]) await h.service.register(id(1), signup, id(member));
  assert.equal(h.first.seats.length, 3);
  assert.equal(h.first.registrations.length, 3);
  assert.equal((await h.service.register(id(1), signup, id(10))).activity.status, 'OPEN');
});
for (const offset of [-1, 0, 1])
  test('offline precise custom cutoff offset ' + offset, async () => {
    const h = harness();
    h.time(new Date(h.first.registrationClosesAt.getTime() + offset));
    if (offset < 0) await h.service.register(id(1), signup, id(10));
    else await rejects(() => h.service.register(id(1), signup, id(10), new Date('2030-12-01')), 'FORBIDDEN');
  });
test('offline clock crossing cutoff while lock waits rejects stale arrival', async () => {
  const h = harness();
  h.atLock(() => h.time(h.first.registrationClosesAt));
  await rejects(() => h.service.register(id(1), signup, id(10)), 'FORBIDDEN');
  assert.equal(h.state.events.length, 0);
});
test('outbox failure rolls registration and dynamic seat allocation back', async () => {
  const h = harness({ capacity: null }),
    before = structuredClone(h.state);
  h.fail();
  await assert.rejects(() => h.service.register(id(1), signup, id(10)), /Synthetic outbox/);
  assert.deepEqual(h.state, before);
});
for (const body of [
  { seatId: id(2), job: null },
  { seatId: null, job: '骑士' }
])
  test('offline rejects game seat/job ' + JSON.stringify(body), async () => {
    const h = harness();
    await rejects(() => h.service.register(id(1), body, id(10)), 'VALIDATION_ERROR');
    assert.equal(h.first.registrations.length, 0);
  });
test('series publishing generates each explicit period without QQ publication', async () => {
  const h = harness();
  await h.service.create(seriesInput());
  const rows = h.state.rows.filter((r) => r.seriesId);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.periodNumber),
    [1, 2, 3]
  );
  assert.equal(rows[1].startsAt.toISOString(), '2031-01-01T15:30:00.000Z');
  assert.ok(rows.every((r) => r.endsAt - r.startsAt === 7200000));
  assert.equal(h.state.events.length, 0);
});
test('series confirm only organizer, including administrator denied', async () => {
  const h = harness({ series: true, full: true, capacity: 2 });
  for (const actor of [id(10), id(91)])
    await rejects(() => h.seriesService.confirm(id(1), command, actor), 'FORBIDDEN');
  assert.equal(h.state.series.state, 'RECRUITING');
});
test('series cannot form before full and later period cannot recruit', async () => {
  const h = harness({ series: true, capacity: 2 });
  await rejects(() => h.seriesService.confirm(id(1), command), 'CONFLICT');
  await rejects(
    () => h.service.register(id(2), { seatId: h.state.rows[1].seats[0].id, job: null }, id(10)),
    'FORBIDDEN'
  );
});
test('series concurrent same nonce forms once and clones fixed roster every period', async () => {
  const h = harness({ series: true, full: true, capacity: 2 });
  const results = await Promise.all([
    h.seriesService.confirm(id(1), command),
    h.seriesService.confirm(id(1), command)
  ]);
  assert.deepEqual(
    results.map((r) => r.replayed),
    [false, true]
  );
  assert.equal(h.state.series.state, 'FORMED');
  assert.equal(h.state.commands.length, 1);
  for (const row of h.state.rows) {
    assert.deepEqual(
      row.registrations.map((r) => r.accountId),
      [id(10), id(11)]
    );
    assert.equal(row.revision, 1);
  }
  assert.equal(h.state.events.length, 2);
  assert.ok(h.state.events.every((e) => e.kind === 'SERIES_FORMED' && e.channel === 'IN_APP'));
  assert.deepEqual(h.state.events.map((e) => e.recipientId).sort(), [id(10), id(11)]);
  await rejects(() => h.seriesService.confirm(id(1), { ...command, expectedRevision: 1 }), 'CONFLICT');
  await rejects(
    () => h.seriesService.confirm(id(1), { ...command, idempotencyKey: id(701), expectedRevision: 1 }),
    'CONFLICT'
  );
  await rejects(
    () => h.service.register(id(1), { seatId: h.first.seats[0].id, job: null }, id(12)),
    'FORBIDDEN'
  );
  assert.ok(h.locks.includes('series:' + id(500)));
  for (const row of h.state.rows) assert.ok(h.locks.includes('activity:' + row.id));
});
test('series formation outbox failure rolls back cloned roster and state', async () => {
  const h = harness({ series: true, full: true, capacity: 2 }),
    before = structuredClone(h.state);
  h.fail();
  await assert.rejects(() => h.seriesService.confirm(id(1), command), /Synthetic outbox/);
  assert.deepEqual(h.state, before);
});
for (const series of [false, true])
  test('old management and attendance reject scene/mode ' + series, async () => {
    const h = harness({ series, full: true });
    const before = structuredClone(h.state),
      management = new ActivityManagementService(h.auth),
      attendance = new ActivityAttendanceService(h.auth);
    await rejects(() => management.cancel(id(1), { ...command, expectedPenaltyPoints: 0 }), 'FORBIDDEN');
    await rejects(() => management.continueActivity(id(1), command), 'FORBIDDEN');
    await rejects(() => attendance.attendance(id(1)), 'FORBIDDEN');
    assert.deepEqual(h.state, before);
  });
