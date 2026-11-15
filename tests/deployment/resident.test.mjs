import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

const script = resolve('scripts/deployment-resident.sh');
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: 15000 });
test('resident rejects unknown actions and unsafe paths', () => {
  for (const args of [[], ['start', '/srv/site'], ['hold', '/'], ['hold', '/srv/../site']])
    assert.notEqual(run(...args).status, 0);
});
test(
  'manual holder survives parent session, is idempotent, and releases without stopping WSL',
  { skip: process.getuid?.() !== 1000 },
  async () => {
    mkdirSync('.local', { recursive: true, mode: 0o700 });
    const root = mkdtempSync(resolve('.local/resident-test-'));
    mkdirSync(join(root, 'secrets'), { mode: 0o700 });
    try {
      assert.equal(run('status', root).status, 3);
      // A detached process is the same foreground workload launched by Windows wsl.exe.
      const holder = spawn('bash', [script, 'hold', root], { detached: true, stdio: 'ignore' });
      const ended = new Promise((done) => holder.once('exit', done));
      for (let i = 0; i < 20 && run('status', root).status !== 0; i++)
        await new Promise((done) => setTimeout(done, 50));
      assert.equal(run('status', root).status, 0);
      assert.equal(run('hold', root).status, 0, 'second holder exits without replacing the first');
      assert.equal(run('release', root).status, 0);
      assert.equal(await ended, 0);
      assert.equal(run('status', root).status, 3);
      assert.equal(run('release', root).status, 0);
      rmSync(join(root, 'secrets/.resident.request'), { force: true });
      symlinkSync('/dev/null', join(root, 'secrets/.resident.request'));
      assert.notEqual(run('hold', root).status, 0, 'untrusted state must be refused');
    } finally {
      run('release', root);
      rmSync(root, { recursive: true, force: true });
    }
  }
);
