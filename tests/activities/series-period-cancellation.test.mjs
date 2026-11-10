import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSeriesPeriodCancellation } from '../../packages/domain/src/activity-series-management-contract.ts';
import { harness, id } from './support/series-fixture.mjs';
const command = { idempotencyKey: id(711), expectedRevision: 1, allMembersAgreed: true };
const rejects = (fn, code) => assert.rejects(fn, (e) => e.code === code);
async function formed() {
  const h = harness({ series: true, full: true, capacity: 2 });
  await h.seriesService.confirm(id(1), { idempotencyKey: id(710), expectedRevision: 0 });
  return h;
}
for (const patch of [
  { allMembersAgreed: false },
  { allMembersAgreed: 'true' },
  { allMembersAgreed: undefined },
  { expectedRevision: -1 },
  { expectedRevision: 1.5 },
  { expectedRevision: '1' },
  { idempotencyKey: 'bad' },
  { penaltyPoints: 0 }
])
  test('period cancellation validates explicit consent/version ' + JSON.stringify(patch), () =>
    assert.throws(
      () => validateSeriesPeriodCancellation({ ...command, ...patch }),
      (e) => e.code === 'VALIDATION_ERROR'
    )
  );
test('only the organizer may attest, including no administrator override', async () => {
  const h = await formed();
  for (const actor of [id(10), id(91)])
    await rejects(() => h.seriesService.cancelPeriod(id(2), command, actor), 'FORBIDDEN');
  assert.equal(h.state.commands.length, 1);
});
test('cancel only one period; preserve roster plan, history, no penalty or QQ', async () => {
  const h = await formed(),
    before = structuredClone(h.state),
    result = await h.seriesService.cancelPeriod(id(2), command);
  assert.equal(result.replayed, false);
  assert.equal(result.activity.status, 'CANCELLED');
  assert.deepEqual(h.state.rows[0], before.rows[0]);
  assert.deepEqual(h.state.rows[2], before.rows[2]);
  assert.deepEqual(h.state.series, before.series);
  const row = h.state.rows[1];
  assert.equal(row.cancellationReason, 'SERIES_AGREED_CANCEL');
  assert.equal(row.revision, 2);
  assert.ok(row.seats.every((s) => s.registration === null));
  assert.equal(row.registrations.length, 2);
  assert.ok(
    row.registrations.every((reg) => reg.status === 'CANCELLED' && reg.seatId === null && reg.seatSnapshot)
  );
  const events = h.state.events.filter((e) => e.kind === 'ACTIVITY_CANCELLED');
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.channel === 'IN_APP' && e.payload.periodNumber === 2 && e.mockDelivery));
  assert.equal(h.state.commands.at(-1).after.allMembersAgreed, true);
  assert.equal(h.state.commands.at(-1).after.penaltyPoints, 0);
});
test('same key concurrent requests commit once and retry after start replays', async () => {
  const h = await formed(),
    results = await Promise.all([
      h.seriesService.cancelPeriod(id(2), command),
      h.seriesService.cancelPeriod(id(2), command)
    ]);
  assert.equal(results.filter((r) => r.replayed).length, 1);
  h.time(h.state.rows[1].startsAt);
  assert.equal((await h.seriesService.cancelPeriod(id(2), command)).replayed, true);
  assert.equal(h.state.commands.length, 2);
  assert.equal(h.state.events.filter((e) => e.kind === 'ACTIVITY_CANCELLED').length, 2);
  await rejects(() => h.seriesService.cancelPeriod(id(2), { ...command, expectedRevision: 2 }), 'CONFLICT');
});
test('different concurrent keys cancel once', async () => {
  const h = await formed(),
    results = await Promise.allSettled([
      h.seriesService.cancelPeriod(id(2), command),
      h.seriesService.cancelPeriod(id(2), { ...command, idempotencyKey: id(712) })
    ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(h.state.commands.length, 2);
});
test('stale version cannot cancel', async () => {
  const h = await formed(),
    before = structuredClone(h.state);
  await rejects(() => h.seriesService.cancelPeriod(id(2), { ...command, expectedRevision: 0 }), 'CONFLICT');
  assert.deepEqual(h.state, before);
});
test('consensus cancellation is free even one millisecond before start', async () => {
  const h = await formed();
  h.time(new Date(h.state.rows[1].startsAt.getTime() - 1));
  await h.seriesService.cancelPeriod(id(2), command);
  assert.equal(h.state.commands.at(-1).after.penaltyPoints, 0);
});
for (const offset of [0, 1, 7200000])
  test('cannot newly cancel at/after start ' + offset, async () => {
    const h = await formed(),
      before = structuredClone(h.state);
    h.time(new Date(h.state.rows[1].startsAt.getTime() + offset));
    await rejects(() => h.seriesService.cancelPeriod(id(2), command), 'FORBIDDEN');
    assert.deepEqual(h.state, before);
  });
test('live time is read after lock waits', async () => {
  const h = await formed(),
    before = structuredClone(h.state);
  h.atLock(() => h.time(h.state.rows[1].startsAt));
  await rejects(() => h.seriesService.cancelPeriod(id(2), command), 'FORBIDDEN');
  assert.deepEqual(h.state, before);
});
test('outbox failure rolls back target status, registrations and audit', async () => {
  const h = await formed(),
    before = structuredClone(h.state);
  h.fail();
  await assert.rejects(() => h.seriesService.cancelPeriod(id(2), command), /Synthetic outbox/);
  assert.deepEqual(h.state, before);
});
test('offline and unformed series cannot use consensus operation', async () => {
  for (const h of [harness(), harness({ series: true, full: true })]) {
    await rejects(
      () => h.seriesService.cancelPeriod(id(1), { ...command, expectedRevision: 0 }),
      'FORBIDDEN'
    );
    assert.equal(h.state.commands.length, 0);
  }
});
