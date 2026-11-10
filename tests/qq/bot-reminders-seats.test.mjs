import { appendQqSignupInstruction } from '../../packages/domain/src/qq-signup-code.ts';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  botDefaults,
  botConfigForEditing,
  validateBotConfig,
  botReminders,
  botCanonical,
  previewBotTemplate,
  renderBotReminder,
  botPreviewValues,
  renderBotNotice
} from '../../packages/domain/src/bot-management-contract.ts';
import { botTeamValues } from '../../packages/domain/src/bot-team-values.ts';
import { dutyPresetSeats } from '../../packages/domain/src/duty-contract.ts';
import {
  planQqActivityNotifications,
  validateQqDelivery
} from '../../packages/db/src/qq-official-notifications.ts';
const target = {
  appId: 'mock_app',
  botId: 'mock_bot',
  groupOpenId: 'mock_group',
  enabled: true,
  enabledAt: new Date('2030-01-01'),
  testGroupOnly: true
};
const now = new Date('2030-06-01T00:00:00Z'),
  activity = {
    id: 'mock_activity',
    revision: 1,
    title: '活动',
    scene: 'GAME',
    mode: 'SINGLE',
    startsAt: new Date('2030-06-01T04:00:00Z'),
    endsAt: new Date('2030-06-01T05:00:00Z'),
    createdAt: new Date('2030-05-01'),
    cancelledAt: null
  };
const planned = (rules, a = activity, t = now) =>
  planQqActivityNotifications(a, 'REMINDERS', target, t, rules);
test('old wire and digest are unchanged until explicit edit/save', () => {
  const c = botDefaults(),
    raw = botCanonical(c),
    digest = createHash('sha256').update(raw).digest('hex');
  assert.equal(Object.hasOwn(validateBotConfig(c), 'reminders'), false);
  const edited = botConfigForEditing(c);
  assert.deepEqual(
    edited.reminders.map((x) => x.minutes),
    [120, 60]
  );
  assert.equal(botCanonical(c), raw);
  assert.equal(
    createHash('sha256')
      .update(botCanonical(validateBotConfig(c)))
      .digest('hex'),
    digest
  );
  assert.deepEqual(validateBotConfig(edited), edited);
});
test('bounded zero-to-eight reminder rows, distinct immutable IDs and minutes, safe templates', () => {
  const c = botConfigForEditing(botDefaults());
  assert.deepEqual(validateBotConfig({ ...c, reminders: [] }).reminders, []);
  for (const minutes of [0, 10081, 1.5, NaN, null, '30'])
    assert.throws(() => validateBotConfig({ ...c, reminders: [{ ...c.reminders[0], minutes }] }));
  for (const patch of [
    { id: '' },
    { id: 'bad:id' },
    { id: 'x'.repeat(65) },
    { enabled: 1 },
    { template: '{secret}' }
  ])
    assert.throws(() => validateBotConfig({ ...c, reminders: [{ ...c.reminders[0], ...patch }] }));
  assert.throws(() =>
    validateBotConfig({
      ...c,
      reminders: [c.reminders[0], { ...c.reminders[1], minutes: 120, enabled: false }]
    })
  );
  assert.throws(() =>
    validateBotConfig({ ...c, reminders: [c.reminders[0], { ...c.reminders[1], id: c.reminders[0].id }] })
  );
  assert.throws(() =>
    validateBotConfig({
      ...c,
      reminders: Array.from({ length: 9 }, (_, i) => ({ ...c.reminders[0], id: 'r' + i, minutes: i + 1 }))
    })
  );
});
test('arbitrary minute schedules are absolute, stable across reorder/id/template and signup revision', () => {
  const rules = [
      { id: 'r30', minutes: 30, enabled: true, template: '{消息类别} {活动标题}' },
      { id: 'r120', minutes: 120, enabled: true, template: '提醒' }
    ],
    p = planned(rules);
  assert.deepEqual(
    p.map((x) => x.dueAt.toISOString()),
    ['2030-06-01T03:30:00.000Z', '2030-06-01T02:00:00.000Z']
  );
  assert.ok(p.every((x) => x.kind === 'REMINDER'));
  assert.equal(p[0].payload.reminder.id, 'r30');
  const renamed = planned([{ ...rules[0], id: 'new', template: '新模板' }], {
    ...activity,
    revision: 99,
    title: '新标题'
  })[0];
  assert.equal(renamed.eventKey, p[0].eventKey);
  assert.notEqual(planned([{ ...rules[0], minutes: 15 }])[0].eventKey, p[0].eventKey);
  assert.notEqual(
    planned(rules, {
      ...activity,
      startsAt: new Date('2030-06-01T05:00Z'),
      endsAt: new Date('2030-06-01T06:00Z')
    })[0].eventKey,
    p[0].eventKey
  );
});
test('no late catchup, disabled/deleted rows, old activities, series second period and cancellation', () => {
  const r = botReminders(botDefaults());
  assert.equal(planned([], activity).length, 0);
  assert.equal(planned(r.map((x) => ({ ...x, enabled: false }))).length, 0);
  for (const t of [
    new Date('2030-06-01T03:00Z'),
    new Date('2030-06-01T03:01Z'),
    new Date('2030-06-01T05:00Z')
  ])
    assert.equal(planned([{ ...r[1] }], activity, t).length, 0);
  assert.equal(planned(r, { ...activity, createdAt: new Date('2029-01-01') }).length, 0);
  assert.equal(planned(r, { ...activity, cancelledAt: now }).length, 0);
  assert.equal(
    planned(r, {
      ...activity,
      mode: 'SERIES',
      seriesId: 's',
      periodNumber: 2,
      series: {
        activities: [
          { id: 'first', periodNumber: 1 },
          { id: activity.id, periodNumber: 2 }
        ]
      }
    }).length,
    0
  );
  const p = planned(r)[0];
  const d = { ...p, createdAt: now };
  assert.equal(
    validateQqDelivery(
      d,
      {
        ...activity,
        mode: 'SERIES',
        seriesId: 's',
        series: {
          activities: [
            { id: 'old', periodNumber: 1 },
            { id: activity.id, periodNumber: 2 }
          ]
        }
      },
      target,
      p.dueAt
    ),
    'CANCELLED'
  );
  assert.equal(validateQqDelivery(d, activity, target, p.expiresAt), 'EXPIRED');
});
const seats = (composition) =>
  dutyPresetSeats(composition).map((p, position) => ({
    position,
    groupKey: p.groupKey,
    ...p.requirement,
    registration: null
  }));
test('LIGHT pure values show all positions and only T/D1 vacancies with job requirements', () => {
  const s = seats('LIGHT');
  s[0] = { ...s[0], kind: 'ANY' };
  s[1] = { ...s[1], kind: 'JOB', job: '白魔法师', registration: { status: 'ACTIVE' } };
  s[2] = { ...s[2], kind: 'JOB', job: '武僧' };
  s[3].registration = { status: 'ACTIVE' };
  const v = botTeamValues({ scene: 'GAME', composition: 'LIGHT', seats: s });
  assert.equal(v.team, 'T（不限）、H（白魔法师）、D1（武僧）、D2（输出）');
  assert.equal(v.vacancies, 'T（不限）、D1（武僧）');
});
for (const composition of ['FULL', 'ALLIANCE'])
  test(composition + ' stable original positions and group labels for changed requirements', () => {
    const s = seats(composition);
    s[2] = { ...s[2], kind: 'JOB', job: '学者' };
    s[3] = { ...s[3], kind: 'JOB', job: '武僧' };
    s[0].registration = { status: 'WITHDRAWN' };
    s[1].registration = { status: 'CANCELLED' };
    s[2].registration = { status: 'ACTIVE' };
    const v = botTeamValues({ scene: 'GAME', composition, seats: [...s].reverse() });
    assert.equal((v.team.match(/（/g) || []).length, s.length);
    assert.equal((v.vacancies.match(/（/g) || []).length, s.length - 1);
    assert.ok(v.team.includes(composition === 'FULL' ? 'H1（学者）' : 'A队 H2（学者）'));
    if (composition === 'ALLIANCE') {
      assert.match(v.team, /B队 T/);
      assert.match(v.team, /C队 D5/);
    }
    assert.ok(!v.vacancies.includes('（学者）'));
  });
test('full and offline parties have empty vacancy or seat values, including internal offline seats', () => {
  const s = seats('FULL').map((x) => ({ ...x, registration: { status: 'ACTIVE' } }));
  assert.equal(botTeamValues({ scene: 'GAME', composition: 'FULL', seats: s }).vacancies, '');
  for (const x of [s, []])
    assert.deepEqual(botTeamValues({ scene: 'OFFLINE', composition: 'FULL', seats: x }), {
      team: '',
      vacancies: ''
    });
});
test('custom and SOCIAL 1/17/200 seats complete, no 600-character truncation', () => {
  for (const n of [1, 17, 200]) {
    const s = Array.from({ length: n }, (_, position) => ({
      position,
      groupKey: null,
      kind: 'ANY',
      registration: null
    }));
    const v = botTeamValues({ scene: 'GAME', composition: 'CUSTOM', seats: s });
    if (n === 200) assert.equal(v.team, '席位1–200（不限）');
    else assert.ok(v.team.includes('席位' + n + '（不限）'));
    assert.equal(v.team, v.vacancies);
  }
  const c = botDefaults();
  c.templates.PUBLISHED = '{队伍构成}';
  const value = '席位（武僧）'.repeat(120);
  assert.equal(renderBotNotice(c, 'PUBLISHED', { team: value }), value);
});
test('preview, custom reminder and real renderer share team and vacancy values without labels or recursion', () => {
  const c = botConfigForEditing(botDefaults()),
    r = c.reminders[0];
  r.template = '{消息类别}|{队伍构成}|{空缺席位}';
  const p = previewBotTemplate(c, 'reminder:' + r.id);
  assert.equal(
    p.text,
    appendQqSignupInstruction(
      renderBotReminder(c, r, botPreviewValues('REMINDER_2H')),
      '7K4M2Q9R',
      'GAME',
      'LIGHT'
    )
  );
  assert.ok(p.text.startsWith('提前120分钟提醒|T（不限）'));
  assert.ok(p.text.split('\n\n活动编号：')[0].endsWith('|T（不限）、D1（武僧）'));
  c.templates.PUBLISHED = '{team}|{vacancies}';
  assert.throws(() =>
    validateBotConfig({ ...c, templates: { ...c.templates, PUBLISHED: '{team}{队伍构成}' } })
  );
  assert.ok(previewBotTemplate(c, 'PUBLISHED').text.includes('T（不限）'));
});

test('valid near-byte-limit reminder renders without counting frozen template twice', () => {
  const c = botConfigForEditing(botDefaults());
  c.reminders = Array.from({ length: 6 }, (_, i) => ({
    id: 'r' + i,
    minutes: i + 1,
    enabled: true,
    template: '文'.repeat(246)
  }));
  assert.ok(new TextEncoder().encode(JSON.stringify(c)).byteLength < 6500);
  validateBotConfig(c);
  assert.equal(renderBotReminder(c, c.reminders[0], {}), '文'.repeat(246));
  assert.equal(
    previewBotTemplate(c, 'reminder:r0').text,
    appendQqSignupInstruction('文'.repeat(246), '7K4M2Q9R', 'GAME', 'LIGHT')
  );
});

test('complete 200-seat values are never truncated and oversized final message fails before send', () => {
  const s = Array.from({ length: 200 }, (_, position) => ({
    position,
    groupKey: null,
    kind: 'JOB',
    job: [
      '骑士',
      '战士',
      '暗黑骑士',
      '绝枪战士',
      '白魔法师',
      '学者',
      '占星术士',
      '贤者',
      '武僧',
      '龙骑士',
      '忍者',
      '武士',
      '钐镰客',
      '蝰蛇剑士',
      '吟游诗人',
      '机工士',
      '舞者',
      '黑魔法师',
      '召唤师',
      '赤魔法师',
      '绘灵法师'
    ][position % 21],
    registration: null
  }));
  const values = botTeamValues({ scene: 'GAME', composition: 'CUSTOM', seats: s });
  assert.match(values.team, /200/);
  const c = botDefaults();
  c.templates.PUBLISHED = '文'.repeat(200) + '{队伍构成}|{空缺席位}';
  assert.throws(
    () => renderBotNotice(c, 'PUBLISHED', values),
    (e) => e.code === 'VALIDATION_ERROR' && e.message.includes('1800')
  );
  c.templates.PUBLISHED = '{队伍构成}';
  assert.equal(renderBotNotice(c, 'PUBLISHED', values), values.team);
});

test('new optional reminder wire and Chinese aliases produce identical TS/Python digest', () => {
  const c = botConfigForEditing(botDefaults());
  c.reminders[0].template = '{队伍构成}|{空缺席位}';
  const input = { config: c, digest: createHash('sha256').update(botCanonical(c)).digest('hex') };
  const code =
    "import sys,json;sys.path.insert(0,'tests/qq-plugin');import test_management as t;v=json.load(sys.stdin);assert t.module.validate_config(v['config'])==v['config'];assert t.module.config_digest(v['config'])==v['digest'];print('WIRE_PASS')";
  const result = spawnSync('python3', ['-B', '-c', code], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WIRE_PASS/);
});
