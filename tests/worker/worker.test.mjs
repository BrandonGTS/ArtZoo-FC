import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const root = new URL('../.././', import.meta.url);
function run(scenario, cleanup = '1') {
  const env = { ...process.env, REV_WORKER_SCENARIO: scenario };
  if (cleanup === null) delete env.ARTZOO_SECURITY_CLEANUP_ENABLED;
  else env.ARTZOO_SECURITY_CLEANUP_ENABLED = cleanup;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      new URL('./support/worker-setup.mjs', import.meta.url).pathname,
      new URL(
        process.env.REV_WORKER_COMPILED === '1' ? 'apps/worker/dist/index.js' : 'apps/worker/src/index.ts',
        root
      ).pathname,
      ...(scenario === 'repeat' ? [] : ['--once']),
      '--require-db'
    ],
    {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 10_000
    }
  );
  assert.equal(result.error, undefined);
  const lines = result.stdout.trim().split('\n');
  const events = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  return {
    ...result,
    lines,
    events,
    notes: events.filter((e) => e.test).map((e) => e.test),
    heartbeat: events.find((e) => e.service)
  };
}
for (const step of ['activity', 'lottery', 'officialEvents', 'cleanup'])
  test(`failure in ${step} preserves DB health and later steps`, () => {
    const result = run(step);
    assert.equal(result.status, 1);
    assert.equal(result.heartbeat.database, 'ok');
    assert.deepEqual(result.heartbeat.failedSteps, [step]);
    assert.deepEqual(result.notes, [
      'probe',
      'activity',
      'lottery',
      'officialEvents',
      'cleanup',
      'disconnected'
    ]);
    assert.ok(!result.stderr.includes('private'));
  });
test('partial item failure is visible without misclassifying DB', () => {
  for (const scenario of ['item', 'lotteryItem']) {
    const result = run(scenario);
    assert.equal(result.status, 1);
    assert.equal(result.heartbeat.database, 'ok');
    assert.deepEqual(result.heartbeat.failedSteps, [scenario === 'item' ? 'activity' : 'lottery']);
  }
});
test('database failure skips all maintenance', () => {
  const result = run('database');
  assert.equal(result.status, 1);
  assert.equal(result.heartbeat.database, 'unavailable');
  assert.deepEqual(result.notes, ['probe', 'disconnected']);
});
test('SIGTERM waits for in-flight operation and disconnect before stopped log', () => {
  const result = run('signal');
  assert.equal(result.status, 0);
  assert.deepEqual(result.notes, ['probe', 'activity', 'committed', 'disconnected']);
  assert.equal(result.lines.at(-1), 'Worker stopped');
  assert.ok(result.stdout.indexOf('committed') < result.stdout.indexOf('disconnected'));
});
test('unconfigured database with require-db retains failure', () => {
  const result = run('unconfigured');
  assert.equal(result.status, 1);
  assert.equal(result.heartbeat.database, 'unconfigured');
  assert.deepEqual(result.notes, []);
});

for (const mode of [null, '0'])
  test(`cleanup ${mode === null ? 'defaults off' : 'explicitly off'} never invokes deletion`, () => {
    const result = run('cleanup', mode);
    assert.equal(result.status, 0);
    assert.equal(result.heartbeat.cleanupEnabled, false);
    assert.equal(result.heartbeat.cleanup, undefined);
    assert.deepEqual(result.heartbeat.failedSteps, []);
    assert.deepEqual(result.notes, ['probe', 'activity', 'lottery', 'officialEvents', 'disconnected']);
  });
test('explicit enable logs enabled state and retains one cleanup per day across heartbeats', () => {
  const result = run('repeat', '1');
  assert.equal(result.status, 0);
  assert.equal(result.notes.filter((note) => note === 'cleanup').length, 1);
  assert.equal(result.notes.filter((note) => note === 'activity').length, 2);
  assert.ok(result.events.filter((event) => event.service).every((event) => event.cleanupEnabled === true));
});
test('invalid cleanup settings fail before any database or business work', () => {
  for (const mode of ['', 'true', '2', ' 1']) {
    const result = run('normal', mode);
    assert.equal(result.status, 1);
    assert.deepEqual(result.notes, []);
    assert.equal(result.heartbeat, undefined);
    assert.match(result.stderr, /INVALID_SECURITY_CLEANUP_CONFIG/);
  }
});
