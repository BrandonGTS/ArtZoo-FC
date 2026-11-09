import type { ClientBase } from 'pg';

/** Preserve caller options byte-for-byte; PostgreSQL validates their syntax.
 * UTC is last so valid earlier timezone settings cannot select another zone. */
export function utcStartupOptions(options: string | undefined): string {
  return (options ? options + ' ' : '') + '-c timezone=UTC';
}

function verificationError(timeout = false): Error {
  // Do not retain driver errors, connection parameters or server response values.
  return new Error(timeout ? 'ARTZOO_DATABASE_TIMEZONE_TIMEOUT' : 'ARTZOO_DATABASE_TIMEZONE_UNVERIFIED');
}

/** Public pg PoolConfig.onConnect hook: pg-pool awaits this before acquisition
 * and destroys the new connection if it rejects. This checks initial state;
 * application SQL must not subsequently change the session timezone. */
export function verifyUtcConnection(client: Pick<ClientBase, 'query'>, timeoutMs = 3000): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000)
    return Promise.reject(verificationError());
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    };
    // pg-pool clears connectionTimeoutMillis before onConnect, so bound the hook itself.
    const deadline = setTimeout(() => finish(verificationError(true)), timeoutMs);
    void Promise.resolve()
      .then(() => client.query<{ timezone: string }>("SELECT current_setting('TimeZone') AS timezone"))
      .then(
        (result) =>
          finish(
            Array.isArray(result?.rows) && result.rows.length === 1 && result.rows[0]?.timezone === 'UTC'
              ? undefined
              : verificationError()
          ),
        () => finish(verificationError())
      )
      .catch(() => finish(verificationError()));
  });
}
