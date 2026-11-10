import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dutyPresetSeats,
  botTeamValues,
  botDefaults,
  renderBotNotice,
  renderBotReminder,
  botReminders,
  appendQqSignupInstruction
} from '../../packages/domain/src/index.ts';
import {
  parseQqSignup,
  parseQqSignupTarget,
  qqSignupInput
} from '../../apps/web/server/qq-official/signup-parser.ts';
function row(composition) {
  return {
    scene: 'GAME',
    category: 'DUNGEON',
    dutySnapshot: { partyComposition: composition },
    seats: dutyPresetSeats(composition).map((s, position) => ({
      id: 'seat-' + position,
      position,
      groupKey: s.groupKey,
      ...s.requirement,
      registration: null
    }))
  };
}
test('all website seat labels resolve their actual IDs for 4,8,24-person compositions', () => {
  for (const [composition, labels] of [
    ['LIGHT', ['T', 'H', 'D1', 'D2']],
    ['FULL', ['MT', 'ST', 'H1', 'H2', 'D1', 'D2', 'D3', 'D4']],
    ['ALLIANCE', ['T', 'H1', 'H2', 'D1', 'D2', 'D3', 'D4', 'D5']]
  ]) {
    const r = row(composition);
    for (const [position, seat] of r.seats.entries()) {
      const label = labels[position % labels.length],
        group = seat.groupKey ? seat.groupKey + '队 ' : '';
      const job = seat.role === 'TANK' ? '骑士' : seat.role === 'HEALER' ? '白魔' : '武僧';
      assert.equal(qqSignupInput(r, parseQqSignup('报名 ' + group + label + ' ' + job)).seatId, seat.id);
    }
  }
  for (const [composition, text] of [
    ['FULL', '报名 T 骑士'],
    ['ALLIANCE', '报名 T 骑士'],
    ['ALLIANCE', '报名 A队 H 白魔'],
    ['LIGHT', '报名 ST 骑士'],
    ['LIGHT', '报名 H2 白魔']
  ])
    assert.throws(() => qqSignupInput(row(composition), parseQqSignup(text)));
  // Preserve old notified examples as exact unambiguous aliases only.
  for (const composition of ['LIGHT', 'ALLIANCE'])
    assert.equal(
      qqSignupInput(
        row(composition),
        parseQqSignup('报名 ' + (composition === 'ALLIANCE' ? 'A队 ' : '') + 'MT 骑士')
      ).seatId,
      'seat-0'
    );
  assert.equal(qqSignupInput(row('LIGHT'), parseQqSignup('报名 H1 白魔')).seatId, 'seat-1');
});
test('every newly generated signup example uses displayed canonical labels and resolves', () => {
  for (const composition of ['LIGHT', 'FULL', 'ALLIANCE']) {
    const text = appendQqSignupInstruction('正文', '7K4M2Q9R', 'GAME', composition),
      command = text.split('报名示例：＠机器人 ')[1];
    assert.ok(command);
    assert.equal(qqSignupInput(row(composition), parseQqSignupTarget(command).command).seatId, 'seat-0');
    assert.ok(command.endsWith(composition === 'FULL' ? 'MT 骑士' : 'T 骑士'));
  }
});
test('alliance vacancy lines preserve group separation and every actual requirement', () => {
  const r = row('ALLIANCE');
  r.seats[0] = { ...r.seats[0], kind: 'JOB', job: '骑士' };
  r.seats[1].registration = { status: 'ACTIVE' };
  r.seats[8] = { ...r.seats[8], kind: 'ANY' };
  const v = botTeamValues({ scene: 'GAME', composition: 'ALLIANCE', seats: [...r.seats].reverse() });
  assert.equal(v.vacancies.split('\n').length, 3);
  assert.ok(v.vacancies.startsWith('A队：T（骑士）'));
  assert.match(v.vacancies, /\nB队：T（不限）/);
  assert.match(v.vacancies, /\nC队：T（防护）/);
  assert.ok(!v.vacancies.split('\n')[0].includes('H1'));
  assert.equal((v.vacancies.match(/（/g) || []).length, 23);
  const c = botDefaults();
  c.templates.PUBLISHED = '当前空缺：{空缺席位}';
  assert.equal(renderBotNotice(c, 'PUBLISHED', v), '当前空缺：' + v.vacancies);
  r.seats.filter((s) => s.groupKey === 'B').forEach((s) => (s.registration = { status: 'ACTIVE' }));
  assert.match(
    botTeamValues({ scene: 'GAME', composition: 'ALLIANCE', seats: r.seats }).vacancies,
    /B队：无空缺/
  );
  for (const composition of ['LIGHT', 'FULL'])
    assert.ok(
      !botTeamValues({ scene: 'GAME', composition, seats: row(composition).seats }).vacancies.includes('\n')
    );
});
test('notice and reminder rendering removes only leading blank lines, keeps body spacing and saved template', () => {
  const c = botDefaults();
  for (const kind of ['PUBLISHED', 'CHANGED', 'CANCELLED', 'REMINDER_2H', 'REMINDER_1H']) {
    c.templates[kind] = '\n \n{活动地点}\n【标题】\n\n活动安排\n';
    const saved = c.templates[kind];
    assert.equal(renderBotNotice(c, kind, { location: '' }), '【标题】\n\n活动安排\n');
    assert.equal(c.templates[kind], saved);
  }
  const reminder = { ...botReminders(c)[0], template: '\n\n提醒\n\n正文' };
  assert.equal(renderBotReminder(c, reminder, {}), '提醒\n\n正文');
  assert.ok(appendQqSignupInstruction('\n\n', '7K4M2Q9R', 'GAME', 'LIGHT').startsWith('活动编号：'));
  assert.ok(!appendQqSignupInstruction('\n\n标题', '7K4M2Q9R', 'GAME', 'LIGHT').startsWith('\n'));
});
