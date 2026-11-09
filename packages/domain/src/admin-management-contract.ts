import type { AccountSummary, AdminRole } from './account-contract.js';
export interface ManagementAccount extends AccountSummary {
  adminRoleRevision: number;
}
export interface PublicSiteSettings {
  adminQq: string | null;
  revision: number;
  updatedAt: string | null;
}
export type ManagementKind = 'ADMIN_ROLE_CHANGED' | 'PUBLIC_ADMIN_QQ_CHANGED';
export interface ManagementAudit {
  id: string;
  kind: ManagementKind;
  actor: { id: string; displayName: string | null };
  target: { id: string; displayName: string | null } | null;
  beforeRole: AdminRole | null;
  afterRole: AdminRole | null;
  beforeQq: string | null;
  afterQq: string | null;
  reason: string;
  createdAt: string;
}
