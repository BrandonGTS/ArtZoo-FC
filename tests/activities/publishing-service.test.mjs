import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityService } from '../../apps/web/server/activities/service.ts';
import { validateCreateActivity } from '../../packages/domain/src/index.ts';
import { tokenDigest } from '../../apps/web/server/auth/crypto.ts';
import { input, id } from './support/activity-input.mjs';

function harness() {
  const rows = [],
    albums = [],
    audits = [],
    events = [];
  const actor = { accountId: id(99), account: { membership: 'MEMBER', activityPoints: 0 } };
  const tx = {
    activity: {
      findUnique: async () => null,
      create: async ({ data }) => {
        const row = { id: id(rows.length + 20), ...data };
        rows.push(row);
        return row;
      }
    },
    activitySeries: { create: async ({ data }) => ({ id: id(40), ...data }) },
    album: {
      create: async ({ data }) => {
        const row = { id: id(50), ...data };
        albums.push(row);
        return row;
      }
    },
    albumAudit: { create: async ({ data }) => audits.push(data) }
  };
  const auth = {
    db: tx,
    now: () => new Date('2030-05-01'),
    requireAccount: async () => actor,
    rate: async () => {},
    transaction: async (fn) => fn(tx)
  };
  class SyntheticService extends ActivityService {
    async actorLocked() {
      return actor;
    }
    async resolveDuty() {
      return null;
    }
    async read(_, key) {
      return rows.find((row) => row.id === key) ?? { id: key };
    }
    async event(_, event) {
      events.push(event);
    }
  }
  return { service: new SyntheticService(auth), tx, rows, albums, audits, events };
}
const description = '活动安排\n\n参与要求：\n参与要求';
const offline = (extra = {}) =>
  input({
    scene: 'OFFLINE',
    mode: 'SINGLE',
    category: 'SOCIAL',
    dutySelection: null,
    seats: [],
    offline: {
      location: '既定地点',
      meetingInstructions: '',
      capacity: null,
      registrationClosesAt: '2030-06-01T19:00:00+08:00'
    },
    ...extra
  });

for (const base of [input(), offline()])
  test('new ' + (base.scene ?? 'GAME') + ' publish rejects missing sections before any insert', async () => {
    for (const [text, field] of [
      ['', 'description'],
      ['安排', 'requirements'],
      ['参与要求：\n要求', 'description']
    ]) {
      const h = harness();
      await assert.rejects(
        () => h.service.create({ ...base, description: text }),
        (e) => e.fieldErrors?.[field] && e.status === 400
      );
      assert.equal(h.rows.length + h.albums.length + h.audits.length + h.events.length, 0);
    }
  });
test('single game, long-term, and offline new publish accept both sections; hidden duty/seat fields do not block offline', async () => {
  for (const body of [
    input({ description }),
    input({
      description,
      mode: 'SERIES',
      scene: 'GAME',
      series: { weekdays: [6], durationMinutes: 120, end: { kind: 'COUNT', count: 2 } }
    }),
    offline({ description })
  ]) {
    const h = harness(),
      result = await h.service.create(body);
    assert.equal(result.replayed, false);
    assert.equal(h.rows.length, body.mode === 'SERIES' ? 2 : 1);
    if (body.scene === 'OFFLINE') {
      assert.equal(h.rows[0].location, '既定地点');
      assert.equal(h.rows[0].capacityUnlimited, true);
      assert.equal(h.rows[0].seats.create.length, 0);
    }
  }
});
test('single-level album uses null secondary category without category lookup or mutation', async () => {
  for (const body of [
    input({ description, createAlbum: true, album: { name: '游戏相册', categoryId: null } }),
    offline({ description, createAlbum: true, album: { name: '线下相册', categoryId: null } })
  ]) {
    const h = harness();
    await h.service.create(body);
    assert.equal(h.albums.length, 1);
    assert.equal(h.albums[0].categoryId, null);
    assert.equal(h.albums[0].primary, body.scene === 'OFFLINE' ? 'OFFLINE' : 'GAME');
  }
});
test('unchanged old idempotent replay returns before new required-section validation', async () => {
  const h = harness(),
    body = input({ description: '历史安排' });
  h.tx.activity.findUnique = async () => ({
    id: id(71),
    requestFingerprint: tokenDigest(JSON.stringify(validateCreateActivity(body)))
  });
  assert.equal((await h.service.create(body)).replayed, true);
  assert.equal(h.rows.length + h.events.length, 0);
});
