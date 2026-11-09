/** A deployment fence, never a new authentication mechanism or eligibility policy. */
export function localQcRuntimeAllowed(
  environment: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return (
    environment.ARTZOO_DEPLOYMENT_ENV === 'local' &&
    environment.ARTZOO_PUBLIC_ORIGIN === 'http://localhost:3100'
  );
}

export function localQcAccountAllowed(
  account: { localQcNamespace?: string | null },
  environment: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return !account.localQcNamespace || localQcRuntimeAllowed(environment);
}
