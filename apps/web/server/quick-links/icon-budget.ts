import type {
  Prisma,
  QuickIconMutationPlan,
  QuickIconMutationCaptureInput,
  QuickIconSettlementInput
} from '@artzoo/db';
import { MediaBudgetError, mediaBudgetPolicy, type MediaBudgetPolicy } from '@artzoo/domain';
import { mediaBudgetError } from '../media/budget-errors';

/** OFF must not parse unrelated quota settings, inspect the clock, allocate IDs or issue quota SQL. */
export function quickIconPolicy(env: Record<string, string | undefined>): MediaBudgetPolicy | null {
  if ((env.ARTZOO_MEDIA_BUDGET_ENABLED ?? '0') === '0') return null;
  try {
    return mediaBudgetPolicy(env);
  } catch (error) {
    throw mediaBudgetError(error);
  }
}
export function iconBudgetUnavailable(): never {
  throw mediaBudgetError(new MediaBudgetError('MEDIA_BUDGET_ICON_MEASUREMENT_REQUIRED'));
}
export function selectedIconBytes(icon: Buffer | null, rawBytes: number): number {
  if (icon === null) {
    if (rawBytes !== 0) iconBudgetUnavailable();
    return 0;
  }
  if (
    !Buffer.isBuffer(icon) ||
    icon.length < 1 ||
    icon.length > 65536 ||
    !Number.isSafeInteger(rawBytes) ||
    rawBytes < 1 ||
    rawBytes > 256 * 1024
  )
    iconBudgetUnavailable();
  return rawBytes;
}

/** Read a new tracked old generation under the caller's original catalog lock. */
export async function captureQuickIconMutation(
  tx: Prisma.TransactionClient,
  input: QuickIconMutationCaptureInput
): Promise<QuickIconMutationPlan | null> {
  try {
    const { captureQuickIconMutationTx } = await import('@artzoo/db');
    return await captureQuickIconMutationTx(tx, input);
  } catch (error) {
    throw mediaBudgetError(error);
  }
}

/** Original BYTEA mutation, command, old credit and new receipt share ONE transaction.
 * The shared coordinator verifies the old actual BYTEA and new generation, then credits
 * global stock before new admission. Original final authorization still runs afterwards.
 */
export async function settleQuickIcon(
  tx: Prisma.TransactionClient,
  input: QuickIconSettlementInput,
  policy: MediaBudgetPolicy,
  clock: () => Date,
  prior?: QuickIconMutationPlan | null
): Promise<void> {
  try {
    const { settleQuickIconMutationTx } = await import('@artzoo/db');
    await settleQuickIconMutationTx(tx, input, policy, clock, prior);
  } catch (error) {
    throw mediaBudgetError(error);
  }
}
