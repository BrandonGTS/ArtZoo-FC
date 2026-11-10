// 数据库连接池与健康检查：连接数、超时参数、探测失败时销毁连接、退出时只关闭一次。
// pg 驱动和 Prisma 客户端都换成替身，不连真实数据库。
import test from 'node:test';
import assert from 'node:assert/strict';
import { databasePoolOptions, probeDatabase } from '../../packages/db/src/pool-health.ts';
import { getDatabase, checkDatabase, disconnectDatabase } from '../../packages/db/src/index.ts';
import { GET } from '../../apps/web/app/api/health/route.ts';
import { state } from './support/pool-stubs.mjs';

test('role defaults, pool limit and PostgreSQL server timeout options', () => {
  const web = databasePoolOptions({});
  assert.equal(web.max, 10);
  assert.equal(web.application_name, 'artzoo-web');
  assert.equal(web.connectionTimeoutMillis, 3000);
  assert.equal(web.statement_timeout, 15000);
  assert.equal(web.lock_timeout, 10000);
  assert.equal(web.idle_in_transaction_session_timeout, 30000);
  const worker = databasePoolOptions({
    ARTZOO_PROCESS_ROLE: 'worker',
    PG_POOL_MAX: '5',
    PG_STATEMENT_TIMEOUT_MS: '17000'
  });
  assert.equal(worker.max, 5);
  assert.equal(worker.application_name, 'artzoo-worker');
  assert.equal(worker.statement_timeout, 17000);
  assert.equal(databasePoolOptions({ ARTZOO_PROCESS_ROLE: 'worker' }).max, 3);
  for (const PG_POOL_MAX of ['0', '-1', '51', '3.5', 'abc', ' 3', 'Infinity'])
    assert.equal(databasePoolOptions({ PG_POOL_MAX }).max, 10);
});

test('100 probes and Prisma share exactly one pool without disconnecting it', async () => {
  Object.assign(process.env, {
    PGHOST: 'synthetic.invalid',
    PGUSER: 'synthetic',
    PGDATABASE: 'synthetic',
    PGPASSWORD: 'synthetic-not-used'
  });
  const first = getDatabase();
  for (let i = 0; i < 100; i++) await checkDatabase();
  assert.equal(state.pools.length, 1);
  assert.equal(state.clients, 1);
  assert.equal(getDatabase(), first);
  assert.equal(first.options.adapter.pool, state.pools[0]);
  assert.equal(first.options.adapter.options.disposeExternalPool, true);
  assert.equal(state.pools[0].totalCount, 1);
  for (const name of ['PGHOST', 'PGUSER', 'PGDATABASE', 'PGPASSWORD']) delete process.env[name];
});

test('probe uses transaction-local remaining server budget and releases healthy connection', async () => {
  const calls = [],
    releases = [];
  const client = {
    query: async (text, values) => {
      calls.push([text, values]);
      return { rows: text === 'SELECT 1::int AS ok' ? [{ ok: 1 }] : [] };
    },
    release: (destroy) => releases.push(destroy)
  };
  await probeDatabase({ connect: async () => client });
  assert.deepEqual(
    calls.map((x) => x[0]),
    ['BEGIN', "SELECT set_config('statement_timeout', $1, true)", 'SELECT 1::int AS ok', 'COMMIT']
  );
  assert.ok(Number(calls[1][1][0]) > 0 && Number(calls[1][1][0]) <= 3000);
  assert.deepEqual(releases, [false]);
});

test('probe acquisition deadline destroys a late-acquired connection and sends no query', async () => {
  let acquire;
  const releases = [],
    calls = [];
  const pending = probeDatabase(
    {
      connect: () =>
        new Promise((resolve) => {
          acquire = resolve;
        })
    },
    20
  );
  await assert.rejects(pending, /timed out/);
  acquire({ query: async (text) => calls.push(text), release: (destroy) => releases.push(destroy) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(releases, [true]);
  assert.deepEqual(calls, []);
});

test('probe query deadline destroys held connection and never returns it to pool', async () => {
  let fail;
  const releases = [],
    calls = [];
  const client = {
    query: (text) => {
      calls.push(text);
      if (text === 'SELECT 1::int AS ok')
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      return Promise.resolve({ rows: [] });
    },
    release: (destroy) => {
      releases.push(destroy);
      fail?.(new Error('closed'));
    }
  };
  await assert.rejects(probeDatabase({ connect: async () => client }, 20), /timed out/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(releases, [true]);
  assert.ok(!calls.includes('COMMIT'));
});

test('probe SQL failure and invalid response destroy transaction connection', async () => {
  for (const failure of [true, false]) {
    const releases = [];
    const client = {
      query: async (text) => {
        if (text === 'SELECT 1::int AS ok' && failure) throw new Error('query failed');
        return { rows: [] };
      },
      release: (destroy) => releases.push(destroy)
    };
    await assert.rejects(probeDatabase({ connect: async () => client }));
    assert.deepEqual(releases, [true]);
  }
});

test('public health response exposes only ok and has no healthy unconfigured case', async () => {
  for (const [configured, failed, status, ok] of [
    [true, false, 200, true],
    [true, true, 503, false],
    [false, false, 503, false]
  ]) {
    Object.assign(state, { configured, failed, probes: 0 });
    const response = await GET();
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { ok });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(state.probes, configured ? 1 : 0);
  }
});

test('shutdown closes initialized Prisma and pool once; concurrent calls share completion', async () => {
  const pool = state.pools.at(-1),
    clients = state.clients;
  let finish;
  state.disconnectWait = new Promise((resolve) => {
    finish = resolve;
  });
  state.adapterInitialized = true;
  const first = disconnectDatabase(),
    second = disconnectDatabase();
  assert.equal(first, second);
  assert.throws(() => getDatabase(), /disconnecting/);
  finish();
  await first;
  state.disconnectWait = null;
  state.adapterInitialized = false;
  assert.equal(pool.endCalls, 1);
  assert.equal(pool.ended, true);
  assert.equal(state.disconnects, 1);
  await disconnectDatabase();
  assert.equal(pool.endCalls, 1);
  assert.equal(state.clients, clients);
});

test('shutdown after probe-only startup closes pool without creating Prisma', async () => {
  Object.assign(process.env, {
    PGHOST: 'synthetic.invalid',
    PGUSER: 'synthetic',
    PGDATABASE: 'synthetic',
    PGPASSWORD: 'synthetic-not-used'
  });
  const clients = state.clients;
  await checkDatabase();
  const pool = state.pools.at(-1);
  await disconnectDatabase();
  assert.equal(state.clients, clients);
  assert.equal(pool.endCalls, 1);
  assert.equal(pool.ended, true);
});

test('failed first probe still closes pool without creating a client', async () => {
  state.connectFailure = true;
  const clients = state.clients;
  await assert.rejects(checkDatabase(), /synthetic connection failure/);
  const pool = state.pools.at(-1);
  state.connectFailure = false;
  await disconnectDatabase();
  assert.equal(state.clients, clients);
  assert.equal(pool.endCalls, 1);
});

test('Prisma disconnect failure still ends pool and clears singleton references', async () => {
  const first = getDatabase(),
    pool = state.pools.at(-1);
  state.disconnectFailure = true;
  await assert.rejects(disconnectDatabase(), /synthetic disconnect failure/);
  state.disconnectFailure = false;
  assert.equal(pool.endCalls, 1);
  const second = getDatabase();
  assert.notEqual(second, first);
  assert.notEqual(state.pools.at(-1), pool);
  await disconnectDatabase();
  const created = state.pools.length;
  await disconnectDatabase();
  assert.equal(state.pools.length, created);
  for (const name of ['PGHOST', 'PGUSER', 'PGDATABASE', 'PGPASSWORD']) delete process.env[name];
});
