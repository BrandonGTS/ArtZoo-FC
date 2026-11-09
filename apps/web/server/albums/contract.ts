import { AccountError, isMemberId, type MemberSummary } from '@artzoo/domain';
import { PHOTO_RULES as ALBUM_RULES } from '../media/photo-contract';
export { ALBUM_RULES };
import {
  ALBUM_VISIBILITY_LABELS,
  type AlbumVisibility,
  type FeaturedPool
} from '../../content/album-publicity';
export type { AlbumVisibility, FeaturedPool };
export const primaryLabels = { GAME: '副本活动', DAILY: '日常活动', OFFLINE: '线下聚会' } as const;
export type Primary = keyof typeof primaryLabels;
export type UploadMode = 'AUTHOR' | 'COMMUNITY' | 'ACTIVITY';
export function bad(message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400);
}
export function missing(): never {
  throw new AccountError('NOT_FOUND', '相册或照片不存在', 404);
}
export function denied(message = '没有操作权限'): never {
  throw new AccountError('FORBIDDEN', message, 403);
}
export function idInput(value: unknown): string {
  if (typeof value !== 'string' || !isMemberId(value)) bad('标识无效');
  return value.toLowerCase();
}
export function optionalId(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : idInput(value);
}
export function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    bad('文字内容无效或过长');
  return value.trim();
}
export function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) bad('版本无效');
  return value;
}
export function primaryInput(value: unknown): Primary {
  if (typeof value !== 'string' || !(value in primaryLabels)) bad('请选择一级分类');
  return value as Primary;
}
export function visibilityInput(value: unknown): AlbumVisibility {
  if (typeof value !== 'string' || !Object.hasOwn(ALBUM_VISIBILITY_LABELS, value)) bad('请选择相册可见范围');
  return value as AlbumVisibility;
}
export function featuredPoolInput(value: unknown): FeaturedPool {
  if (value !== 'CANDIDATE' && value !== 'SELECTED') bad('请选择精选备选或入选池');
  return value;
}
export function pageInput(url: URL) {
  const raw = url.searchParams.get('page') ?? '1';
  if (!/^[1-9]\d{0,4}$/.test(raw)) bad('页码无效');
  return Number(raw);
}
export function uploadFields(body: Record<string, unknown>) {
  const batchId = idInput(body.batchId),
    batchIndex = body.batchIndex;
  if (
    typeof batchIndex !== 'number' ||
    !Number.isInteger(batchIndex) ||
    batchIndex < 0 ||
    batchIndex >= ALBUM_RULES.maxBatch
  )
    bad('每批最多10张图片');
  return { batchId, batchIndex, periodActivityId: optionalId(body.periodActivityId) };
}
export interface Person {
  id: string;
  displayName: string | null;
}
export interface Category {
  id: string;
  primary: Primary;
  label: string;
  active: boolean;
}
export interface PhotoView {
  id: string;
  albumId: string;
  createdAt: string;
  description: string;
  originalName: string;
  uploader: MemberSummary;
  rotation: number;
  width: number;
  height: number;
  frames: number;
  periodActivityId: string | null;
  revision: number;
  featuredAt: string | null;
  featuredPool: FeaturedPool | null;
  featuredSelectedAt: string | null;
  canFeature: boolean;
  featureUnavailableReason: string | null;
  likes: number;
  liked: boolean;
  comments: number;
  canEdit: boolean;
  canMove: boolean;
  canSetCover: boolean;
  canRemove: boolean;
  canRemoveSelf: boolean;
  isAdmin: boolean;
  previewUrl: string;
  thumbnailUrl: string;
}
export interface AlbumView {
  id: string;
  name: string;
  description: string;
  primary: Primary;
  category: Category | null;
  creator: Person;
  uploadMode: UploadMode;
  uploadsClosed: boolean;
  revision: number;
  activityId: string | null;
  seriesId: string | null;
  canUpload: boolean;
  canManage: boolean;
  canDelete: boolean;
  canDeleteSelf: boolean;
  isAdmin: boolean;
  photoCount: number;
  commentCount: number;
  visibility: AlbumVisibility;
  coverPhotoId: string | null;
  coverRotation: number;
  cover: string | null;
  periods: { id: string; periodNumber: number | null; title: string; canUpload: boolean }[];
}
export type { DailyCommentView as CommentView } from '../daily/contract';

export function mentionText(person: Person & { gameServer?: string | null }, repeated: boolean): string {
  return repeated
    ? `${person.displayName}（${person.gameServer || person.id.slice(0, 8)}）`
    : (person.displayName ?? '');
}
export function containsMention(body: string, value: string): boolean {
  return new RegExp('@' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)').test(body);
}

export function photoSelection(value: unknown): { id: string; revision: number }[] {
  if (!Array.isArray(value) || !value.length) bad('请选择要删除的照片');
  const rows = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) bad('照片选择无效');
    const row = item as Record<string, unknown>;
    return { id: idInput(row.id), revision: revision(row.revision) };
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length) bad('照片选择不能重复');
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}
export function photoRotation(current: number, direction: unknown): number {
  if (direction !== 'left' && direction !== 'right') bad('旋转方向无效');
  return (current + (direction === 'left' ? 270 : 90)) % 360;
}
