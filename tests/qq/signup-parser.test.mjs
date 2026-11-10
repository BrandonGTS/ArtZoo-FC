import test from 'node:test';
import assert from 'node:assert/strict';
import { dutyPresetSeats, ACTIVITY_JOBS } from '../../packages/domain/src/index.ts';
import { parseQqSignup, qqSignupInput } from '../../apps/web/server/qq-official/signup-parser.ts';

const invalid = (fn) => assert.throws(fn, (e) => e.code === 'VALIDATION_ERROR');
function row(composition = 'FULL') {
  return {
    scene: 'GAME',
    category: 'DUNGEON',
    dutySnapshot: { partyComposition: composition },
    seats: dutyPresetSeats(composition).map((seat, position) => ({
      id: 'seat-' + position,
      position,
      groupKey: seat.groupKey
    }))
  };
}
test('strict signup accepts agreed formats and whitespace; normalizes only known labels/jobs', () => {
  assert.deepEqual(parseQqSignup(' 报名  h1  白魔 '), {
    kind: 'GAME',
    group: null,
    label: 'H1',
    job: '白魔法师'
  });
  assert.deepEqual(parseQqSignup('报名 MT 骑士'), { kind: 'GAME', group: null, label: 'MT', job: '骑士' });
  assert.deepEqual(parseQqSignup('报名 A队 H1 白魔'), {
    kind: 'GAME',
    group: 'A',
    label: 'H1',
    job: '白魔法师'
  });
  assert.deepEqual(parseQqSignup('报名'), { kind: 'OFFLINE' });
  for (const job of ACTIVITY_JOBS) assert.equal(parseQqSignup('报名 D1 ' + job.name).job, job.name);
});
test('unsupported ambiguous or extra instructions never infer a target or job', () => {
  for (const text of [
    '',
    '帮我报名',
    '报名 H1 奶妈',
    '报名 H1 白',
    '报名 H1 白魔 换位',
    '报名 自动 白魔',
    '退出',
    '取消报名',
    '换到 H1',
    '报名 H1',
    '报名 第一个 白魔',
    '报名 A H1 白魔',
    '报名 H1 白魔;报名 MT 骑士',
    '报名 H1 白魔\u200b',
    '报名 H1 白魔'.repeat(30)
  ])
    invalid(() => parseQqSignup(text));
});
test('canonical preset seat labels resolve exact existing IDs for all supported compositions', () => {
  const input = (r, text) => qqSignupInput(r, parseQqSignup(text));
  assert.equal(input(row(), '报名 MT 骑士').seatId, 'seat-0');
  assert.equal(input(row(), '报名 ST 战士').seatId, 'seat-1');
  assert.equal(input(row(), '报名 H1 白魔').seatId, 'seat-2');
  assert.equal(input(row(), '报名 H2 学者').seatId, 'seat-3');
  assert.equal(input(row(), '报名 D4 忍者').seatId, 'seat-7');
  assert.equal(input(row('LIGHT'), '报名 H1 白魔').seatId, 'seat-1');
  assert.equal(input(row('LIGHT'), '报名 D2 忍者').seatId, 'seat-3');
  invalid(() => input(row('LIGHT'), '报名 ST 战士'));
  invalid(() => input(row('LIGHT'), '报名 H2 学者'));
  for (const [i, group] of ['A', 'B', 'C'].entries()) {
    assert.equal(input(row('ALLIANCE'), `报名 ${group}队 H1 白魔`).seatId, 'seat-' + (i * 8 + 1));
    assert.equal(input(row('ALLIANCE'), `报名 ${group}队 D5 忍者`).seatId, 'seat-' + (i * 8 + 7));
    invalid(() => input(row('ALLIANCE'), `报名 ${group}队 ST 战士`));
  }
});
test('24 party requires explicit group, ordinary party forbids group; malformed/custom rosters reject', () => {
  const command = parseQqSignup('报名 H1 白魔'),
    group = parseQqSignup('报名 A队 H1 白魔');
  invalid(() => qqSignupInput(row('ALLIANCE'), command));
  invalid(() => qqSignupInput(row(), group));
  for (const r of [
    row('CUSTOM'),
    { ...row(), dutySnapshot: null },
    { ...row(), category: 'SOCIAL' },
    { ...row(), seats: row().seats.slice(1) },
    { ...row(), seats: row().seats.map((s) => ({ ...s, position: 0 })) },
    { ...row(), seats: row().seats.map((s) => ({ ...s, groupKey: 'A' })) }
  ])
    invalid(() => qqSignupInput(r, command));
});
test('offline accepts only bare signup and leaves capacity assignment to shared transaction', () => {
  assert.deepEqual(qqSignupInput({ ...row(), scene: 'OFFLINE' }, parseQqSignup('报名')), {
    seatId: null,
    job: null
  });
  invalid(() => qqSignupInput({ ...row(), scene: 'OFFLINE' }, parseQqSignup('报名 MT 骑士')));
  invalid(() => qqSignupInput(row(), parseQqSignup('报名')));
});
