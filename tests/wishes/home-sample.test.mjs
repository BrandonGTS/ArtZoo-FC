import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleHomeWishIds } from '../../apps/web/server/wishes/home-sample.ts';
test('home sample handles zero and one visible wish, including the previous singleton', () => {
  assert.deepEqual(
    sampleHomeWishIds([], [], () => 0),
    []
  );
  assert.deepEqual(
    sampleHomeWishIds(['a'], [], () => 0),
    ['a']
  );
  assert.deepEqual(
    sampleHomeWishIds(['a'], ['a'], () => 0),
    ['a']
  );
});
test('two visible wishes remain distinct when previous batch consumes the pool', () => {
  assert.deepEqual(new Set(sampleHomeWishIds(['a', 'b'], ['a', 'b'], () => 0)), new Set(['a', 'b']));
  assert.equal(sampleHomeWishIds(['a', 'a', 'b'], [], () => 0).length, 2);
});
test('fresh candidates take priority and inputs stay unchanged', () => {
  const ids = ['a', 'b', 'c', 'd'],
    previous = ['a', 'b'];
  assert.deepEqual(
    sampleHomeWishIds(ids, previous, () => 0),
    ['c', 'd']
  );
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
  assert.deepEqual(previous, ['a', 'b']);
});
test('a three-item pool fills its second slot from the previous batch', () => {
  const selected = sampleHomeWishIds(['a', 'b', 'c'], ['a', 'b'], () => 0);
  assert.equal(selected[0], 'c');
  assert.equal(selected.length, 2);
  assert.equal(new Set(selected).size, 2);
});
test('every candidate including beyond the list page can be selected', () => {
  const ids = Array.from({ length: 40 }, (_, i) => String(i));
  for (let i = 0; i < ids.length; i++) {
    let count = 0;
    const selected = sampleHomeWishIds(ids, [], (max) => (count++ === 0 ? i : max - 1));
    assert.equal(selected[0], ids[i]);
    assert.equal(new Set(selected).size, 2);
  }
});
test('draws use the size of the remaining pool and never repeat in a batch', () => {
  const sizes = [];
  const selected = sampleHomeWishIds(['a', 'b', 'c', 'd'], [], (max) => {
    sizes.push(max);
    return max - 1;
  });
  assert.deepEqual(sizes, [4, 3]);
  assert.deepEqual(selected, ['d', 'c']);
});
