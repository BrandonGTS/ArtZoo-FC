import type { Prisma } from './generated/prisma/client.js';
import type { MediaBudgetPolicy } from '@artzoo/domain';

declare const quickIconPlanBrand: unique symbol;
/** Only a genuine same-transaction database capture can produce this capability. */
export type QuickIconMutationPlan = object & { readonly [quickIconPlanBrand]: never };
export interface QuickIconMutationCaptureInput {
  actorId: string;
  key: string;
  fingerprint: string;
  id: string;
  kind: 'update' | 'remove';
  /** Original ResourceLink revision, before the original mutation. */
  linkRevision: number;
  /** Original QuickLinkState revision, before the original mutation. */
  catalogRevision: number;
}
export type QuickIconSettlementInput =
  | {
      manual: boolean;
      actorId: string;
      key: string;
      fingerprint: string;
      id: string;
      version: string;
      rawBytes: number;
      storedBytes: number;
    }
  | { kind: 'retire-only'; actorId: string; key: string; fingerprint: string; id: string };
/** Type contract only. This module has no runtime implementation or successful stub. */
export interface QuickIconStockPort {
  captureQuickIconMutationTx(
    tx: Prisma.TransactionClient,
    input: QuickIconMutationCaptureInput
  ): Promise<QuickIconMutationPlan | null>;
  settleQuickIconMutationTx(
    tx: Prisma.TransactionClient,
    input: QuickIconSettlementInput,
    policy: MediaBudgetPolicy,
    clock: () => Date,
    prior?: QuickIconMutationPlan | null
  ): Promise<void>;
}
