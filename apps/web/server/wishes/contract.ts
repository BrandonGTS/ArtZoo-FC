import type { DailyCommentView } from '../daily/contract';
import { AccountError, type ActivitySummary, type MemberSummary } from '@artzoo/domain';
export const WISH_CATEGORIES = [
  { value: 'MOUNT', label: '坐骑收集' },
  { value: 'CHALLENGE', label: '高难挑战' },
  { value: 'CRAFT_GATHER', label: '生产采集' },
  { value: 'EXPLORE', label: '探索冒险' },
  { value: 'ACHIEVEMENT', label: '成就收集' },
  { value: 'OTHER', label: '其他心愿' }
] as const;
export type WishCategory = (typeof WISH_CATEGORIES)[number]['value'];
export const WISH_CONTENT_MAX = 11001;
export const WISH_PAGE_SIZE = 15;
export const WISH_INTEREST_PAGE_SIZE = 10;
// A read-only projection. Never infer an old category or write a legacy row on read.
export function wishContent(wish: { body?: string; wantedContent?: string }): string {
  const body = (wish.body ?? '').replace(/\r\n?/g, '\n').trim();
  const wanted = (wish.wantedContent ?? '').replace(/\r\n?/g, '\n').trim();
  if (!body) return wanted;
  if (!wanted || body === wanted || body.endsWith('\n' + wanted)) return body;
  return body + '\n' + wanted;
}
export function wishCategory(value: unknown, optional = false): WishCategory | null {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (!WISH_CATEGORIES.some((item) => item.value === value)) invalid('请选择心愿分类');
  return value as WishCategory;
}
export type WishPerson = MemberSummary;
export interface WishSummary {
  id: string;
  title: string;
  category: WishCategory | null;
  body: string;
  wantedContent: string;
  convenientTime: string;
  revision: number;
  author: WishPerson;
  createdAt: string;
  interestCount: number;
  commentCount: number;
  interested: boolean;
  isAuthor: boolean;
  activity: ActivitySummary | null;
}
export interface WishComment extends DailyCommentView {
  mentions: string[];
}
export interface WishDetail extends WishSummary {
  canModerate?: boolean;
  comments: WishComment[];
  commentPage: number;
  commentTotal: number;
  commentRootTotal: number;
  interests: WishPerson[];
  interestPage: number;
}
export interface WishList {
  items: WishSummary[];
  total: number;
  page: number;
  pageSize: number;
  canPublish: boolean;
}
export interface WishInterestList {
  items: WishPerson[];
  total: number;
  page: number;
  pageSize: number;
}
export interface WishHomeList {
  items: WishSummary[];
}
export interface WishWrite {
  wish: WishDetail;
  replayed: boolean;
}
export interface WishDelete {
  id: string;
  deleted: true;
  replayed: boolean;
}
export function invalid(message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400);
}
export function text(value: unknown, label: string, max: number, optional = false): string {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.trim().length > max)
    invalid(label + '格式无效或内容过长');
  return value.trim();
}
export function key(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    invalid('提交标识无效');
  return value;
}
export function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((k) => !allowed.includes(k))) invalid('请求包含无效字段');
}
export function publishInput(body: Record<string, unknown>) {
  fields(body, ['idempotencyKey', 'title', 'category', 'body', 'wantedContent', 'convenientTime']);
  const content = text(
    wishContent({
      body: body.body === undefined ? undefined : text(body.body, '想玩的内容', WISH_CONTENT_MAX, true),
      wantedContent:
        body.wantedContent === undefined ? undefined : text(body.wantedContent, '想玩的内容', 1000, true)
    }),
    '想玩的内容',
    WISH_CONTENT_MAX
  );
  return {
    idempotencyKey: key(body.idempotencyKey),
    title: text(body.title, '标题', 100),
    category: wishCategory(body.category)!,
    body: content,
    wantedContent: '',
    convenientTime: text(body.convenientTime, '方便时间', 500)
  };
}
export function pageNumber(value: string | null): number {
  if (value !== null && !/^[1-9]\d{0,5}$/.test(value)) invalid('页码无效');
  return Number(value ?? '1');
}
