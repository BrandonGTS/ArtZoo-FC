import type { Prisma } from '@artzoo/db';
import { AccountService } from '../auth/service';
import { ActivityService } from '../activities/service';

// Existing validation, duty catalog, activity/album creation and notification rules run
// on the caller's transaction. No second commit, registration or new activity engine.
export async function createWishActivity(
  auth: AccountService,
  tx: Prisma.TransactionClient,
  body: Record<string, unknown>,
  token?: string | null
) {
  const scoped = Object.create(auth) as AccountService;
  Object.defineProperty(scoped, 'db', { value: tx });
  scoped.transaction = async <T>(action: (client: Prisma.TransactionClient) => Promise<T>) => action(tx);
  return new ActivityService(scoped).create(body, token);
}

// Only the original author may organize the one linked activity. No delegation interface.
