import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/deployment-maintenance.sh', import.meta.url));
function run(args, options = {}) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: 360000, ...options });
}
test('maintenance defaults to help and rejects unknown operations without changing a target', () => {
  assert.equal(run([]).status, 0);
  assert.match(run([]).stdout, /start/);
  assert.equal(run(['reset']).status, 1);
  assert.equal(run(['database', '--root']).status, 1);
  assert.equal(run(['database', '--root', '/']).status, 1);
});
test('owner refuses noninteractive invocation before accessing any database', () => {
  const result = run(['owner', '--bundle', '.', '--root', '/srv/test']);
  assert.equal(result.status, 1);
});

// Explicit opt-in integration: only fresh local fixtures, never an operator's runtime root.
// Run as UID/GID 1000 on a development host with a built full bundle and Docker.
test(
  'packaged maintenance lifecycle preserves data and refuses repeated initialization',
  {
    skip: !process.env.ARTZOO_MAINTENANCE_TEST_BUNDLE,
    timeout: 360000
  },
  async (t) => {
    assert.equal(process.getuid(), 1000);
    assert.equal(process.getgid(), 1000);
    const bundle = resolve(process.env.ARTZOO_MAINTENANCE_TEST_BUNDLE);
    const scratch = resolve('.local');
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const root = mkdtempSync(join(scratch, 'maintenance-test-'));
    const project = `artzoo-maintenance-${root.split('-').at(-1).toLowerCase()}`;
    const docker = (...args) =>
      spawnSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
        encoding: 'utf8',
        timeout: 45000
      });
    const compose = (...args) => {
      const bin = docker('compose', 'version').status === 0 ? 'docker' : 'docker-compose';
      const prefix = bin === 'docker' ? ['--host', 'unix:///var/run/docker.sock', 'compose'] : [];
      return spawnSync(
        bin,
        [
          ...prefix,
          '--project-name',
          project,
          '--env-file',
          join(bundle, 'images.env'),
          '--env-file',
          join(root, 'secrets/compose.env'),
          '-f',
          join(bundle, 'compose.yaml'),
          ...args
        ],
        {
          encoding: 'utf8',
          timeout: 120000,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: 'unix:///var/run/docker.sock' }
        }
      );
    };
    t.after(() => {
      const result = compose('down', '--volumes', '--remove-orphans', '--timeout', '20');
      assert.equal(result.status, 0, 'isolated fixture cleanup must succeed');
      assert.ok(root.startsWith(`${scratch}/maintenance-test-`));
      rmSync(root, { recursive: true, force: true });
    });
    for (const dir of ['secrets', 'media', 'media/original', 'media/derived', 'media/avatars']) {
      mkdirSync(join(root, dir), { mode: 0o700 });
    }
    const args = ['--bundle', bundle, '--root', root, '--project', project];
    const invoke = (command, extra = []) => run([command, ...args, ...extra]);
    const pass = (command, extra = []) => {
      const result = invoke(command, extra);
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      assert.match(result.stdout, /PASS:/);
      return result;
    };
    const refuse = (command, extra = []) =>
      assert.equal(invoke(command, extra).status, 1, `${command} should refuse`);
    refuse('prepare-env', ['--origin', 'http://localhost']);
    pass('prepare-env', ['--origin', 'https://localhost']);
    const config = join(root, 'secrets/compose.env');
    assert.equal(statSync(config).mode & 0o777, 0o600);
    const original = readFileSync(config, 'utf8');
    refuse('prepare-env', ['--origin', 'https://localhost']);
    assert.equal(readFileSync(config, 'utf8'), original);
    const portProbe = createServer();
    await new Promise((ready) => portProbe.listen(0, '127.0.0.1', ready));
    const port = portProbe.address().port;
    await new Promise((closed) => portProbe.close(closed));
    writeFileSync(config, original.replace('ARTZOO_HTTP_PORT=13100', `ARTZOO_HTTP_PORT=${port}`));
    pass('database');
    refuse('database');
    pass('migrate');
    refuse('migrate');
    writeFileSync(join(root, 'media/original/rejection-probe'), '');
    refuse('baseline');
    rmSync(join(root, 'media/original/rejection-probe'));
    pass('baseline');
    pass('baseline');
    refuse('owner');
    refuse('enable-budget');

    // util-linux script creates a test PTY; all input is synthetic, never an operator account.
    const command = ['bash', script, 'owner', ...args]
      .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
      .join(' ');
    const child = spawn('script', ['--quiet', '--return', '--command', command, '/dev/null'], {
      env: { ...process.env, SSH_CONNECTION: '', SSH_CLIENT: '', SSH_TTY: '' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const prompts = [
      ['用户本人手机号：', '13800000001'],
      ['参与身份（MEMBER 或 FRIEND）：', 'MEMBER'],
      ['输入 INITIALIZE_CONFIRMED_OWNER：', 'INITIALIZE_CONFIRMED_OWNER'],
      ['设置密码（输入不显示）：', 'Synthetic-test-only-123'],
      ['再次输入密码（输入不显示）：', 'Synthetic-test-only-123']
    ];
    let buffer = '',
      answered = 0;
    child.stdout.on('data', (data) => {
      buffer += data.toString();
      if (answered < prompts.length && buffer.includes(prompts[answered][0])) {
        const value = prompts[answered][1];
        answered++;
        buffer = '';
        // Give raw-mode setup time after the hidden prompt is emitted.
        setTimeout(() => child.stdin.write(`${value}\n`), 100);
      }
    });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
    const code = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });
    clearTimeout(timer);
    assert.equal(code, 0, 'synthetic owner initialization must complete');
    assert.equal(answered, 5);
    pass('enable-budget');
    refuse('enable-budget');
    refuse('database');
    refuse('baseline');
    pass('status');
    const database = compose('ps', '--quiet', 'postgres').stdout.trim();
    const sql = (query) => {
      const result = docker(
        'exec',
        database,
        'psql',
        '-X',
        '-w',
        '-U',
        'artzoo',
        '-d',
        'artzoo',
        '-Atc',
        query
      );
      assert.equal(result.status, 0, 'fixture SQL must succeed');
      return result.stdout.trim();
    };
    // Verify status/start never require a pristine zero-usage state or clear existing usage.
    sql('UPDATE "MediaBudgetState" SET "committedBytes"=64 WHERE id=\'global\';');
    const before = sql('SELECT row_to_json(s)::text FROM "MediaBudgetState" s;');
    pass('status');
    pass('stop');
    refuse('status');
    pass('start');
    assert.equal(sql('SELECT row_to_json(s)::text FROM "MediaBudgetState" s;'), before);
    assert.equal(compose('ps', '--quiet', 'postgres').stdout.trim(), database);
    assert.equal(sql('SELECT count(*) FROM "Account";'), '1');
  }
);
