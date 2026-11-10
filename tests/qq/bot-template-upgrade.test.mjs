import test from 'node:test';
import assert from 'node:assert/strict';
import {
  botDefaults,
  BOT_REPLY_KINDS,
  BOT_NOTICE_KINDS
} from '../../packages/domain/src/bot-management-contract.ts';
import {
  upgradeTemplateText,
  planBotTemplateUpgrade,
  planPendingReminderTemplateUpgrade
} from './support/bot-template-upgrade.mjs';
test('append only missing fields, preserve aliases and every existing byte, repeat is a no-op', () => {
  const prefix = ' prefix  \n{arrangement}\n';
  assert.equal(upgradeTemplateText(prefix), prefix + '\n参与要求：{参与要求}');
  const both = 'x{活动安排}|{participationRequirements}\n ';
  assert.equal(upgradeTemplateText(both), both);
  const first = upgradeTemplateText('original\n ');
  assert.ok(first.startsWith('original\n '));
  assert.equal(upgradeTemplateText(first), first);
});
test('all five notices and dynamic reminders upgrade; historical fixed strings stay identical', () => {
  const c = botDefaults();
  for (const k of BOT_NOTICE_KINDS) c.templates[k] = 'old ' + k;
  for (const k of BOT_REPLY_KINDS) c.templates[k] = 'historical {result} suffix';
  c.reminders = [{ id: 'r1', minutes: 30, enabled: true, template: 'old reminder' }];
  const before = structuredClone(c),
    p = planBotTemplateUpgrade(c);
  assert.equal(p.changes.length, 6);
  assert.deepEqual(c, before);
  for (const k of BOT_REPLY_KINDS) assert.equal(p.config.templates[k], c.templates[k]);
  assert.deepEqual(planBotTemplateUpgrade(p.config).changes, []);
});
test('title conflicts and limits reject without including private body text', () => {
  for (const text of ['private\n活动安排：old', 'private\n参与要求\nold'])
    assert.throws(
      () => upgradeTemplateText(text),
      (e) => e.code === 'TEMPLATE_TITLE_CONFLICT' && !e.message.includes('private')
    );
  assert.throws(
    () => upgradeTemplateText('x'.repeat(299)),
    (e) => e.code === 'TEMPLATE_LENGTH_LIMIT'
  );
  const c = botDefaults();
  for (const k of BOT_NOTICE_KINDS) c.templates[k] = '文'.repeat(220);
  c.reminders = Array.from({ length: 3 }, (_, i) => ({
    id: 'r' + i,
    minutes: i + 1,
    enabled: true,
    template: '文'.repeat(220)
  }));
  // Source under limit, appended multibyte headings take total beyond 6500.
  assert.ok(new TextEncoder().encode(JSON.stringify(c)).byteLength <= 6500);
  assert.throws(
    () => planBotTemplateUpgrade(c),
    (e) => e.code === 'CONFIG_LENGTH_LIMIT'
  );
});
test('only precise scope pending zero-attempt unrendered reminder payloads are eligible', () => {
  const base = {
      id: 'id',
      appId: 'a',
      botId: 'b',
      groupOpenId: 'g',
      status: 'PENDING',
      attempts: 0,
      renderedContent: null,
      kind: 'REMINDER',
      payload: { reminder: { template: 'old' }, other: 'same' }
    },
    scope = { appId: 'a', botId: 'b', groupOpenId: 'g' };
  for (const change of [
    { attempts: 1 },
    { renderedContent: '' },
    { status: 'UNKNOWN' },
    { status: 'CLAIMED' },
    { status: 'SENT' },
    { status: 'CANCELLED' },
    { groupOpenId: 'other' },
    { kind: 'PUBLISHED' }
  ])
    assert.equal(planPendingReminderTemplateUpgrade([{ ...base, ...change }], [scope]).length, 0);
  const p = planPendingReminderTemplateUpgrade([base], [scope])[0];
  assert.deepEqual(p.before, base);
  assert.equal(p.afterPayload.other, 'same');
});
