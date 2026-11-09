import { AccountError, isMemberId, type MemberSummary } from '@artzoo/domain';
export function bad(message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400);
}
export function missing(): never {
  throw new AccountError('NOT_FOUND', '动态或评论不存在', 404);
}
export function denied(message = '没有操作权限'): never {
  throw new AccountError('FORBIDDEN', message, 403);
}
export function conflict(message = '内容已更新，请刷新后重新确认'): never {
  throw new AccountError('CONFLICT', message, 409);
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !isMemberId(value)) bad('标识无效');
  return value.toLowerCase();
}
export function text(value: unknown, max = 10000, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    bad('文字内容为空或过长');
  return value.trim();
}
export function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) bad('版本无效');
  return value;
}
export function ids(value: unknown): string[] {
  if (!Array.isArray(value)) bad('列表格式无效');
  const result = value.map(id);
  if (new Set(result).size !== result.length) bad('列表中有重复内容');
  return result;
}
export function mentionLabel(
  person: { id: string; displayName: string | null; gameServer?: string | null },
  repeated: boolean
) {
  return repeated
    ? `${person.displayName}（${person.gameServer || person.id.slice(0, 8)}）`
    : (person.displayName ?? '');
}
export function containsMention(body: string, label: string) {
  return new RegExp('@' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)').test(body);
}
export interface DailyMediaView {
  id: string;
  width: number;
  height: number;
  frames: number;
  thumbnailUrl: string;
  previewUrl: string;
}
export interface DailyPostView {
  id: string;
  body: string;
  mentions: string[];
  author: MemberSummary;
  createdAt: string;
  editedAt: string | null;
  revision: number;
  media: DailyMediaView[];
  likes: number;
  liked: boolean;
  comments: number;
  canEdit: boolean;
  canModerate: boolean;
}
export interface DailyCommentView {
  media: DailyMediaView[];
  id: string;
  body: string;
  author: MemberSummary;
  parentId: string | null;
  replyTo: MemberSummary | null;
  createdAt: string;
  revision: number;
  removed: boolean;
  canDelete: boolean;
  canModerate: boolean;
}
export interface DailyList {
  items: DailyPostView[];
  next: string | null;
}
export interface DailyPage extends DailyList {
  page: number;
  totalPages: number;
  total: number;
}
