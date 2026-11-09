/** Production-only, explicit console command. Checked before DB access or personal input. */
export function assertProductionOwnerCliContext(input: {
  argv: readonly string[];
  stdinTTY: boolean;
  stdoutTTY: boolean;
  environment: Readonly<Record<string, string | undefined>>;
}): void {
  const env = input.environment;
  if (
    input.argv.length ||
    !input.stdinTTY ||
    !input.stdoutTTY ||
    env.ARTZOO_OWNER_INITIALIZATION !== 'production-console' ||
    env.ARTZOO_DEPLOYMENT_ENV !== 'production' ||
    env.ARTZOO_PUBLIC_ORIGIN !== 'https://artzoo-fc.cn' ||
    env.PGHOST !== 'postgres' ||
    env.PGPORT !== '5432' ||
    env.PGUSER !== 'artzoo_app' ||
    env.PGDATABASE !== 'artzoo_prod' ||
    !env.PGPASSWORD ||
    env.DATABASE_URL ||
    env.SSH_CONNECTION ||
    env.SSH_CLIENT ||
    env.SSH_TTY
  ) {
    throw new Error('Production owner initialization requires the approved console, database and origin');
  }
}
