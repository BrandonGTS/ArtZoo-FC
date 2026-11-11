export interface MaintenanceRunState {
  failed: number;
  stopping: () => boolean;
}
export function createMaintenanceState(stopping: () => boolean = () => false): MaintenanceRunState {
  return { failed: 0, stopping };
}
/** Log identifiers and classified errors only, never provider messages or raw error objects. */
export function logMaintenanceFailure(step: string, id: string, error: unknown): void {
  const names = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'TimeoutError',
    'PrismaClientKnownRequestError',
    'PrismaClientUnknownRequestError'
  ]);
  let name = 'Error';
  let code: string | undefined;
  // Even property access can throw (getters or proxies). Logging must never become a failure path.
  try {
    const candidateName = error instanceof Error ? error.name : undefined;
    if (typeof candidateName === 'string' && names.has(candidateName)) name = candidateName;
    const value = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (
      typeof value === 'string' &&
      /^(P[0-9]{4}|40001|40P01|23505|23503|57014|55P03|08001|08006)$/.test(value)
    )
      code = value;
  } catch {
    /* Unreadable errors use only the fixed fallback name. */
  }
  try {
    console.error(JSON.stringify({ step, id, error: name, ...(code ? { code } : {}) }));
  } catch {
    /* A failed log sink must not prevent later maintenance. */
  }
}
export async function runMaintenanceItem<T>(
  state: MaintenanceRunState,
  step: string,
  id: string,
  action: () => Promise<T>
): Promise<T | undefined> {
  if (state.stopping()) return undefined;
  try {
    return await action();
  } catch (error) {
    state.failed++;
    logMaintenanceFailure(step, id, error);
    return undefined;
  }
}
