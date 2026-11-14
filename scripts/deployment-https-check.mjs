// Run with the tools image and host networking; no host Node installation is needed.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { isDeepStrictEqual } from 'node:util';

async function main() {
  assert.ok(process.argv.length >= 3 && process.argv.length <= 5);
  const [address, backend = '13100', seconds = '0'] = process.argv.slice(2);
  const origin = new URL(address);
  assert.equal(origin.protocol, 'https:');
  assert.equal(origin.pathname, '/');
  assert.ok(!origin.username && !origin.password && !origin.search && !origin.hash);
  assert.match(backend, /^[1-9][0-9]{0,4}$/);
  assert.ok(Number(backend) <= 65535);
  assert.match(seconds, /^[0-9]{1,3}$/);
  assert.ok(Number(seconds) <= 120);
  const admin = new URL(process.env.ARTZOO_CADDY_ADMIN || 'http://127.0.0.1:2019/');
  assert.equal(admin.protocol, 'http:');
  assert.equal(admin.hostname, '127.0.0.1');
  assert.equal(admin.pathname, '/');
  assert.ok(!admin.username && !admin.password && !admin.search && !admin.hash);
  const caPath = process.env.ARTZOO_CADDY_CA || '/ca.crt';
  const ca = existsSync(caPath) ? readFileSync(caPath) : undefined;
  async function api(path, data) {
    const response = await fetch(new URL(path, admin), {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Origin: admin.origin },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(5000)
    });
    assert.ok(response.ok, 'Caddy admin operation failed');
    const body = await response.text();
    return body ? JSON.parse(body) : undefined;
  }
  function get(path, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: origin.port || 443,
          servername: isIP(origin.hostname) ? '' : origin.hostname,
          rejectUnauthorized: true,
          checkServerIdentity: (_host, certificate) => checkServerIdentity(origin.hostname, certificate),
          ca,
          path,
          headers: { Host: origin.host, ...headers }
        },
        (response) => {
          let body = '';
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () => {
            try {
              assert.equal(response.statusCode, 200);
              resolve(JSON.parse(body));
            } catch (error) {
              reject(error);
            }
          });
          response.on('error', reject);
        }
      );
      req.setTimeout(5000, () => req.destroy(new Error('HTTPS timeout')));
      req.on('error', reject);
      req.end();
    });
  }
  const original = await api('config/');
  assert.ok(!JSON.stringify(original).includes('"trusted_proxies"'), 'Unexpected trusted proxies');
  const servers = original.apps.http.servers;
  const selected = Object.entries(servers).filter(([, server]) =>
    server.routes?.some((route) => route.match?.some((match) => match.host?.includes(origin.hostname)))
  );
  assert.equal(selected.length, 1, 'Expected one matching Caddy site');
  const [serverName, server] = selected[0];
  function proxies(value) {
    if (!value || typeof value !== 'object') return [];
    return [...(value.handler === 'reverse_proxy' ? [value] : []), ...Object.values(value).flatMap(proxies)];
  }
  const handlers = proxies(server);
  assert.equal(handlers.length, 1);
  assert.deepEqual(handlers[0], {
    handler: 'reverse_proxy',
    upstreams: [{ dial: `127.0.0.1:${backend}` }]
  });
  const marker = `artzoo-probe-${randomBytes(12).toString('hex')}`;
  const path = `/${marker}`;
  const echo = createServer((req, res) => {
    const result = {
      source: req.headers['x-forwarded-for'],
      protocol: req.headers['x-forwarded-proto'],
      host: req.headers['x-forwarded-host']
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve, reject) => {
    echo.once('error', reject);
    echo.listen(0, '127.0.0.1', resolve);
  });
  let interrupted = false;
  let finishWindow;
  const interrupt = () => {
    interrupted = true;
    finishWindow?.();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let attempted = false;
  try {
    const temporary = structuredClone(original);
    temporary.apps.http.servers[serverName].routes.unshift({
      '@id': marker,
      match: [{ host: [origin.hostname], path: [path] }],
      handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${echo.address().port}` }] }],
      terminal: true
    });
    attempted = true;
    await api('load', temporary);
    for (const headers of [
      {},
      {
        'X-Forwarded-For': '203.0.113.77, 198.51.100.99',
        'X-Forwarded-Proto': 'http',
        'X-Forwarded-Host': 'forged.invalid'
      },
      { 'X-Forwarded-For': ['203.0.113.77', '198.51.100.99'] }
    ]) {
      assert.ok(!interrupted);
      assert.deepEqual(await get(path, headers), {
        source: '127.0.0.1',
        protocol: 'https',
        host: origin.host
      });
    }
    assert.deepEqual(await get('/api/health'), { ok: true });
    console.log('PASS: HTTPS certificate, health and forged forwarding headers');
    if (Number(seconds) > 0 && !interrupted) {
      console.log(`CLIENT CHECK (${seconds}s): ${origin.origin}${path}`);
      console.log('在另一设备访问，核对 source 等于该设备 IP、protocol=https、host 等于站点地址。');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Number(seconds) * 1000);
        finishWindow = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    assert.ok(!interrupted, 'Check interrupted');
  } finally {
    try {
      if (attempted) {
        const active = await api('config/');
        const routes = active.apps?.http?.servers?.[serverName]?.routes;
        const index = routes?.findIndex((route) => route['@id'] === marker) ?? -1;
        if (index >= 0) {
          routes.splice(index, 1);
          await api('load', active);
        }
        assert.ok(
          isDeepStrictEqual(await api('config/'), original),
          'Concurrent Caddy change; inspect configuration'
        );
        console.log('PASS: original Caddy configuration restored');
      }
    } finally {
      echo.closeAllConnections();
      await new Promise((resolve) => echo.close(resolve));
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
  }
}

main().catch(() => {
  console.error('FAIL: HTTPS check; verify Caddy configuration and connectivity. Raw diagnostics withheld.');
  process.exitCode = 1;
});
