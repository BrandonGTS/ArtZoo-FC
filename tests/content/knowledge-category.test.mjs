import test from 'node:test';
import assert from 'node:assert/strict';
import { metadata, requiredCategoryId, id } from '../../apps/web/server/knowledge/contract.ts';
const category = '51000000-0000-4000-8000-000000000001';
const meta = { title: '合成标题', jobs: [], playstyles: [], gameVersions: [], editMode: 'AUTHOR' };
for (const value of [undefined, null, '', '  ', '\n\t'])
  test('empty category has semantic error: ' + JSON.stringify(value), () =>
    assert.throws(
      () => metadata({ ...meta, categoryId: value }),
      (e) => e.code === 'VALIDATION_ERROR' && e.message === '请选择分区'
    )
  );
for (const value of ['not-a-uuid', 123, false, [], {}])
  test('malformed category keeps ID validation: ' + JSON.stringify(value), () =>
    assert.throws(
      () => requiredCategoryId(value),
      (e) => e.message === '标识无效'
    )
  );
test('valid category normalization and generic ID errors remain unchanged', () => {
  assert.equal(requiredCategoryId(category.toUpperCase()), category);
  assert.equal(metadata({ ...meta, categoryId: category }).title, meta.title);
  assert.throws(() => id(undefined), /标识无效/);
  assert.throws(() => metadata({ ...meta, title: '', categoryId: category }), /文字内容为空或过长/);
});
