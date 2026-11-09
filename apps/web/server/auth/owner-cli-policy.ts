/** Checked before loading the database module or requesting any personal input. */
export function assertOwnerCliContext(input: {
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
    env.ARTZOO_DEPLOYMENT_ENV !== 'local' ||
    env.ARTZOO_PUBLIC_ORIGIN !== 'http://localhost:3100' ||
    env.SSH_CONNECTION ||
    env.SSH_CLIENT ||
    env.SSH_TTY
  ) {
    throw new Error(
      'Owner initialization requires a direct local TTY, no arguments, and the approved local origin'
    );
  }
}
