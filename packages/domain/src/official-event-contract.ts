export type OfficialEventStatus = 'PENDING' | 'PUBLISHED' | 'REJECTED' | 'WITHDRAWN';
export type OfficialEventAction = 'SAVE' | 'APPROVE' | 'REJECT' | 'WITHDRAW';
export interface OfficialEventImageView {
  id: string;
  thumbnailUrl: string;
  previewUrl: string;
  sourceUrl: string;
}
export interface OfficialEventSummary {
  image?: OfficialEventImageView | null;
  id: string;
  title: string;
  sourceUrl: string;
  status: OfficialEventStatus;
  summary: string;
  startsAt: string | null;
  endsAt: string | null;
  revision: number;
  createdAt: string;
}
export interface OfficialEventAuditView {
  id: string;
  action: string;
  actor: { id: string; displayName: string | null } | null;
  reason: string;
  createdAt: string;
  before: unknown;
  after: unknown;
}
export interface OfficialEventDetail extends OfficialEventSummary {
  sourceKey: string;
  sourceText: string;
  manualFields: string[];
  audits: OfficialEventAuditView[];
  historyPage: number;
  historyTotal: number;
}
export interface OfficialSyncRunView {
  id: string;
  status: 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
  createdAt: string;
  finishedAt: string | null;
  imported: number;
  unchanged: number;
  errors: string[];
}
export interface OfficialEventList {
  items: OfficialEventSummary[];
  total: number;
  page: number;
  latestRun: OfficialSyncRunView | null;
}
export interface OfficialEventWrite {
  event: OfficialEventDetail;
  replayed: boolean;
}
export interface OfficialCalendarEvent {
  image?: OfficialEventImageView | null;
  id: string;
  title: string;
  summary: string;
  sourceUrl: string;
  startsAt: string;
  endsAt: string;
}
export interface OfficialCalendar {
  items: OfficialCalendarEvent[];
  month: string;
  serverNow: string;
  timeZone: 'Asia/Shanghai';
}
