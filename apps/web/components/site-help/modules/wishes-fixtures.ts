import {
  WISH_CATEGORIES,
  WISH_PAGE_SIZE,
  type WishDetail,
  type WishSummary
} from '../../../server/wishes/contract';

const author = {
  id: '00000000-0000-4000-8000-000000000071',
  displayName: '示例团长',
  gameRegion: '莫古力',
  gameServer: '神拳痕',
  membership: 'MEMBER' as const,
  avatar: null,
  bio: ''
};
const titles = [
  '一起收集喜欢的坐骑',
  '周末挑战高难副本',
  '生产采集互相交流',
  '一起探索新地图',
  '寻找成就同伴',
  '一起记录冒险故事'
];
export const WISH_DEMO_PUBLISH_VALUES = {
  title: '一起探索新地图',
  category: 'EXPLORE' as const,
  body: '想和大家一起探索地图、欣赏风景，顺路记录冒险中的有趣瞬间。',
  convenientTime: '周末晚上 20:00 后'
};
export const WISH_DEMO_ITEMS: WishSummary[] = WISH_CATEGORIES.map((category, index) => ({
  id: '00000000-0000-4000-8000-' + String(80 + index).padStart(12, '0'),
  title: titles[index]!,
  category: category.value,
  body: '想和朋友们一起体验这个主题，轻松交流，互相帮助。',
  wantedContent: '',
  convenientTime: '周末晚上 20:00 后',
  revision: 1,
  author,
  createdAt: '2026-10-31T08:00:00.000Z',
  interestCount: 3 + index,
  commentCount: 0,
  interested: false,
  isAuthor: false,
  activity: null
}));
function detail(wish: WishSummary): WishDetail {
  return {
    ...wish,
    comments: [],
    commentPage: 1,
    commentTotal: 0,
    commentRootTotal: 0,
    interests: [author],
    interestPage: 1
  };
}

/** Payloads only. The isolated host wraps these in ApiResult and never forwards writes. */
export function wishDemoResponse(
  path: string,
  method = 'GET',
  body: unknown = undefined
): unknown | undefined {
  const url = new URL(path, 'http://guide.invalid'),
    pathname = url.pathname;
  if (pathname !== '/api/wishes' && !pathname.startsWith('/api/wishes/')) return undefined;
  const selected = WISH_DEMO_ITEMS.find((item) => pathname.includes(item.id)) ?? WISH_DEMO_ITEMS[0]!;
  if (method.toUpperCase() !== 'GET') {
    if (/\/interest(?:\/cancel)?$/.test(pathname)) {
      const interested = !pathname.endsWith('/cancel');
      return {
        wish: detail({
          ...selected,
          interested,
          interestCount: selected.interestCount + (interested ? 1 : 0)
        }),
        replayed: false
      };
    }
    // A safe local acknowledgement only; no actual wish or business data is created.
    const values = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    return {
      wish: detail({
        ...selected,
        title: typeof values.title === 'string' ? values.title : selected.title,
        body: typeof values.body === 'string' ? values.body : selected.body,
        convenientTime:
          typeof values.convenientTime === 'string' ? values.convenientTime : selected.convenientTime
      }),
      replayed: false
    };
  }
  if (pathname === '/api/wishes' || pathname === '/api/wishes/home') {
    const query = (url.searchParams.get('query') ?? '').trim().toLowerCase(),
      category = url.searchParams.get('category');
    const items = WISH_DEMO_ITEMS.filter(
      (item) =>
        (!category || item.category === category) &&
        (!query || (item.title + item.body).toLowerCase().includes(query))
    );
    return { items, total: items.length, page: 1, pageSize: WISH_PAGE_SIZE, canPublish: true };
  }
  if (pathname.endsWith('/interests')) return { items: [author], total: 1, page: 1, pageSize: 10 };
  if (/\/comments(?:\/|$)/.test(pathname)) return { items: [], total: 0, page: 1, totalPages: 1, next: null };
  return detail(selected);
}
