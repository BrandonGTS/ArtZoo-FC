import type { AccountSummary, AdminRole } from './account-contract.js';
export interface ManagementAccount extends AccountSummary {
  adminRoleRevision: number;
}
export type ManagementKind = 'ADMIN_ROLE_CHANGED';
export interface ManagementAudit {
  id: string;
  kind: ManagementKind;
  actor: { id: string; displayName: string | null };
  target: { id: string; displayName: string | null } | null;
  beforeRole: AdminRole | null;
  afterRole: AdminRole | null;
  reason: string;
  createdAt: string;
}
