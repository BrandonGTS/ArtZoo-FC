import test from 'node:test';
import assert from 'node:assert/strict';
import { BUTTON_PROBE_TEXT, buttonProbeOpen } from '../../apps/web/server/bot-management/button-probe.ts';
import { parseQqSignup } from '../../apps/web/server/qq-official/signup-parser.ts';
const now = new Date('2030-06-01T10:00:00Z'),
  config = { mode: 'live' };
test('probe is default closed with an absolute deadline bounded to thirty minutes', () => {
  assert.equal(buttonProbeOpen(config, now), false);
  for (const minutes of [0, -1, 31])
    assert.equal(
      buttonProbeOpen({ ...config, buttonProbeUntil: new Date(now.getTime() + minutes * 60000) }, now),
      false
    );
  for (const minutes of [1, 30])
    assert.equal(
      buttonProbeOpen({ ...config, buttonProbeUntil: new Date(now.getTime() + minutes * 60000) }, now),
      true
    );
  assert.equal(
    buttonProbeOpen({ mode: 'simulation', buttonProbeUntil: new Date(now.getTime() + 60000) }, now),
    false
  );
});
test('probe is clearly labeled and its fixed sample can never pass signup grammar', () => {
  assert.ok(BUTTON_PROBE_TEXT.startsWith('【按钮预填测试，不会报名】'));
  assert.ok(BUTTON_PROBE_TEXT.includes('请勿发送'));
  assert.throws(() => parseQqSignup('报名 测试编号 MT 骑士'));
});
