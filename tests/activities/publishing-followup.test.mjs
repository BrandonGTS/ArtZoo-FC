import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITY_ALBUM_NAME_LIMIT,
  ACTIVITY_JOBS,
  activityAlbumName,
  validateCreateActivity,
  dutyPresetSeats
} from '../../packages/domain/src/index.ts';
import {
  repeatedWeekdays,
  manualWeekdaysAfterSelection,
  templateSeatRole,
  allowedSeatJobs
} from '../../apps/web/components/activities/publisher-rules.ts';
import { AlbumService } from '../../apps/web/server/albums/service.ts';
import { input, id } from './support/activity-input.mjs';

test('new activity album keeps the complete 100-character title plus prefix across GAME/OFFLINE/SERIES', () => {
  const title = '长'.repeat(100),
    name = activityAlbumName(title);
  assert.equal(name.length, 107);
  assert.equal(ACTIVITY_ALBUM_NAME_LIMIT, 107);
  const bodies = [
    input({ title }),
    input({
      title,
      scene: 'GAME',
      mode: 'SERIES',
      series: { weekdays: [6], durationMinutes: 120, end: { kind: 'COUNT', count: 2 } }
    }),
    input({
      title,
      scene: 'OFFLINE',
      mode: 'SINGLE',
      category: 'SOCIAL',
      dutySelection: null,
      seats: [],
      offline: {
        location: '隔离',
        meetingInstructions: '',
        capacity: null,
        registrationClosesAt: '2030-06-01T19:00:00+08:00'
      }
    })
  ];
  for (const body of bodies)
    assert.equal(
      validateCreateActivity({ ...body, createAlbum: true, album: { name, categoryId: null } }).album.name,
      name
    );
});
test('legacy short album names stay accepted; overlength arbitrary or mismatched names are rejected', () => {
  const body = input({ title: '长'.repeat(100), createAlbum: true });
  for (const name of ['旧接口名称', '旧'.repeat(100)])
    assert.equal(validateCreateActivity({ ...body, album: { name, categoryId: null } }).album.name, name);
  for (const name of [
    '伪'.repeat(101),
    activityAlbumName('错'.repeat(100)),
    activityAlbumName(body.title) + '字'
  ])
    assert.throws(
      () => validateCreateActivity({ ...body, album: { name, categoryId: null } }),
      (e) => !!e.fieldErrors?.albumName
    );
  assert.equal(activityAlbumName('  新名称  '), '活动关联 - 新名称');
});
test('automatic weekday moves while independent manual selections persist, including overlap', () => {
  let manual = [2, 5];
  assert.deepEqual(repeatedWeekdays(manual, 1), [1, 2, 5]);
  assert.deepEqual(repeatedWeekdays(manual, 3), [2, 3, 5]);
  manual = manualWeekdaysAfterSelection([2, 3, 5, 7], manual, 3);
  assert.deepEqual(manual, [2, 5, 7]);
  assert.deepEqual(repeatedWeekdays(manual, 4), [2, 4, 5, 7]);
  assert.deepEqual(manualWeekdaysAfterSelection([2, 5], [2, 5], 2), [2, 5]);
  assert.deepEqual(repeatedWeekdays([2, 5], 7), [2, 5, 7]);
  assert.deepEqual(repeatedWeekdays([7], 7), [7]);
  assert.deepEqual(repeatedWeekdays([7], 1), [1, 7]);
});
test('fixed-seat options derive from the original template role; ANY/custom stays unrestricted', () => {
  const template = dutyPresetSeats('LIGHT');
  assert.equal(templateSeatRole(template, 0), 'TANK');
  assert.deepEqual(
    allowedSeatJobs(templateSeatRole(template, 0)),
    ACTIVITY_JOBS.filter((j) => j.role === 'TANK').map((j) => j.name)
  );
  assert.equal(templateSeatRole(template, 0), 'TANK'); // choosing JOB or ANY does not mutate the template
  assert.equal(templateSeatRole([{ groupKey: null, requirement: { kind: 'ANY' } }], 0), undefined);
  assert.equal(templateSeatRole([], 0), undefined);
  assert.deepEqual(
    allowedSeatJobs(),
    ACTIVITY_JOBS.map((j) => j.name)
  );
  for (const role of ['TANK', 'HEALER', 'DAMAGE'])
    assert.ok(
      allowedSeatJobs(role).every((name) => ACTIVITY_JOBS.find((j) => j.name === name).role === role)
    );
});

function albumHarness(linked = false) {
  const album = {
      id: id(90),
      creatorId: id(99),
      revision: 0,
      primary: 'GAME',
      categoryId: null,
      activityId: linked ? id(80) : null,
      seriesId: null,
      removedAt: null
    },
    writes = [];
  const actor = {
    id: id(98),
    accountId: id(99),
    account: { phone: 'synthetic', membership: 'MEMBER', adminRole: 'NONE' }
  };
  const tx = {
    $queryRaw: async () => [],
    album: {
      findUnique: async () => album,
      update: async ({ data }) => {
        writes.push(data);
        return { ...album, ...data };
      }
    }
  };
  const auth = {
    db: tx,
    now: () => new Date('2030-01-01'),
    transaction: async (fn) => fn(tx),
    requireAccount: async () => actor
  };
  return { service: new AlbumService(auth), album, writes };
}
test('editing an existing associated album accepts its full 107-character name without rewriting old names', async () => {
  for (const series of [false, true]) {
    const h = albumHarness(true);
    if (series) h.album.seriesId = id(70);
    const name = activityAlbumName('长'.repeat(100));
    await h.service.update(h.album.id, { name, revision: 0, primary: 'GAME', uploadsClosed: false });
    assert.equal(h.writes[0].name, name);
    await assert.rejects(
      h.service.update(h.album.id, { name: name + '字', revision: 0, primary: 'GAME', uploadsClosed: false }),
      (e) => e.status === 400
    );
  }
});
test('ordinary album creation and editing retain the original 100-character limit', async () => {
  const h = albumHarness();
  await h.service.update(h.album.id, {
    name: '普'.repeat(100),
    revision: 0,
    primary: 'GAME',
    uploadMode: 'AUTHOR',
    uploadsClosed: false
  });
  await assert.rejects(
    h.service.update(h.album.id, {
      name: '普'.repeat(101),
      revision: 0,
      primary: 'GAME',
      uploadMode: 'AUTHOR',
      uploadsClosed: false
    }),
    (e) => e.status === 400
  );
  await assert.rejects(
    h.service.create({ name: '普'.repeat(101), primary: 'GAME', uploadMode: 'AUTHOR' }),
    (e) => e.status === 400
  );
  assert.equal(h.writes.length, 1);
});
