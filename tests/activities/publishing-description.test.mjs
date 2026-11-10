import assert from 'node:assert/strict';
import test from 'node:test';
import {
  splitActivityDescription,
  composeActivityDescription,
  missingActivityDescriptionFields
} from '../../apps/web/lib/activity-description.ts';

test('new publishing requires a nonempty arrangement and requirements', () => {
  assert.deepEqual(missingActivityDescriptionFields(''), { arrangement: true, requirements: true });
  assert.deepEqual(missingActivityDescriptionFields('安排'), { arrangement: false, requirements: true });
  assert.deepEqual(missingActivityDescriptionFields('参与要求：\n要求'), {
    arrangement: true,
    requirements: false
  });
  assert.deepEqual(missingActivityDescriptionFields('安排\n\n参与要求：\n   '), {
    arrangement: false,
    requirements: true
  });
  assert.deepEqual(missingActivityDescriptionFields('  \n\n参与要求：\n要求'), {
    arrangement: true,
    requirements: false
  });
  assert.deepEqual(missingActivityDescriptionFields(composeActivityDescription('安排', '要求')), {
    arrangement: false,
    requirements: false
  });
});

test('old description edits preserve original bytes and do not invent requirements', () => {
  for (const original of ['', '历史安排', '  原有换行\n内容  ', '安排\n\n参与要求：\n要求']) {
    const parts = splitActivityDescription(original);
    assert.equal(composeActivityDescription(parts.arrangement, parts.requirements ?? '', original), original);
  }
});
