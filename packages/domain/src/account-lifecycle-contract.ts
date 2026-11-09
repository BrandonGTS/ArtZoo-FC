import type { ManagementAccount } from './admin-management-contract.js';
export interface LifecycleAccount extends ManagementAccount {
  active: boolean;
  lifecycleRevision: number;
}
export interface LifecycleImpact {
  activities: { id: string; title: string; startsAt: string; endsAt: string; registrationCount: number }[];
  registrations: { id: string; activityId: string; title: string; startsAt: string; endsAt: string }[];
  dissolvedTeams: { id: string; name: string }[];
  memberships: { id: string; teamId: string; teamName: string }[];
  sessions: { id: string; teamId: string; teamName: string; startsAt: string; endsAt: string }[];
  sessionMembers: {
    id: string;
    sessionId: string;
    teamId: string;
    teamName: string;
    timeVersion: number;
    startsAt: string;
    endsAt: string;
    beforeState: string;
    afterState: string;
  }[];
  substitutes: { id: string; teamId: string; teamName: string; startsAt: string; endsAt: string }[];
  applications: { id: string; teamId: string; teamName: string }[];
  sessionsRevoked: number;
}
export interface LifecyclePreview {
  account: LifecycleAccount;
  active: boolean;
  previewFingerprint: string;
  impact: LifecycleImpact;
  serverNow: string;
}
export interface LifecycleAudit {
  id: string;
  actor: { id: string; displayName: string | null };
  target: { id: string; displayName: string | null };
  beforeActive: boolean;
  afterActive: boolean;
  reason: string;
  impact: LifecycleImpact;
  createdAt: string;
}
export interface LifecycleResult {
  account: LifecycleAccount;
  replayed: boolean;
  auditId: string;
}
