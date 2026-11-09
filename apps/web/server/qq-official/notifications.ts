import * as database from '@artzoo/db';
import type { Prisma } from '@artzoo/db';

/** Invoked once per committed business command, under its existing activity/series lock.
 * No changes to legacy mock QQ receipts, IN_APP delivery, signup, or penalties.
 */
export async function notifyQqActivity(
  tx: Prisma.TransactionClient,
  activityId: string,
  kind: 'PUBLISHED' | 'CHANGED' | 'CANCELLED' | 'REMINDERS',
  now: Date
): Promise<number> {
  // Legacy unit fixtures may provide only the pre-existing DB exports. Real packages always
  // export this helper; keeping the disabled path inert also preserves those domain-only fixtures.
  return database.enqueueConfiguredQqActivityNotifications?.(tx, activityId, kind, now) ?? 0;
}
