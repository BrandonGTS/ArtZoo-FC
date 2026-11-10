import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  publishInput,
  key,
  pageNumber,
  wishContent,
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
  assert.equal(input.wantedContent, '');
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
test('legacy content projects without mutation and avoids duplicate merge on edit', () => {
  const old = { body: '旧想法', wantedContent: '旧内容' },
    copy = { ...old };
  assert.equal(wishContent(old), '旧想法\n旧内容');
  assert.deepEqual(old, copy);
  assert.equal(wishContent({ body: '同样内容', wantedContent: '同样内容' }), '同样内容');
  assert.equal(wishContent({ body: '前文\n旧内容', wantedContent: '旧内容' }), '前文\n旧内容');
  assert.equal(wishContent({ body: '行一\r\n行二', wantedContent: '行一\n行二' }), '行一\n行二');
  assert.equal(wishContent({ wantedContent: '仅旧内容' }), '仅旧内容');
  const merged = publishInput({ ...valid(), ...old });
  assert.equal(merged.body, '旧想法\n旧内容');
  assert.equal(merged.wantedContent, '');
  assert.equal(
    publishInput({ ...valid(), body: merged.body, wantedContent: old.wantedContent }).body,
    merged.body
  );
  const largest = publishInput({ ...valid(), body: '甲'.repeat(10000), wantedContent: '乙'.repeat(1000) });
  assert.equal(largest.body.length, WISH_CONTENT_MAX);
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
