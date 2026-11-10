import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeQqSignupCode,
  appendQqSignupInstruction,
  botDefaults,
  previewBotTemplate
} from '../../packages/domain/src/index.ts';
import { parseQqSignupTarget } from '../../apps/web/server/qq-official/signup-parser.ts';
const code = '7K4M2Q9R';
test('public locator accepts only exact ASCII alphabet, without fuzzy correction', () => {
  assert.equal(normalizeQqSignupCode(code.toLowerCase()), code);
  for (const x of [
    ' ' + code,
    code + ' ',
    code.slice(1),
    '0K4M2Q9R',
    '1K4M2Q9R',
    '7I4M2Q9R',
    '7O4M2Q9R',
    '７K4M2Q9R',
    '7K4M2Q9R',
    null
  ])
    assert.equal(normalizeQqSignupCode(x), null);
});
test('new locator leaves game, alliance and offline semantics with the strict original parser', () => {
  assert.deepEqual(parseQqSignupTarget(`报名 ${code.toLowerCase()} MT 骑士`), {
    activityCode: code,
    command: { kind: 'GAME', group: null, label: 'MT', job: '骑士' }
  });
  assert.equal(parseQqSignupTarget(`报名 ${code} A队 H1 白魔`).command.group, 'A');
  assert.deepEqual(parseQqSignupTarget(`报名 ${code}`), { activityCode: code, command: { kind: 'OFFLINE' } });
  assert.equal(parseQqSignupTarget('报名 H1 白魔').activityCode, null);
  for (const x of [
    `报名 ${code} 自动 白魔`,
    `报名 ${code} H1 奶妈`,
    `报名 ${code} H1 白魔 再报`,
    `报名 0K4M2Q9R H1 白魔`
  ])
    assert.throws(() => parseQqSignupTarget(x));
});
test('copyable instruction is system-owned, supports current compositions and cancellation', () => {
  for (const composition of ['FULL', 'LIGHT'])
    assert.equal(
      appendQqSignupInstruction('Custom prefix', code, 'GAME', composition),
      `Custom prefix\n\n活动编号：${code}\n报名示例：＠机器人 报名 ${code} ${composition === 'FULL' ? 'MT' : 'T'} 骑士`
    );
  assert.equal(
    appendQqSignupInstruction('Custom prefix', code, 'GAME', 'ALLIANCE'),
    `Custom prefix\n\n活动编号：${code}\n报名示例：＠机器人 报名 ${code} A队 T 骑士`
  );
  assert.equal(
    appendQqSignupInstruction('Custom prefix', code, 'OFFLINE'),
    `Custom prefix\n\n活动编号：${code}\n报名示例：＠机器人 报名 ${code}`
  );
  assert.ok(appendQqSignupInstruction('Custom prefix', code, 'GAME', 'CUSTOM').endsWith('请前往网站报名。'));
  const cancelled = appendQqSignupInstruction('Custom prefix', code, 'GAME', 'FULL', true);
  assert.ok(cancelled.includes('已取消'));
  assert.ok(!cancelled.includes('报名 ' + code));
  assert.throws(() => appendQqSignupInstruction('x'.repeat(1800), code, 'GAME', 'FULL'), /1800/);
  assert.throws(() => appendQqSignupInstruction('x', 'INVALID', 'GAME', 'FULL'));
});
test('management preview includes an inert sample instruction, fixed replies stay unchanged', () => {
  const config = botDefaults();
  for (const kind of ['PUBLISHED', 'CHANGED', 'REMINDER_2H', 'REMINDER_1H'])
    assert.ok(previewBotTemplate(config, kind).text.includes('报名 ' + code));
  assert.ok(previewBotTemplate(config, 'CANCELLED').text.includes(code + '（已取消）'));
  assert.ok(!previewBotTemplate(config, 'SIGNUP_SUCCESS').text.includes('活动编号'));
});
