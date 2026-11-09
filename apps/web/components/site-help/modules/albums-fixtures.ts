import type { AlbumView, PhotoView } from '../../../server/albums/contract';
export const ALBUM_DEMO_ID = 'de000000-0000-4000-8000-000000000001';
export const ALBUM_DEMO_PHOTO_ID = 'de000000-0000-4000-8000-000000000011';
const author = {
  id: '00000000-0000-4000-8000-000000000099',
  displayName: '示例成员',
  gameRegion: '莫古力',
  gameServer: '神拳痕',
  membership: 'MEMBER' as const,
  avatar: null,
  bio: ''
};
const picture = '/artzoo/optimized/guide-album-preview.07992cafb88e3df3.webp';
const thumbnail = '/artzoo/optimized/guide-album-thumbnail.bd524541b2865488.webp';
export const ALBUM_DEMO: AlbumView = {
  id: ALBUM_DEMO_ID,
  name: '周末相聚的瞬间',
  description: '记录和朋友们一起冒险的时光。',
  primary: 'GAME',
  category: null,
  creator: author,
  uploadMode: 'AUTHOR',
  uploadsClosed: false,
  revision: 0,
  activityId: null,
  seriesId: null,
  canUpload: true,
  canManage: true,
  canDelete: true,
  canDeleteSelf: true,
  isAdmin: false,
  photoCount: 3,
  commentCount: 0,
  visibility: 'PUBLIC',
  coverPhotoId: ALBUM_DEMO_PHOTO_ID,
  coverRotation: 0,
  cover: thumbnail,
  periods: []
};
export const ALBUM_DEMO_PHOTOS: PhotoView[] = ['相聚合影.png', '冒险途中.png', '周末留念.png'].map(
  (name, index) => ({
    id: index === 0 ? ALBUM_DEMO_PHOTO_ID : 'de000000-0000-4000-8000-00000000001' + (index + 1),
    albumId: ALBUM_DEMO_ID,
    createdAt: '2026-10-31T10:00:00.000Z',
    description: '和朋友们一起记录美好的瞬间。',
    originalName: name,
    uploader: author,
    rotation: 0,
    width: 2172,
    height: 724,
    frames: 1,
    periodActivityId: null,
    revision: 0,
    featuredAt: null,
    featuredPool: null,
    featuredSelectedAt: null,
    canFeature: false,
    featureUnavailableReason: null,
    likes: 2,
    liked: false,
    comments: 0,
    canEdit: true,
    canMove: true,
    canSetCover: true,
    canRemove: true,
    canRemoveSelf: true,
    isAdmin: false,
    previewUrl: picture,
    thumbnailUrl: thumbnail
  })
);
/** Only synthetic GET data. The demo host must reject all writes and all unmatched API paths. */
export function albumDemoResponse(path: string, method: string, _body?: unknown): unknown | undefined {
  void _body;
  if (method.toUpperCase() !== 'GET') return undefined;
  const url = new URL(path, 'https://demo.invalid'),
    route = url.pathname;
  if (route === '/api/albums') return { items: [ALBUM_DEMO], hasMore: false };
  if (route === '/api/albums/' + ALBUM_DEMO_ID) return ALBUM_DEMO;
  if (route === '/api/albums/' + ALBUM_DEMO_ID + '/photos/viewer') return { items: ALBUM_DEMO_PHOTOS };
  if (route === '/api/albums/' + ALBUM_DEMO_ID + '/photos')
    return { items: ALBUM_DEMO_PHOTOS, page: 1, total: 3, totalPages: 1 };
  if (route === '/api/albums/' + ALBUM_DEMO_ID + '/comments')
    return { items: [], next: null, page: 1, rootPage: 1, totalPages: 1, total: 0 };
  if (route === '/api/albums/' + ALBUM_DEMO_ID + '/move-targets') return { items: [] };
  if (route.startsWith('/api/album-photos/'))
    return ALBUM_DEMO_PHOTOS.find((photo) => route === '/api/album-photos/' + photo.id);
  return undefined;
}
