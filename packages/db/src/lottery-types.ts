import type { Prisma } from './generated/prisma/client.js';
import type { LotteryInput, DrawResult, Identity } from '@artzoo/domain';
type Tx = Prisma.TransactionClient;
export type LotteryRow = Omit<LotteryInput, 'drawAt'> & {
  id: string;
  creatorId: string;
  fingerprint: string;
  drawAt: Date;
  createdAt: Date;
  state: 'OPEN' | 'DRAWN' | 'CANCELLED';
  result: DrawResult | null;
  closedAt: Date | null;
  moderatedAt?: Date | null;
  revision?: number;
};
export type Entry = {
  accountId: string;
  state: 'ACTIVE' | 'WITHDRAWN';
  source: 'MANUAL' | 'AUTO';
  joinedAt: Date;
};
export type DrawEligibilityRequest = {
  lottery: Pick<LotteryRow, 'id' | 'kind' | 'audience' | 'month' | 'minDays' | 'drawAt' | 'createdAt'>;
  /** null: complete account universe at drawAt for AUTO; otherwise exactly the frozen manual ACTIVE IDs. */
  accountIds: string[] | null;
};
export type DrawEligibilitySnapshot = {
  /** Must equal lottery.drawAt, never the worker execution clock. */
  at: Date;
  complete: boolean;
  accounts: { identity: Identity; registeredAt: Date; monthCount: number | null }[];
};
export interface LotteryPorts {
  /** Re-evaluated under locked Account rows. Integrator must bind the account lifecycle policy when it exists. */
  accountActive?: (tx: Tx, id: string) => Promise<boolean>;
  /** Mandatory for due draws. Must read durable temporal facts or a sealed drawAt snapshot. No current-state fallback. */
  drawEligibilityAt?: (tx: Tx, request: DrawEligibilityRequest) => Promise<DrawEligibilitySnapshot>;
  /** Bind countCheckinMonth from the check-in worker; read only, never writes attendance. */
  countMonth?: (tx: Tx, accountId: string, month: string) => Promise<number>;
  randomInt?: (max: number) => number;
}
