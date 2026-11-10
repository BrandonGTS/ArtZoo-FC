import test from 'node:test';
import assert from 'node:assert/strict';
import { lotteryStages } from '../../apps/web/components/lottery/lottery-timeline.ts';
const base = {
  kind: 'ORDINARY',
  state: 'OPEN',
  month: null,
  createdAt: '2030-10-01T00:00:00Z',
  drawAt: '2030-12-01T12:00:00Z',
  result: null
};
test('deadline changes to waiting without inventing a completed draw', () => {
  const before = lotteryStages(base, Date.parse(base.drawAt) - 1),
    at = lotteryStages(base, Date.parse(base.drawAt));
  assert.equal(before[1].title, '参与进行中');
  assert.equal(at[1].title, '参与已结束');
  assert.equal(before.at(-1).title, '预定开奖');
  assert.equal(at.at(-1).title, '等待开奖');
  assert.ok(!at.some((x) => x.title === '开奖已完成'));
  assert.equal(at.at(-1).time, base.drawAt);
});
test('delayed draw shows recorded execution time, not deadline or the current browser clock', () => {
  const row = {
    ...base,
    state: 'DRAWN',
    result: {
      drawnAt: base.drawAt,
      processedAt: '2030-12-01T13:05:00Z',
      participants: 0,
      winners: [],
      unassigned: 2
    }
  };
  const copy = structuredClone(row);
  const stages = lotteryStages(row, Date.parse('2031-01-01'));
  assert.equal(stages.at(-1).time, row.result.processedAt);
  assert.equal(stages.at(-2).time, row.drawAt);
  assert.deepEqual(row, copy);
});
test('cancelled event does not fabricate a cancellation timestamp or future draw', () => {
  const stages = lotteryStages({ ...base, state: 'CANCELLED' }, Date.parse('2031-01-01'));
  assert.deepEqual(
    stages.map((s) => s.title),
    ['已发布', '已取消']
  );
  assert.equal(stages[1].time, undefined);
});
test('monthly collection finishes at Beijing month end while the later draw remains pending', () => {
  const row = { ...base, kind: 'MONTHLY', month: '2030-11', drawAt: '2030-12-02T12:00:00Z' };
  assert.equal(lotteryStages(row, Date.parse('2030-11-30T23:59:59+08:00'))[1].title, '签到统计中');
  assert.equal(lotteryStages(row, Date.parse('2030-12-01T00:00:00+08:00'))[1].title, '签到统计已结束');
});
