import test from 'node:test';
import assert from 'node:assert/strict';
import { QqBridgeService } from '../../apps/web/server/qq-official/bridge.ts';
import { botDefaults } from '../../packages/domain/src/index.ts';
const service = new QqBridgeService({}, { mode: 'disabled', target: null, bridgeSecret: null });
const row = {
  kind: 'PUBLISHED',
  payload: {
    activityTitle: '公开合成活动',
    startsAt: '2031-06-01T12:00:00Z',
    endsAt: '2031-06-01T14:00:00Z',
    location: '合成地点',
    scene: 'GAME'
  }
};
test('unpublished production keeps exact previous five-class rendering until a real publish', () => {
  assert.equal(
    service.render(row),
    '活动发布\n公开合成活动\n开始：2031/06/01 20:00（北京时间）\n地点：合成地点\n回复本条消息发送“报名 席位 职业”；24人活动需填写队伍，例如“报名 A队 H1 白魔”'
  );
  const cancel = service.render({ ...row, kind: 'CANCELLED' });
  assert.match(cancel, /^活动取消/);
  assert.ok(!cancel.includes('回复本条'));
});
test('explicit published policy uses pure user template while old renderer remains untouched', () => {
  const cfg = botDefaults();
  cfg.templates.PUBLISHED = '本人文案|{活动标题}|{活动地点}';
  assert.equal(service.render(row, cfg), '本人文案|公开合成活动|合成地点');
  assert.ok(service.render(row).includes('地点：'));
});
