/** One product visibility, stored in the existing publicity column without a migration. */
export const ALBUM_VISIBILITY_LABELS = { MEMBERS: '仅成员可见', PUBLIC: '公开可见' } as const;
export type AlbumVisibility = keyof typeof ALBUM_VISIBILITY_LABELS;
export type AlbumPublicity = 'INTERNAL' | 'PUBLIC_FEATURED';
export type FeaturedPool = 'CANDIDATE' | 'SELECTED';
export const visibilityFromPublicity = (value: AlbumPublicity): AlbumVisibility =>
  value === 'PUBLIC_FEATURED' ? 'PUBLIC' : 'MEMBERS';
export const publicityFromVisibility = (value: AlbumVisibility): AlbumPublicity =>
  value === 'PUBLIC' ? 'PUBLIC_FEATURED' : 'INTERNAL';
export const PUBLIC_FEATURED_UPLOAD_NOTICE =
  '上传到公开可见相册的照片可能被管理员设为精选并入选游客首页，访客可能保存照片。本站无法阻止访客保存，也无法追回已保存的副本。';
