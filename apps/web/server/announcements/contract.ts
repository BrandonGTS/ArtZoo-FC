export const ANNOUNCEMENT_MAX_LENGTH = 2000;
export type Announcement = { id: string; text: string; createdAt: string; active: boolean };
export type ActiveAnnouncements = { items: Pick<Announcement, 'id' | 'text'>[] };
export type AnnouncementList = {
  items: Announcement[];
  selectedIds: string[];
  revision: number;
  page: number;
  pageSize: number;
  total: number;
};
export type AnnouncementCommandResult = { revision: number; replayed: boolean; deleted?: boolean };
