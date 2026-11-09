import type { Prisma, PrismaClient } from './generated/prisma/client.js';

import { localQcRuntimeAllowed } from '@artzoo/domain';
export { localQcRuntimeAllowed, localQcAccountAllowed } from '@artzoo/domain';

export class LocalQcDataBlocked extends Error {
  constructor() {
    super('Local QC data cannot run outside the approved local deployment');
  }
}

/** Normal non-local startup must refuse a database carrying QC accounts or content. */
export async function assertLocalQcDatabaseAllowed(
  db: PrismaClient | Prisma.TransactionClient,
  environment: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  if (localQcRuntimeAllowed(environment)) return;
  const [row] = await db.$queryRaw<{ blocked: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM "Account" WHERE "localQcNamespace" IS NOT NULL)
      OR EXISTS(SELECT 1 FROM "LocalQcRun") OR EXISTS(SELECT 1 FROM "LocalQcRecord") AS blocked`;
  if (row?.blocked) throw new LocalQcDataBlocked();
}
