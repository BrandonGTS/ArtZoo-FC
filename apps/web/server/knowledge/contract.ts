import { AccountError, isMemberId, type MemberSummary } from '@artzoo/domain';
export type Body = Record<string, unknown>;
export const fail = (message: string, code = 'VALIDATION_ERROR', status = 400): never => {
  throw new AccountError(code, message, status);
};
export const denied = (): never => fail('没有操作权限', 'FORBIDDEN', 403);
export const conflict = (): never =>
  fail('内容已被其他操作修改，请重新打开最新文章后再保存；当前输入已保留', 'CONFLICT', 409);
export const missing = (): never => fail('文章或记录不存在', 'NOT_FOUND', 404);
export function id(value: unknown): string {
  if (typeof value !== 'string' || !isMemberId(value)) fail('标识无效');
  return (value as string).toLowerCase();
}
export function requiredCategoryId(value: unknown): string {
  if (value == null || (typeof value === 'string' && !value.trim())) fail('请选择分区');
  return id(value);
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail('版本无效');
  return value as number;
}
export function text(value: unknown, max: number, trim = true): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\u0000/.test(value))
    fail('文字内容为空或过长');
  return trim ? (value as string).trim() : (value as string);
}
export function fields(body: Body, allowed: string[]) {
  if (Object.keys(body).some((k) => !allowed.includes(k))) fail('请求包含不允许的字段');
}
export function tags(value: unknown): string[] {
  if (!Array.isArray(value)) fail('标签无效');
  return [...new Set((value as unknown[]).map((v) => text(v, 200000)))];
}
export function metadata(body: Body) {
  if (body.editMode !== 'AUTHOR' && body.editMode !== 'COMMUNITY') fail('编辑权限无效');
  return {
    title: text(body.title, 200),
    categoryId: requiredCategoryId(body.categoryId),
    jobs: tags(body.jobs),
    playstyles: tags(body.playstyles),
    gameVersions: tags(body.gameVersions),
    editMode: body.editMode as 'AUTHOR' | 'COMMUNITY'
  };
}
export function page(url: URL) {
  const p = url.searchParams.get('page') ?? '1';
  if (!/^[1-9]\d{0,4}$/.test(p)) fail('页码无效');
  return Number(p);
}
export type Person = Pick<
  MemberSummary,
  'id' | 'displayName' | 'gameRegion' | 'gameServer' | 'membership' | 'avatar'
>;
export interface Category {
  id: string;
  label: string;
  active: boolean;
  revision: number;
}
export interface ArticleSummary {
  id: string;
  title: string;
  summary: string;
  thumbnailUrls?: string[];
  author: Person;
  category: Category;
  jobs: string[];
  playstyles: string[];
  gameVersions: string[];
  editMode: 'AUTHOR' | 'COMMUNITY';
  createdAt: string;
  updatedAt: string;
}
export interface Article extends ArticleSummary {
  imageDimensions?: Record<string, { width: number; height: number }>;
  body: string;
  bodyFormat: 'PLAIN' | 'RICH_V1';
  revision: number;
  canEdit: boolean;
  canManage: boolean;
  canDelete: boolean;
  canHistory: boolean;
  isAdmin: boolean;
  hasOtherContributions: boolean;
  reads: number;
  collections: number;
  likes: number;
  comments: number;
  collected: boolean;
  liked: boolean;
}
export interface Version {
  imageDimensions?: Record<string, { width: number; height: number }>;
  id: string;
  number: number;
  body: string;
  bodyFormat: 'PLAIN' | 'RICH_V1';
  editor: Person;
  createdAt: string;
  restoredFromId: string | null;
}
export interface Comment {
  id: string;
  body: string;
  author: Person;
  replyTo: Person | null;
  parentId: string | null;
  createdAt: string;
  canDelete: boolean;
}
