import type { Pool, PoolClient, PoolConfig } from 'pg';
import { utcStartupOptions, verifyUtcConnection } from './connection-timezone.js';

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : fallback;
}

export function databasePoolOptions(env: Record<string, string | undefined>): PoolConfig {
  const worker = env.ARTZOO_PROCESS_ROLE === 'worker';
  return {
    host: env.PGHOST,
    port: Number(env.PGPORT ?? '5432'),
    user: env.PGUSER,
    database: env.PGDATABASE,
    password: env.PGPASSWORD,
    options: utcStartupOptions(env.PGOPTIONS),
    onConnect: verifyUtcConnection,
    max: positiveInteger(env.PG_POOL_MAX, worker ? 3 : 10, 50),
    application_name: worker ? 'artzoo-worker' : 'artzoo-web',
    connectionTimeoutMillis: 3000,
    statement_timeout: positiveInteger(env.PG_STATEMENT_TIMEOUT_MS, 15000, 2147483647),
    lock_timeout: positiveInteger(env.PG_LOCK_TIMEOUT_MS, 10000, 2147483647),
    idle_in_transaction_session_timeout: positiveInteger(
      env.PG_IDLE_TRANSACTION_TIMEOUT_MS,
      30000,
      2147483647
    )
  };
}

/** Three-second wall deadline includes waiting for a connection. Expired probes
 * destroy their connection; a transaction-local server deadline also cancels SQL,
 * rather than leaving a query running after a Promise.race timeout. */
export function probeDatabase(pool: Pick<Pool, 'connect'>, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let client: PoolClient | undefined;
    let released = false,
      expired = false;
    const release = (destroy = false) => {
      if (client && !released) {
        released = true;
        client.release(destroy);
      }
    };
    const deadline = setTimeout(() => {
      expired = true;
      release(true);
      reject(new Error('Database probe timed out'));
    }, timeoutMs);
    void pool
      .connect()
      .then(async (acquired) => {
        client = acquired;
        if (expired) {
          release(true);
          return;
        }
        await client.query('BEGIN');
        if (expired) return;
        const remaining = Math.max(1, Math.floor(timeoutMs - (performance.now() - started)));
        await client.query("SELECT set_config('statement_timeout', $1, true)", [String(remaining)]);
        if (expired) return;
        const rows = await client.query<{ ok: number }>('SELECT 1::int AS ok');
        if (expired) return;
        if (rows.rows[0]?.ok !== 1) throw new Error('Database probe failed');
        await client.query('COMMIT');
        if (expired) return;
        clearTimeout(deadline);
        release();
        resolve();
      })
      .catch((error) => {
        clearTimeout(deadline);
        release(true);
        reject(error);
      });
  });
}
