import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/deployment-https-check.mjs', import.meta.url));
const templates = new URL('../../deployment/', import.meta.url);
const caddy = process.env.ARTZOO_CADDY_TEST_BIN;

test('HTTPS check rejects invalid arguments before connecting', () => {
  for (const args of [
    [],
    ['http://example.com'],
    ['https://example.com/path'],
    ['https://example.com', '0'],
    ['https://example.com', '13100', '121']
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL: HTTPS check/);
    assert.doesNotMatch(result.stderr, /Error:|at main/);
  }
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}
function execute(args, env, onOutput = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data) => {
        output += data;
        onOutput(output, child);
      });
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

test(
  'real Caddy templates verify TLS and forwarding, restoring config after success, failure and interruption',
  { skip: !caddy, timeout: 60000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'artzoo-caddy-test-'));
    let health = true;
    const backend = createServer((req, res) => {
      res.statusCode = health && req.url === '/api/health' ? 200 : 503;
      res.end(JSON.stringify({ ok: health }));
    });
    const backendPort = await listen(backend);
    const adminPort = await freePort();
    const tlsPort = await freePort();
    const env = {
      ...process.env,
      HOME: directory,
      XDG_DATA_HOME: join(directory, 'data'),
      XDG_CONFIG_HOME: join(directory, 'config')
    };
    let daemon;
    t.after(async () => {
      if (daemon && daemon.exitCode === null) {
        const stopped = once(daemon, 'close');
        daemon.kill('SIGTERM');
        await stopped;
      }
      await close(backend);
      rmSync(directory, { recursive: true, force: true });
    });
    const config = join(directory, 'Caddyfile');
    const publicConfig = readFileSync(new URL('Caddyfile.public.example', templates), 'utf8').replace(
      'SITE_DOMAIN',
      'site.example.com'
    );
    writeFileSync(config, publicConfig);
    const adapted = spawnSync(caddy, ['adapt', '--config', config, '--adapter', 'caddyfile', '--validate'], {
      encoding: 'utf8',
      env,
      timeout: 10000
    });
    assert.equal(adapted.status, 0, adapted.stderr);
    const publicJson = JSON.parse(adapted.stdout);
    assert.equal(publicJson.apps.http.servers.srv0.routes[0].match[0].host[0], 'site.example.com');
    assert.deepEqual(publicJson.apps.http.servers.srv0.listen, [':443']);
    const lanConfig = readFileSync(new URL('Caddyfile.lan.example', templates), 'utf8')
      .replace('{', `{\n admin 127.0.0.1:${adminPort}`)
      .replaceAll('LAN_IP', '192.0.2.1')
      .replace('https://192.0.2.1', `https://192.0.2.1:${tlsPort}`)
      .replace('127.0.0.1:13100', `127.0.0.1:${backendPort}`);
    writeFileSync(config, lanConfig);
    daemon = spawn(caddy, ['run', '--config', config, '--adapter', 'caddyfile'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let daemonLog = '';
    daemon.stderr.on('data', (data) => {
      daemonLog += data;
    });
    const admin = `http://127.0.0.1:${adminPort}/`;
    const ca = join(directory, 'data/caddy/pki/authorities/local/root.crt');
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`${admin}config/`, {
          signal: AbortSignal.timeout(500),
          headers: { Origin: new URL(admin).origin }
        });
        if (response.ok && existsSync(ca)) {
          ready = true;
          break;
        }
      } catch {
        /* Wait only for the isolated daemon. */
      }
      await delay(100);
    }
    assert.ok(ready, `isolated Caddy failed to start: ${daemonLog.slice(-3000)}`);
    const current = async () =>
      (await fetch(`${admin}config/`, { headers: { Origin: new URL(admin).origin } })).json();
    const original = await current();
    const checkEnv = { ...env, ARTZOO_CADDY_ADMIN: admin, ARTZOO_CADDY_CA: ca };
    const args = [`https://192.0.2.1:${tlsPort}`, String(backendPort)];
    const good = await execute(args, checkEnv);
    assert.equal(good.status, 0, good.output);
    assert.match(good.output, /certificate, health and forged forwarding headers/);
    assert.deepEqual(await current(), original);

    const badTrust = await execute(args, { ...checkEnv, ARTZOO_CADDY_CA: join(directory, 'missing.crt') });
    assert.equal(badTrust.status, 1);
    assert.match(badTrust.output, /original Caddy configuration restored/);
    assert.deepEqual(await current(), original);
    health = false;
    const badHealth = await execute(args, checkEnv);
    assert.equal(badHealth.status, 1);
    assert.match(badHealth.output, /original Caddy configuration restored/);
    assert.deepEqual(await current(), original);
    health = true;
    let interrupted = false;
    const stopped = await execute([...args, '60'], checkEnv, (output, child) => {
      if (!interrupted && output.includes('CLIENT CHECK')) {
        interrupted = true;
        child.kill('SIGTERM');
      }
    });
    assert.ok(interrupted);
    assert.equal(stopped.status, 1);
    assert.match(stopped.output, /original Caddy configuration restored/);
    assert.deepEqual(await current(), original);
  }
);
