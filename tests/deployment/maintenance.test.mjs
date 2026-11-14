import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
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
    let cleanupConfig;
    t.after(() => {
      if (cleanupConfig) writeFileSync(join(root, 'secrets/compose.env'), cleanupConfig);
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
    cleanupConfig = original;
    refuse('prepare-env', ['--origin', 'https://localhost']);
    assert.equal(readFileSync(config, 'utf8'), original);
    const portProbe = createServer();
    await new Promise((ready) => portProbe.listen(0, '127.0.0.1', ready));
    const port = portProbe.address().port;
    await new Promise((closed) => portProbe.close(closed));
    writeFileSync(config, original.replace('ARTZOO_HTTP_PORT=13100', `ARTZOO_HTTP_PORT=${port}`));
    pass('config-check');
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
    const deploy = join(root, 'deploy');
    const proxy = join(deploy, 'proxy.compose.yaml');
    const proxyContent = 'services:\n  web:\n    environment:\n      ARTZOO_TRUSTED_PROXY: caddy\n';
    mkdirSync(deploy, { mode: 0o750 });
    const beforeProxy = readFileSync(config, 'utf8');
    const refuseProxy = () => {
      const result = invoke('enable-budget');
      assert.equal(result.status, 1, 'unsafe proxy configuration must be rejected');
      assert.equal(readFileSync(config, 'utf8'), beforeProxy, 'refusal must precede quota changes');
      assert.equal(compose('ps', '--all', '--quiet', 'web').stdout.trim(), '');
      assert.doesNotMatch(result.stdout + result.stderr, /proxy-content-must-stay-private/);
    };
    for (const content of [
      'proxy-content-must-stay-private: [invalid',
      proxyContent.replace('caddy', 'unknown-proxy'),
      proxyContent.replace('  web:', '  worker:'),
      proxyContent + '    ports:\n      - "0.0.0.0:13100:3100"\n'
    ]) {
      writeFileSync(proxy, content, { mode: 0o640 });
      refuseProxy();
    }
    writeFileSync(proxy, proxyContent);
    chmodSync(proxy, 0o666);
    refuseProxy();
    chmodSync(proxy, 0o640);
    chmodSync(deploy, 0o770);
    refuseProxy();
    chmodSync(deploy, 0o750);
    rmSync(proxy);
    for (const target of [config, join(deploy, 'missing.yaml')]) {
      symlinkSync(target, proxy);
      refuseProxy();
      rmSync(proxy);
    }
    writeFileSync(proxy, `# dedicated web proxy\r\n\r\n${proxyContent.replaceAll('\n', '\r\n')}`, {
      mode: 0o640
    });
    pass('enable-budget');
    const app = (service) => compose('ps', '--all', '--quiet', service).stdout.trim();
    const proxyValue = (service) =>
      docker(
        'inspect',
        '--format',
        '{{range .Config.Env}}{{if eq (index (split . "=") 0) "ARTZOO_TRUSTED_PROXY"}}{{println .}}{{end}}{{end}}',
        app(service)
      ).stdout.trim();
    assert.equal(proxyValue('web'), 'ARTZOO_TRUSTED_PROXY=caddy');
    assert.equal(proxyValue('worker'), 'ARTZOO_TRUSTED_PROXY=');
    assert.match(readFileSync(config, 'utf8'), /^ARTZOO_TRUSTED_PROXY=$/m);
    // Exercise the built website with the key from prepare-env, not a hand-written fixture.
    // All account inputs are synthetic; no SMS provider is contacted or secrets printed.
    const invitations = docker(
      'exec',
      app('web'),
      'node',
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      const headers = {
        origin: 'https://localhost',
        'content-type': 'application/json',
        'x-artzoo-request': '1',
        'x-forwarded-for': '127.0.0.1'
      };
      const request = async (path, body, expected = 200) => {
        const response = await fetch('http://127.0.0.1:3100' + path, {
          method: body ? 'POST' : 'GET', headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(10000)
        });
        const result = await response.json();
        assert.equal(response.status, expected, result.error?.code ?? 'unexpected HTTP status');
        assert.equal(result.ok, true);
        const cookie = response.headers.get('set-cookie');
        if (cookie) headers.cookie = cookie.split(';')[0];
        return result.data;
      };
      await request('/api/auth/login', { phone: '+8613800000001', password: 'Synthetic-test-only-123' });
      const created = await request('/api/admin/invitations', {
        membership: 'FRIEND', usageMode: 'SINGLE',
        expiresAt: new Date(Date.now() + 3600000).toISOString()
      }, 201);
      assert.ok(/^\\/invite\\/[A-Za-z0-9_-]{43}$/.test(created.invitePath));
      const reopened = await request('/api/admin/invitations/' + created.invitation.id + '/link');
      assert.ok(reopened.invitePath === created.invitePath, 'encrypted invitation must round-trip');
      console.log('PASS: generated invitation key creates and reopens a real invitation');
    `
    );
    assert.equal(invitations.status, 0, invitations.stderr);
    assert.match(invitations.stdout, /PASS: generated invitation key/);
    const trustedWeb = app('web');
    rmSync(proxy);
    refuse('status');
    refuse('start');
    assert.equal(app('web'), trustedWeb, 'a missing override must not recreate the existing web');
    assert.equal(proxyValue('web'), 'ARTZOO_TRUSTED_PROXY=caddy');
    // The original no-override deployment remains supported; drift must be detected either way.
    const recreateWeb = (files = []) => {
      const result = compose(...files, 'up', '-d', '--no-deps', '--force-recreate', '--wait', 'web');
      assert.equal(result.status, 0, 'isolated web recreation must succeed');
    };
    recreateWeb();
    pass('status');
    writeFileSync(proxy, proxyContent, { mode: 0o640 });
    refuse('status');
    refuse('start');
    recreateWeb(['-f', proxy]);
    pass('status');
    // Real inspect verifies default and configured environments, without sending SMS.
    const inspect = (service) => {
      const result = docker('inspect', app(service));
      assert.equal(result.status, 0, 'inspect fixture container');
      return JSON.parse(result.stdout)[0];
    };
    for (const service of ['web', 'worker']) {
      const data = inspect(service);
      assert.equal(data.HostConfig.LogConfig.Type, 'json-file');
      assert.deepEqual(data.HostConfig.LogConfig.Config, { 'max-file': '3', 'max-size': '10m' });
      assert.ok(data.Config.Env.includes('ARTZOO_SMS_PROVIDER=unconfigured'));
    }
    const unconfigured = readFileSync(config, 'utf8');
    const secret = String.raw`SyntheticPrivateSms$#\x'"`;
    const settings = {
      ARTZOO_SMS_PROVIDER: 'aliyun-pnvs',
      ARTZOO_SMS_ACCESS_KEY_ID: 'SyntheticPrivateSmsId',
      ARTZOO_SMS_ACCESS_KEY_SECRET: `'${secret.replaceAll("'", "\\'")}'`,
      ARTZOO_SMS_SIGN_NAME: "'公会 测试'",
      ARTZOO_SMS_REGISTER_TEMPLATE_CODE: '100001',
      ARTZOO_SMS_RESET_TEMPLATE_CODE: '100003',
      AUTH_SMS_DAILY_LIMIT: '17',
      ARTZOO_MEDIA_GLOBAL_LIMIT_BYTES: '3000000000',
      ARTZOO_MEDIA_DAILY_LIMIT_BYTES: '1000000000'
    };
    const configured = unconfigured
      .split('\n')
      .map((line) => {
        const key = line.split('=')[0];
        return Object.hasOwn(settings, key) ? `${key}=${settings[key]}` : line;
      })
      .join('\n');
    writeFileSync(config, configured);
    pass('config-check');
    // New non-secret settings must reject stale containers before any restart.
    const oldWeb = app('web');
    refuse('status');
    refuse('start');
    assert.equal(app('web'), oldWeb);
    const rebuild = () => {
      const result = compose(
        '-f',
        proxy,
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        '--wait',
        'web',
        'worker'
      );
      assert.equal(
        result.status,
        0,
        result.stderr
          .split('\n')
          .filter((line) => !line.includes('SyntheticPrivateSms'))
          .join('\n')
          .replace(/[0-9a-f]{64}/g, '[redacted]')
      );
    };
    rebuild();
    const current = pass('status');
    assert.doesNotMatch(current.stdout + current.stderr, /SyntheticPrivateSms/);
    assert.match(current.stdout, /total=3000000000 daily=1000000000/);
    const webEnv = inspect('web').Config.Env;
    assert.ok(webEnv.includes(`ARTZOO_SMS_ACCESS_KEY_SECRET=${secret}`), 'literal secret survives Compose');
    assert.ok(webEnv.includes('ARTZOO_SMS_SIGN_NAME=公会 测试'));
    assert.ok(webEnv.includes('AUTH_SMS_DAILY_LIMIT=17'));
    assert.ok(webEnv.includes('ARTZOO_SMS_REGISTER_TEMPLATE_CODE=100001'));
    assert.ok(webEnv.includes('ARTZOO_SMS_RESET_TEMPLATE_CODE=100003'));
    assert.ok(webEnv.includes('ARTZOO_SMS_PROVIDER=aliyun-pnvs'));
    assert.ok(
      !inspect('worker').Config.Env.some((value) => /^(ARTZOO_SMS_(?!PROVIDER)|AUTH_SMS_)/.test(value))
    );
    const toolsCheck = compose(
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'node',
      'tools',
      '-e',
      'if(process.env.ARTZOO_SMS_PROVIDER!=="unconfigured" || Object.keys(process.env).some(k=>/^(ARTZOO_SMS_(?!PROVIDER)|AUTH_SMS_)/.test(k)))process.exit(1)'
    );
    assert.equal(toolsCheck.status, 0, 'tools must not receive SMS fields');
    for (const [key, value] of [
      ['ARTZOO_SMS_SIGN_NAME', "'另一个签名'"],
      ['AUTH_SMS_DAILY_LIMIT', '18'],
      ['ARTZOO_MEDIA_DAILY_LIMIT_BYTES', '900000000']
    ]) {
      writeFileSync(config, configured.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`));
      const result = invoke('status');
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(key));
      assert.doesNotMatch(result.stdout + result.stderr, /SyntheticPrivateSms/);
    }
    writeFileSync(config, configured);
    pass('status');
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
    assert.equal(proxyValue('web'), 'ARTZOO_TRUSTED_PROXY=caddy');
    assert.equal(proxyValue('worker'), 'ARTZOO_TRUSTED_PROXY=');
    assert.equal(sql('SELECT row_to_json(s)::text FROM "MediaBudgetState" s;'), before);
    assert.equal(compose('ps', '--quiet', 'postgres').stdout.trim(), database);
    assert.equal(sql('SELECT count(*) FROM "Account";'), '1');
  }
);
