import test from 'node:test';
import assert from 'node:assert/strict';
import { lotteryControls } from '../../apps/web/components/lottery/participation-controls.ts';
const base = {
  state: 'OPEN',
  mode: 'MANUAL',
  drawAt: '2035-01-01T00:00:00Z',
  mine: { state: 'NONE', eligible: true, reason: null }
};
const now = Date.parse('2030-01-01');
test('manual joins and cancels while AUTO only displays actual enrollment with separate permanent exit', () => {
  assert.equal(lotteryControls(base, now)[0].action, 'join');
  assert.equal(
    lotteryControls({ ...base, mine: { ...base.mine, state: 'ACTIVE' } }, now)[0].label,
    '取消报名'
  );
  const c = lotteryControls({ ...base, mode: 'AUTO', mine: { ...base.mine, state: 'ACTIVE' } }, now);
  assert.equal(c[0].label, '已参与');
  assert.equal(c[0].disabled, true);
  assert.equal(c[1].action, 'leave');
});
test('AUTO absence and withdrawal never fabricate joined state or offer restore despite eligibility', () => {
  for (const state of ['NONE', 'WITHDRAWN']) {
    const c = lotteryControls({ ...base, mode: 'AUTO', mine: { state, eligible: true } }, now);
    assert.ok(c.every((x) => x.disabled && x.action === null));
    assert.notEqual(c[0].label, '已参与');
  }
  assert.match(
    lotteryControls({ ...base, mode: 'AUTO', mine: { state: 'WITHDRAWN', eligible: true } }, now)[0].label,
    /不可恢复/
  );
});
test('deadline and terminal states suppress every mutation even if client has old ACTIVE eligibility', () => {
  for (const state of ['OPEN', 'DRAWN', 'CANCELLED']) {
    const c = lotteryControls(
      { ...base, state, mine: { state: 'ACTIVE', eligible: true } },
      Date.parse(base.drawAt)
    );
    assert.ok(c.every((x) => x.disabled && x.action === null));
  }
});
test('eligibility rejection preserves genuine reason without adding join', () => {
  const c = lotteryControls(
    { ...base, mine: { state: 'NONE', eligible: false, reason: '当前身份不符合' } },
    now
  );
  assert.equal(c[0].label, '当前身份不符合');
  assert.equal(c[0].action, null);
});

import { lotteryStages } from '../../apps/web/components/lottery/lottery-timeline.ts';
test('future monthly timeline waits for the actual collection month rather than claiming collection is underway', () => {
  const row = { ...base, kind: 'MONTHLY', month: '2034-12', createdAt: '2034-10-01T00:00:00Z', result: null };
  assert.equal(lotteryStages(row, Date.parse('2034-11-30T23:59:59+08:00'))[1].title, '等待签到统计');
  assert.equal(lotteryStages(row, Date.parse('2034-12-01T00:00:00+08:00'))[1].title, '签到统计中');
});

test('stored ACTIVE enrollment does not hide a genuine current qualification rejection', () => {
  for (const mode of ['MANUAL', 'AUTO']) {
    const c = lotteryControls(
      { ...base, mode, mine: { state: 'ACTIVE', eligible: false, reason: '当前身份不符合' } },
      now
    );
    assert.equal(c[0].label, '当前身份不符合');
    assert.equal(c[0].disabled, true);
    assert.equal(c[1].action, 'leave');
    assert.ok(!c.some((x) => x.action === 'join' || x.label === '已参与'));
  }
});
