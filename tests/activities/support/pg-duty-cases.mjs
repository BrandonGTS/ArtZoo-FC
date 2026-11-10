import assert from 'node:assert/strict';
import { ActivityService } from '../../../apps/web/server/activities/service.ts';
import { staticDutyCatalog } from '../../../apps/web/server/activities/duty-catalog.ts';
import { dutyPresetSeats } from '../../../packages/domain/src/index.ts';
export async function dutyPostgresCases({ f, auth, service, check, token, fresh }) {
  const catalog = await staticDutyCatalog.list(),
    entry = catalog.items.find((e) => e.capacity === 8);
  let selected = structuredClone(entry),
    catalogVersion = 'isolated-original';
  const reader = {
    list: async () => ({ catalogVersion, items: selected ? [selected] : [] }),
    findById: async (id) =>
      selected && id === selected.id ? { catalogVersion, entry: structuredClone(selected) } : null
  };
  const s = new ActivityService(auth, reader),
    seats = entry.defaultSeats.map((s) => ({ ...s.requirement }));
  seats[0] = { kind: 'ANY' };
  const body = fresh({ dutySelection: { type: entry.type, dutyId: entry.id }, seats });
  let saved;
  await check(
    'DUTY snapshot persists edited seats and survives rename disable removal and idempotent replay',
    async () => {
      saved = (await s.create(body, token(1))).activity;
      assert.equal(saved.duty.name, entry.name);
      assert.equal(saved.duty.catalogVersion, catalogVersion);
      assert.equal(saved.duty.entryRevision, entry.entryRevision);
      assert.deepEqual(saved.duty.finalSeats[0].requirement, { kind: 'ANY' });
      const dbrow = await f.db.activity.findUnique({ where: { id: saved.id } });
      assert.equal(dbrow.dutyId, entry.id);
      assert.deepEqual(dbrow.dutySnapshot, saved.duty);
      for (const next of [
        { ...entry, name: 'Synthetic renamed', enabled: false, entryRevision: entry.entryRevision + 1 },
        null
      ]) {
        selected = next;
        catalogVersion = 'isolated-changed';
        const replay = await s.create(body, token(1));
        assert.equal(replay.replayed, true);
        assert.equal(replay.activity.id, saved.id);
        assert.deepEqual(replay.activity.duty, saved.duty);
        await assert.rejects(
          () => s.create({ ...body, idempotencyKey: fresh().idempotencyKey }, token(1)),
          (e) => e.code === 'VALIDATION_ERROR'
        );
      }
      assert.equal(
        await f.db.activity.count({ where: { organizerId: f.ids[1], idempotencyKey: body.idempotencyKey } }),
        1
      );
      assert.equal(
        await f.db.activityOutbox.count({ where: { activityId: saved.id, kind: 'ACTIVITY_PUBLISHED' } }),
        1
      );
    }
  );
  await check('DUTY snapshots agree on fresh service detail list mine after registration', async () => {
    await s.register(saved.id, { seatId: saved.seats[0].id, job: '骑士' }, token(2));
    const reloaded = new ActivityService(auth, reader),
      d = await reloaded.detail(saved.id, token(2)),
      list = await reloaded.list(new URL('http://test?month=2030-06'), token(2)),
      mine = await reloaded.mine(token(2));
    assert.deepEqual(d.duty, saved.duty);
    assert.deepEqual(list.items.find((x) => x.id === saved.id).duty, saved.duty);
    assert.deepEqual(mine.registered.find((x) => x.id === saved.id).duty, saved.duty);
  });
  await check(
    'DUTY catalog and OTHER alliance both persist ordered ABC and edited requirements',
    async () => {
      const alliance = catalog.items.find((e) => e.capacity === 24);
      for (const dutySelection of [
        { type: alliance.type, dutyId: alliance.id },
        { type: 'OTHER', name: 'Synthetic alliance', partyComposition: 'ALLIANCE' }
      ]) {
        const requirements = dutyPresetSeats('ALLIANCE').map((s) => s.requirement);
        requirements[8] = { kind: 'JOB', job: '白魔法师' };
        requirements[16] = { kind: 'ANY' };
        const a = (await service.create(fresh({ dutySelection, seats: requirements }), token(1))).activity;
        const dbseats = await f.db.activitySeat.findMany({
          where: { activityId: a.id },
          orderBy: { position: 'asc' }
        });
        assert.deepEqual(
          dbseats.map((s) => s.groupKey),
          ['A', 'B', 'C'].flatMap((g) => Array(8).fill(g))
        );
        const detail = await new ActivityService(auth).detail(a.id, token(1));
        assert.deepEqual(detail.duty, a.duty);
        assert.deepEqual(detail.seats[8].requirement, { kind: 'JOB', job: '白魔法师' });
        assert.deepEqual(detail.seats[16].requirement, { kind: 'ANY' });
        await service.register(a.id, { seatId: a.seats[8].id, job: '白魔法师' }, token(2));
        assert.equal((await service.detail(a.id, token(2))).seats[8].groupKey, 'B');
      }
    }
  );
  await check('DUTY legacy SQL null metadata stays null and old one-seat activity can register', async () => {
    const a = (await service.create(fresh({ seats: [{ kind: 'ANY' }] }), token(1))).activity;
    await f.db.$executeRaw`UPDATE "Activity" SET "dutyId" = NULL, "dutySnapshot" = NULL WHERE "id" = ${a.id}`;
    await f.db.activitySeat.updateMany({ where: { activityId: a.id }, data: { groupKey: null } });
    const before = await service.detail(a.id, token(2));
    assert.equal(before.duty, null);
    assert.equal(before.seats[0].groupKey, null);
    const registered = await service.register(a.id, { seatId: a.seats[0].id, job: '骑士' }, token(2));
    assert.equal(registered.activity.status, 'FULL');
    assert.equal(registered.activity.duty, null);
    assert.equal(registered.activity.seats[0].groupKey, null);
    assert.equal(
      (await service.list(new URL('http://test?month=2030-06'), token(2))).items.find((x) => x.id === a.id)
        .duty,
      null
    );
    assert.equal((await service.mine(token(2))).registered.find((x) => x.id === a.id).duty, null);
  });
}
