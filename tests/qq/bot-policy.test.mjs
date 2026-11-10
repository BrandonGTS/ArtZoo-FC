import { appendQqSignupInstruction } from '../../packages/domain/src/qq-signup-code.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  botDefaults,
  validateBotConfig,
  previewBotTemplate,
  renderBotTemplate,
  renderBotNotice,
  botPreviewValues,
  botConfigForEditing,
  botEditorStatus,
  botCanonical,
  BOT_PARAMETER_RULES,
  BOT_TEMPLATE_KINDS
} from '../../packages/domain/src/bot-management-contract.ts';
test('defaults reflect split production limits and all five classes', () => {
  const c = botDefaults();
  assert.deepEqual(c.parameters, {
    proactivePerMinute: 3,
    proactivePerDay: 100,
    passivePerUserMinute: 3,
    groupPerMinute: 10,
    pollSeconds: 10
  });
  assert.equal(Object.keys(c.notifications).length, 5);
  assert.deepEqual(validateBotConfig(c), c);
});
for (const [key, r] of Object.entries(BOT_PARAMETER_RULES))
  test(key + ' validates integer and both safety bounds', () => {
    for (const v of [r.min - 1, r.max + 1, 1.5, '3', null]) {
      const c = botDefaults();
      c.parameters[key] = v;
      assert.throws(() => validateBotConfig(c));
    }
  });
for (const k of BOT_TEMPLATE_KINDS)
  test(k + ' rejects unknown, duplicate and removable mandatory fields', () => {
    for (const v of [
      'bad {secret}',
      '{result} {result}',
      '<at>',
      'hello @all',
      'https://evil.invalid',
      '{unclosed'
    ]) {
      const c = botDefaults();
      c.templates[k] = v;
      assert.throws(() => validateBotConfig(c));
    }
  });
test('preview uses exact real renderer without executing transport', () => {
  const c = botDefaults();
  for (const k of BOT_TEMPLATE_KINDS) {
    const v = previewBotTemplate(c, k);
    assert.equal(v.simulation, true);
    assert.ok(v.text);
    if (['PUBLISHED', 'CHANGED', 'REMINDER_2H', 'REMINDER_1H'].includes(k)) {
      assert.ok(!v.text.includes('回复本条消息'));
      assert.ok(!v.text.includes('地点：'));
    }
  }
  c.templates.SIGNUP_FAILURE = '操作未完成：{result}';
  assert.equal(
    renderBotTemplate(c, 'SIGNUP_FAILURE', { result: '截止 <source> @all' }),
    '截止 ＜source＞ ＠all'
  );
});
test('config cannot smuggle credential, target or role fields', () => {
  for (const x of [
    { ...botDefaults(), secret: 'no' },
    { ...botDefaults(), targetGroup: 'elsewhere' },
    { ...botDefaults(), parameters: { ...botDefaults().parameters, role: 'ADMIN' } }
  ])
    assert.throws(() => validateBotConfig(x));
});
test('canonical digest is byte-stable for Python sorted-key wire JSON', () => {
  const c = botDefaults();
  const reversed = Object.fromEntries(Object.entries(c).reverse());
  assert.equal(botCanonical(c), botCanonical(reversed));
  assert.match(createHash('sha256').update(botCanonical(c)).digest('hex'), /^[a-f0-9]{64}$/);
});

test('seven Chinese activity fields substitute pure values without hidden instructions', () => {
  const c = botDefaults();
  c.templates.PUBLISHED = '{消息类别}|{活动标题}|{活动时间}|{活动地点}|{副本名称}|{人数信息}|{报名情况}';
  const v = botPreviewValues('PUBLISHED');
  assert.equal(
    renderBotNotice(c, 'PUBLISHED', v),
    [v.event, v.title, v.time, v.location, v.duty, v.capacity, v.registrations].join('|')
  );
  assert.equal(
    renderBotNotice(c, 'PUBLISHED', { ...v, location: '' }),
    [v.event, v.title, v.time, '', v.duty, v.capacity, v.registrations].join('|')
  );
});
test('empty location preserves user literals and empty lines exactly', () => {
  const c = botDefaults();
  c.templates.PUBLISHED = '用户正文\n地点：{活动地点}\n\n结束';
  assert.equal(renderBotNotice(c, 'PUBLISHED', { location: '' }), '用户正文\n地点：\n\n结束');
  c.templates.PUBLISHED = '{活动地点}';
  assert.equal(renderBotNotice(c, 'PUBLISHED', { location: '' }), '');
});
test('activity literals are user-owned, unknown variable fails and reply result remains mandatory', () => {
  const c = botDefaults();
  c.templates.PUBLISHED = '完全手写的活动通知';
  assert.equal(renderBotNotice(c, 'PUBLISHED', {}), '完全手写的活动通知');
  c.templates.PUBLISHED = '{notAField}';
  assert.throws(() => validateBotConfig(c));
  c.templates.PUBLISHED = '{活动标题}';
  c.templates.BINDING = '绑定完成';
  assert.throws(() => validateBotConfig(c));
});
test('legacy aliases normalize for editing without changing persisted object', () => {
  const c = botDefaults();
  c.templates.PUBLISHED = '{event}\n{title}\n{time}\n{location}';
  c.templates.BINDING = '{result}';
  const v = botConfigForEditing(c);
  assert.equal(v.templates.PUBLISHED, '{消息类别}\n{活动标题}\n{活动时间}\n{活动地点}');
  assert.equal(v.templates.BINDING, '{操作结果}');
  assert.equal(c.templates.BINDING, '{result}');
  assert.throws(() =>
    validateBotConfig({ ...v, templates: { ...v.templates, PUBLISHED: '{location}{活动地点}' } })
  );
});
test('preview preserves exact custom substitutions and appends only the system signup instruction to notices', () => {
  const c = botDefaults();
  for (const k of BOT_TEMPLATE_KINDS) {
    const rendered = renderBotTemplate(c, k, botPreviewValues(k));
    assert.equal(
      previewBotTemplate(c, k).text,
      ['PUBLISHED', 'CHANGED', 'CANCELLED', 'REMINDER_2H', 'REMINDER_1H'].includes(k)
        ? appendQqSignupInstruction(rendered, '7K4M2Q9R', 'GAME', 'LIGHT', k === 'CANCELLED')
        : rendered
    );
  }
  assert.equal(renderBotTemplate(c, 'BINDING', { result: '原始{操作结果}协议值' }), '原始{操作结果}协议值');
});

test('prototype names are rejected as unknown fields before save or preview', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const c = botDefaults();
    c.templates.PUBLISHED = '{' + name + '}';
    assert.throws(() => validateBotConfig(c));
    assert.throws(() => previewBotTemplate(c, 'PUBLISHED'));
  }
});
test('old unpublished draft and concurrent publication cannot be displayed as applied', () => {
  const pub = botDefaults(),
    oldDraft = botDefaults();
  oldDraft.parameters.proactivePerMinute = 4;
  assert.equal(botEditorStatus(oldDraft, pub, 'APPLIED'), 'UNSAVED');
  assert.equal(botEditorStatus(pub, pub, 'APPLIED'), 'APPLIED');
  assert.equal(botEditorStatus(pub, oldDraft, 'APPLIED'), 'UNSAVED');
  assert.equal(botEditorStatus(pub, pub, 'APPLIED', false, true), 'CHANGED');
  assert.equal(botEditorStatus(pub, pub, 'PENDING'), 'PENDING');
  assert.equal(botEditorStatus(pub, pub, 'STALE'), 'STALE');
});
