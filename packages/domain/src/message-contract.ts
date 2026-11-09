import { invalid } from './account-contract.js';
export const MESSAGE_CATEGORIES = ['comments', 'likes', 'recruitment', 'participation', 'system'] as const;
export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];
export interface MessageLink {
  href: string;
  label: string;
}
export interface MessageActor {
  id: string | null;
  name: string;
  server: string | null;
  avatarUrl: string | null;
}
export interface MessageSource {
  type: 'activity' | 'team' | 'album' | 'knowledge' | 'daily' | 'wish' | 'lottery' | 'system';
  available: boolean;
  title: string | null;
  summary: string | null;
  thumbnailUrl: string | null;
  href: string | null;
}
export interface MessageItem {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  link: MessageLink | null;
  receivedAt?: string;
  category?: MessageCategory;
  actor?: MessageActor;
  source?: MessageSource;
}
export type MessageCategoryUnread = Record<MessageCategory, number>;
export interface MessagePage {
  items: MessageItem[];
  scope: 'all' | 'unread';
  category?: MessageCategory;
  categoryUnread?: MessageCategoryUnread;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  unreadCount: number;
  serverNow: string;
}
export interface MessageUnread {
  unreadCount: number;
  systemUnreadCount?: number;
  categoryUnread?: MessageCategoryUnread;
}
export interface MessagePreview extends MessageUnread {
  items: MessageItem[];
}
export interface MessageDelete extends MessageUnread {
  id: string;
  deletedAt: string;
}
export interface MessageRead extends MessageUnread {
  id: string;
  readAt: string;
}
export function messageId(value: string): {
  source: 'event' | 'score' | 'team' | 'album' | 'knowledge' | 'daily' | 'wish' | 'lottery' | 'interaction';
  id: string;
} {
  const match =
    /^(event|score|team|album|knowledge|daily|wish|lottery|interaction):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      value
    );
  if (!match) invalid('id', '消息编号无效');
  return {
    source: match[1]!.toLowerCase() as ReturnType<typeof messageId>['source'],
    id: match[2]!.toLowerCase()
  };
}
export function messageQuery(url: URL) {
  const scope = url.searchParams.get('scope') ?? 'all',
    page = url.searchParams.get('page') ?? '1',
    category = url.searchParams.get('category') ?? 'comments';
  if (scope !== 'all' && scope !== 'unread') invalid('scope', '消息范围无效');
  if (!MESSAGE_CATEGORIES.includes(category as MessageCategory)) invalid('category', '消息分类无效');
  if (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page))) invalid('page', '页码无效');
  return { scope: scope as 'all' | 'unread', category: category as MessageCategory, page: Number(page) };
}
