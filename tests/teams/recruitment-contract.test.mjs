import test from 'node:test';
import assert from 'node:assert/strict';
import {
  teamApplicationInput,
  teamMetadata,
  teamPage,
  validateCreateTeam
} from '../../packages/domain/src/index.ts';
import { body } from './support/teams-fixtures.mjs';

test('metadata requires all four recruitment fields for new creation and legacy edits', () => {
  const input = body();
  for (const field of ['dutyName', 'progress', 'strategy', 'commonTimes']) {
    for (const value of [undefined, null, '', '  \n  ']) {
      assert.throws(
        () => validateCreateTeam({ ...input, [field]: value }),
        (error) => error.code === 'VALIDATION_ERROR' && field in error.fieldErrors
      );
      assert.throws(
        () => teamMetadata({ ...input, [field]: value }),
        (error) => error.code === 'VALIDATION_ERROR' && field in error.fieldErrors
      );
    }
  }
  const copy = teamMetadata({
    ...input,
    dutyName: ' 副本 ',
    progress: ' 第一阶段 ',
    strategy: ' 文字攻略 ',
    commonTimes: ' 周二晚上，时间可协调 '
  });
  assert.equal(copy.dutyName, '副本');
  assert.equal(copy.commonTimes, '周二晚上，时间可协调');
  for (const value of [42, 'x'.repeat(201), 'x\u0000'])
    assert.throws(() => teamMetadata({ ...input, dutyName: value }));
});

test('application note is required and trimmed for every requirement', () => {
  const role = { kind: 'ROLE', role: 'DAMAGE' };
  for (const note of [undefined, null, '', '  \n  ', 'x'.repeat(1001), 'x\u0000'])
    assert.throws(() => teamApplicationInput({ job: '武士', note }, role));
  assert.deepEqual(teamApplicationInput({ job: '武士', note: '  已了解攻略 \n ' }, role), {
    job: '武士',
    note: '已了解攻略'
  });
});

test('specific job auto selects its requirement while role seats require compatible selection', () => {
  const seat = { kind: 'JOB', job: '武士' };
  assert.equal(teamApplicationInput({ note: '准备好了' }, seat).job, '武士');
  assert.equal(teamApplicationInput({ job: '武士', note: '准备好了' }, seat).job, '武士');
  assert.throws(() => teamApplicationInput({ job: '骑士', note: '准备好了' }, seat));
  assert.throws(() => teamApplicationInput({ note: '准备好了' }, { kind: 'ROLE', role: 'DAMAGE' }));
  assert.throws(() =>
    teamApplicationInput({ job: '骑士', note: '准备好了' }, { kind: 'ROLE', role: 'DAMAGE' })
  );
});

test('page defaults to one and accepts only bounded positive decimal page strings', () => {
  assert.equal(teamPage(null), 1);
  assert.equal(teamPage('2'), 2);
  assert.equal(teamPage('999999999'), 999999999);
  for (const page of ['', '0', '-1', '1.5', '01', 'NaN', '1000000000', 2])
    assert.throws(() => teamPage(page));
});
