import test from 'node:test';
import assert from 'node:assert/strict';
import { locateComponent, inspectSnapshot } from '../../scripts/deployment-media-identity.mjs';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('diagnostic maps every deployed file namespace and rejects unknown or traversing keys', () => {
  for (const [namespace, prefix, folder] of [
    ['daily', 'daily', 'daily'],
    ['wish', 'wish', 'wishes'],
    ['knowledge', 'knowledge', 'knowledge'],
    ['album-comment', 'album-comment', 'albums'],
    ['album-photo', 'album-photo', 'albums'],
    ['official-image', 'official', 'official-events'],
    ['lottery-image', `lottery:${id}`, 'lotteries']
  ]) {
    for (const variant of ['original', 'preview', 'thumbnail']) {
      const part = `${namespace === 'official-image' ? 'official' : 'photo'}-${variant}`;
      assert.equal(
        locateComponent({ namespace, objectKey: `${prefix}:${id}`, part }).directory,
        `${variant === 'original' ? 'original' : 'derived'}/${folder}`
      );
    }
  }
  assert.equal(
    locateComponent({ namespace: 'avatar', objectKey: `avatar:${id}`, part: 'avatar-full' }).directory,
    'avatars'
  );
  assert.equal(
    locateComponent({ namespace: 'knowledge', objectKey: `knowledge:${id}`, part: 'knowledge-journal' })
      .directory,
    'original/knowledge'
  );
  for (const objectKey of ['daily:../../secrets', `wish:${id}`, `daily:${id}:extra`])
    assert.equal(locateComponent({ namespace: 'daily', objectKey, part: 'photo-original' }), null);
});
test('missing identities stay unchecked; credited, aggregate and database-only records are counted separately', async () => {
  const rows = [
    { type: 'baseline', fingerprint: null },
    { type: 'component', namespace: 'daily', objectKey: `daily:${id}`, part: 'photo-original' },
    { type: 'component', credited: true },
    { type: 'component', namespace: 'baseline', part: 'aggregate' },
    { type: 'component', namespace: 'quick-icon-auto', part: 'quick-icon-bytea' },
    { type: 'end' }
  ];
  const report = await inspectSnapshot(rows.map(JSON.stringify));
  assert.equal(report.components.consistent, 0);
  assert.equal(report.components.unchecked, 1);
  assert.equal(report.baseline.unchecked, 1);
  assert.equal(report.skippedCredited, 1);
  assert.equal(report.skippedAggregate, 1);
  assert.equal(report.skippedDatabase, 1);
  for (const bad of [
    [],
    ['secret-invalid-json'],
    rows.slice(0, -1).map(JSON.stringify),
    [...rows, { type: 'end' }].map(JSON.stringify)
  ])
    await assert.rejects(inspectSnapshot(bad));
});
