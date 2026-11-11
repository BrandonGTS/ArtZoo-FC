import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  publishInput,
  key,
  pageNumber,
  wishCategory,
  WISH_CATEGORIES,
  WISH_CONTENT_MAX
} from '../../apps/web/server/wishes/contract.ts';
const valid = () => ({
  idempotencyKey: randomUUID(),
  title: ' 一起钓鱼 ',
  category: 'OTHER',
  body: '想玩的内容',
  convenientTime: '周末晚上或有空时'
});
test('category, unified content and free text time are required', () => {
  const input = publishInput(valid());
  assert.equal(input.title, '一起钓鱼');
  assert.equal('wantedContent' in input, false);
  assert.equal(input.convenientTime, '周末晚上或有空时');
  for (const extra of [
    { category: null },
    { category: 'UNKNOWN' },
    { body: '' },
    { convenientTime: '' },
    { category: undefined }
  ])
    assert.throws(
      () => publishInput({ ...valid(), ...extra }),
      (e) => e.code === 'VALIDATION_ERROR'
    );
  assert.equal(wishCategory(null, true), null);
  assert.equal(WISH_CATEGORIES.length, 6);
});
test('content is normalized once and the retired second content field is rejected', () => {
  assert.equal(publishInput({ ...valid(), body: ' 行一\r\n行二 ' }).body, '行一\n行二');
  assert.equal(
    publishInput({ ...valid(), body: '甲'.repeat(WISH_CONTENT_MAX) }).body.length,
    WISH_CONTENT_MAX
  );
  for (const wantedContent of ['', '旧内容'])
    assert.throws(
      () => publishInput({ ...valid(), wantedContent }),
      (e) => e.code === 'VALIDATION_ERROR'
    );
});
test('invalid fields, oversized and non-text inputs are rejected', () => {
  for (const extra of [
    { status: 'CLOSED' },
    { capacity: 8 },
    { draft: true },
    { organizerId: randomUUID() },
    { activityId: randomUUID() },
    { title: ' ' },
    { body: 'x'.repeat(WISH_CONTENT_MAX + 1) },
    { title: 7 },
    { wantedContent: [] },
    { convenientTime: 'x'.repeat(501) }
  ])
    assert.throws(
      () => publishInput({ ...valid(), ...extra }),
      (e) => e.code === 'VALIDATION_ERROR'
    );
});
test('bounded pagination and UUID commands reject hostile values', () => {
  for (const value of ['0', '-1', '1.1', '1000000', '1 OR 1=1']) assert.throws(() => pageNumber(value));
  for (const value of [null, 'key', {}, '/wishes']) assert.throws(() => key(value));
  assert.equal(pageNumber(null), 1);
});
