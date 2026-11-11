import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateCreateActivity, safeAccountReturnTo, messageId } from '../../packages/domain/src/index.ts';
const input = () => ({
  idempotencyKey: randomUUID(),
  title: 'Synthetic integration',
  description: '',
  category: 'SOCIAL',
  startsAt: '2030-12-30T20:00:00+08:00',
  endsAt: '2030-12-30T22:00:00+08:00',
  seats: [{ kind: 'ANY' }],
  dutySelection: null
});
test('optional linked album is strict boolean and preserves canonical legacy false/missing request', () => {
  const b = input();
  assert.deepEqual(validateCreateActivity(b), validateCreateActivity({ ...b, createAlbum: false }));
  assert.equal(
    validateCreateActivity({ ...b, createAlbum: true, album: { name: 'Synthetic album', categoryId: null } })
      .createAlbum,
    true
  );
  assert.throws(() => validateCreateActivity({ ...b, createAlbum: true }));
  assert.throws(() => validateCreateActivity({ ...b, createAlbum: true, album: { name: 'x' } }));
  assert.throws(() => validateCreateActivity({ ...b, album: { name: 'x', categoryId: null } }));
  for (const createAlbum of ['true', 1, null, {}, []])
    assert.throws(() => validateCreateActivity({ ...b, createAlbum }));
});
test('album return destinations allow only implemented internal routes and exact validated query', () => {
  const id = randomUUID(),
    photo = randomUUID();
  for (const v of [
    '/albums',
    '/featured',
    '/admin/featured',
    `/albums/${id}`,
    `/albums/${id}?photoId=${photo}`,
    `/albums/${id}?periodActivityId=${photo}`,
    `/albums/${id}?comments=1`
  ])
    assert.equal(safeAccountReturnTo(v), v);
  for (const v of [
    `/albums/${id}/edit`,
    `/albums/${id}?returnTo=//evil.invalid`,
    `/albums/${id}?photoId=${photo}&photoId=${photo}`,
    `/albums/${id}?comments=1#other`,
    '//evil.invalid/albums',
    '/albums/../admin',
    '/admin/album-categories'
  ])
    assert.equal(safeAccountReturnTo(v), '/');
  assert.equal(messageId('album:' + id).source, 'album');
});
