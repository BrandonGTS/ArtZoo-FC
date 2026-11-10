import { appendQqSignupInstruction } from '../../packages/domain/src/qq-signup-code.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_NOTICE_KINDS,
  BOT_REPLY_KINDS,
  botDefaults,
  botPreviewValues,
  botConfigForEditing,
  botReminders,
  validateBotConfig,
  previewBotTemplate,
  renderBotNotice,
  renderBotReminder,
  renderBotTemplate
} from '../../packages/domain/src/bot-management-contract.ts';
import {
  loadQqActivitySnapshot,
  planQqActivityNotifications,
  qqScheduleFingerprint
} from '../../packages/db/src/qq-official-notifications.ts';

test('all notice defaults and preview expose each actual description field once', () => {
  const c = botDefaults();
  for (const kind of BOT_NOTICE_KINDS) {
    for (const label of ['活动安排', '参与要求'])
      assert.equal(c.templates[kind].split('{' + label + '}').length - 1, 1);
    const values = botPreviewValues(kind),
      text = previewBotTemplate(c, kind).text;
    assert.ok(text.includes(values.arrangement));
    assert.ok(text.includes(values.participationRequirements));
    assert.equal(
      text,
      appendQqSignupInstruction(
        renderBotNotice(c, kind, values),
        '7K4M2Q9R',
        'GAME',
        'LIGHT',
        kind === 'CANCELLED'
      )
    );
  }
  for (const reminder of botReminders(c))
    assert.ok(
      renderBotReminder(c, reminder, botPreviewValues('REMINDER_2H')).includes('先讲解机制\n再练习通关')
    );
});

test('both new fields preserve multiline text and neutralize mention and markup without recursion', () => {
  const c = botDefaults();
  c.templates.PUBLISHED = '{活动安排}|{参与要求}';
  assert.equal(
    renderBotNotice(c, 'PUBLISHED', {
      arrangement: '首行\r\n@all <at>\u0000{参与要求}',
      participationRequirements: '装备\n食物 >'
    }),
    '首行\n＠all ＜at＞ {参与要求}|装备\n食物 ＞'
  );
  assert.equal(renderBotNotice(c, 'PUBLISHED', { arrangement: '', participationRequirements: '' }), '|');
  c.templates.PUBLISHED = '{arrangement}|{participationRequirements}';
  assert.equal(
    renderBotNotice(c, 'PUBLISHED', { arrangement: 'A\nB', participationRequirements: 'C\nD' }),
    'A\nB|C\nD'
  );
  for (const template of ['{arrangement}{活动安排}', '{participationRequirements}{参与要求}'])
    assert.throws(() => validateBotConfig({ ...c, templates: { ...c.templates, PUBLISHED: template } }));
});

test('custom reminder preview and send use new fields identically including empty fields', () => {
  const c = botConfigForEditing(botDefaults()),
    r = c.reminders[0];
  r.template = '{arrangement}\n{participationRequirements}';
  assert.equal(
    previewBotTemplate(c, 'reminder:' + r.id).text,
    appendQqSignupInstruction(
      renderBotReminder(c, r, botPreviewValues('REMINDER_2H')),
      '7K4M2Q9R',
      'GAME',
      'LIGHT'
    )
  );
  assert.equal(renderBotReminder(c, r, {}), '');
});

test('historical fixed replies remain stored and editable normalization never replaces their literals', () => {
  const c = botDefaults();
  for (const kind of BOT_REPLY_KINDS) c.templates[kind] = '旧自定义前缀 {result} 后缀';
  const before = JSON.stringify(c),
    editing = botConfigForEditing(c);
  for (const kind of BOT_REPLY_KINDS) {
    assert.equal(editing.templates[kind], '旧自定义前缀 {操作结果} 后缀');
    assert.equal(renderBotTemplate(c, kind, { result: '真实结果 @all <tag>' }), '真实结果 ＠all ＜tag＞');
    assert.equal(previewBotTemplate(c, kind).text, botPreviewValues(kind).result);
  }
  assert.equal(JSON.stringify(c), before);
  assert.deepEqual(validateBotConfig(c), c);
});

test('immutable activity projection requests the existing structured description without new database columns', async () => {
  const activity = { id: 'fixture', description: '真实安排\n第二行\n\n参与要求：\n真实要求' },
    calls = [];
  const result = await loadQqActivitySnapshot(
    {
      activity: {
        findUnique: async (arg) => {
          calls.push(arg);
          return activity;
        }
      }
    },
    activity.id
  );
  assert.equal(result, activity);
  assert.equal(calls[0].select.description, true);
  assert.equal(calls[0].select.arrangement, undefined);
  assert.equal(calls[0].select.participationRequirements, undefined);
});

test('description changes do not change schedule fingerprint or delivery identity and time', () => {
  const a = {
    id: 'fixture',
    revision: 1,
    title: '活动',
    scene: 'GAME',
    mode: 'SINGLE',
    startsAt: new Date('2030-06-01T04:00Z'),
    endsAt: new Date('2030-06-01T05:00Z'),
    createdAt: new Date('2030-05-01'),
    cancelledAt: null,
    description: '旧正文'
  };
  const b = { ...a, description: '新安排\n\n参与要求：\n新要求' },
    now = new Date('2030-06-01T00:00Z'),
    target = {
      appId: 'app',
      botId: 'bot',
      groupOpenId: 'group',
      enabled: true,
      enabledAt: new Date('2030-01-01'),
      testGroupOnly: true
    };
  assert.equal(qqScheduleFingerprint(a), qqScheduleFingerprint(b));
  assert.deepEqual(
    planQqActivityNotifications(a, 'PUBLISHED', target, now),
    planQqActivityNotifications(b, 'PUBLISHED', target, now)
  );
});
