import type { createMediaBudgetAdapter } from '@artzoo/db';
import type { AccountService } from '../auth/service';

/** Default OFF loads no DB/strategy module and performs no transaction, clock, ID or input work. */
export async function activityShareMediaBudget(
  auth: AccountService,
  environment: Record<string, string | undefined> = process.env
): Promise<ReturnType<typeof createMediaBudgetAdapter> | null> {
  if ((environment.ARTZOO_MEDIA_BUDGET_ENABLED ?? '0') === '0') return null;
  try {
    const [{ createMediaBudgetAdapter }, { mediaBudgetPolicy }] = await Promise.all([
      import('@artzoo/db'),
      import('@artzoo/domain')
    ]);
    return createMediaBudgetAdapter(auth.db, mediaBudgetPolicy(environment), () => auth.now());
  } catch (error) {
    throw (await import('../media/budget-errors')).mediaBudgetError(error);
  }
}
