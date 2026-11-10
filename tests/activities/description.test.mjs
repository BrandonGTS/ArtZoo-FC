import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitActivityDescription as split,
  composeActivityDescription as compose
} from '../../apps/web/components/activities/activity-description.ts';
for (const [label, value, arrangement, requirements] of [
  ['both', '原活动安排\n继续说明\n\n参与要求：\n原参与要求', '原活动安排\n继续说明', '原参与要求'],
  ['arrangement only', '正文提到参与要求：只是正文', '正文提到参与要求：只是正文', null],
  ['requirements only', '参与要求：\n只填要求', '', '只填要求'],
  ['empty', '', '', null],
  ['literal prose', '正文中的参与要求：\n不在独立分隔段', '正文中的参与要求：\n不在独立分隔段', null],
  [
    'tail kept whole',
    '安排\n\n参与要求：\n要求\n\n参与要求：\n要求内引用',
    '安排',
    '要求\n\n参与要求：\n要求内引用'
  ],
  ['unmarked CRLF', '安排\r\n\r\n参与要求：\r\n正文', '安排\r\n\r\n参与要求：\r\n正文', null],
  ['old whitespace', '  旧正文\n', '  旧正文\n', null],
  ['empty labelled tail', '安排\n\n参与要求：\n', '安排', '']
])
  test('description preserves exact legacy round trip: ' + label, () => {
    const parts = split(value);
    assert.deepEqual(parts, { arrangement, requirements });
    assert.equal(compose(parts.arrangement, parts.requirements ?? '', value), value);
  });
test('editing either field replaces its single structured segment and removing requirements keeps arrangement', () => {
  const original = '正文含参与要求：字样\n\n参与要求：\n旧要求';
  assert.equal(
    compose('正文含参与要求：字样', '新要求', original),
    '正文含参与要求：字样\n\n参与要求：\n新要求'
  );
  assert.equal(compose('新安排', '旧要求', original), '新安排\n\n参与要求：\n旧要求');
  assert.equal(compose('正文含参与要求：字样', '', original), '正文含参与要求：字样');
  assert.equal(compose('', ' 新要求 '), '参与要求：\n新要求');
});
