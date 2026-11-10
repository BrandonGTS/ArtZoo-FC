import test from 'node:test';
import assert from 'node:assert/strict';
import { BotGroupService } from '../../apps/web/server/bot-management/groups.ts';
const now = new Date('2031-06-01T10:00:00Z');
const auth = {
  now: () => now,
  rate: async () => {
    throw Object.assign(new Error('synthetic gate'), { code: 'REACHED_RATE_GATE' });
  }
};
const cfg = {
  mode: 'simulation',
  managedGroups: true,
  bridgeSecret: 'public-synthetic-signing-only-0000000',
  target: {
    appId: 'mock_app',
    botId: 'mock_bot',
    groupOpenId: 'mock_group',
    enabled: true,
    testGroupOnly: true,
    enabledAt: new Date(0),
    deliveryMode: 'SIMULATION'
  }
};
const svc = new BotGroupService(auth, cfg);
const body = (eventLength, indexLength) => ({
  app_id: 'mock_app',
  bot_id: 'mock_bot',
  group_openid: 'mock_new_group',
  simulation: true,
  sender_openid: 'mock_member',
  event_id: 'E'.repeat(eventLength),
  message_idx: 'I'.repeat(indexLength),
  event_timestamp: now.toISOString(),
  content: '绑定群 mock_public_code1234'
});
for (const length of [128, 129, 256])
  test('new group proof matches original 256 identifier boundary ' + length, async () => {
    await assert.rejects(
      () => svc.proof(body(length, length)),
      (e) => e.code === 'REACHED_RATE_GATE'
    );
  });
for (const field of ['event_id', 'message_idx'])
  test('new proof rejects 257 with field name only ' + field, async () => {
    const b = body(20, 20);
    b[field] = 'E'.repeat(257);
    await assert.rejects(
      () => svc.proof(b),
      (e) =>
        e.code === 'VALIDATION_ERROR' &&
        Object.keys(e.fieldErrors).join() === field &&
        !JSON.stringify(e.fieldErrors).includes('EEE')
    );
  });
test('group/member/code boundary is unchanged', async () => {
  for (const field of ['group_openid', 'sender_openid']) {
    const b = body(20, 20);
    b[field] = 'mock_' + 'X'.repeat(160);
    await assert.rejects(
      () => svc.proof(b),
      (e) => e.code === 'VALIDATION_ERROR'
    );
  }
  const b = body(20, 20);
  b.content = '绑定群 ' + 'X'.repeat(129);
  await assert.rejects(
    () => svc.proof(b),
    (e) => e.code === 'FORBIDDEN'
  );
});
