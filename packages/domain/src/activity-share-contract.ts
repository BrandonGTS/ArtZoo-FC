export interface ActivityShareMedia {
  id: string;
  width: number;
  height: number;
  frames: number;
  previewUrl: string;
  thumbnailUrl: string;
}
export interface PublicActivityShare {
  id: string;
  title: string;
  body: string;
  media: ActivityShareMedia[];
  featuredAt: string | null;
}
export interface ActivityShareAudit {
  id: string;
  action: string;
  reason: string;
  actor: { id: string; displayName: string | null };
  createdAt: string;
}
export interface AdminActivityShare extends PublicActivityShare {
  activity: { id: string; title: string };
  revision: number;
  createdAt: string;
  updatedAt: string;
  creator: { id: string; displayName: string | null };
  allMedia: ActivityShareMedia[];
  audits: ActivityShareAudit[];
  historyPage: number;
  historyTotal: number;
}
export interface ActivityShareList<T = PublicActivityShare> {
  items: T[];
  page: number;
  total: number;
  hasMore: boolean;
}
