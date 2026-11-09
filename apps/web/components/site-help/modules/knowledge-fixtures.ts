import type { Article, ArticleSummary, Category, Person, Version } from '../../../server/knowledge/contract';
import type { DailyCommentView } from '../../../server/daily/contract';

/** Synthetic IDs and fixed content; no records are loaded from or saved to a business API. */
export const KNOWLEDGE_DEMO_ID = '00000000-0000-4000-8000-000000000701';
export const KNOWLEDGE_DEMO_ACTOR_ID = '00000000-0000-4000-8000-000000000099';
const createdAt = '2026-10-30T10:00:00.000Z';
export const KNOWLEDGE_DEMO_CATEGORIES: Category[] = [
  '日常杂谈',
  '同人创作',
  '剧情讨论',
  '游戏记录',
  '举手提问',
  '建议和BUG反馈'
].map((label, index) => ({
  id: '00000000-0000-4000-8000-' + String(710 + index).padStart(12, '0'),
  label,
  active: true,
  revision: 0
}));
const author: Person = {
  id: KNOWLEDGE_DEMO_ACTOR_ID,
  displayName: '示例成员',
  gameRegion: '莫古力',
  gameServer: '神拳痕',
  membership: 'MEMBER',
  avatar: null
};
const body =
  '和朋友一起冒险，总有一些值得记录的瞬间。\n\n这里整理了出发前的小准备：确认活动时间、检查队伍构成，再带上轻松的心情。\n\n也欢迎在评论中分享你的想法，让下一次相聚更有趣。';
export const KNOWLEDGE_DEMO_ARTICLE: Article = {
  id: KNOWLEDGE_DEMO_ID,
  title: '一起记录冒险中的小发现',
  summary: '出发前的小准备，以及和朋友相聚的瞬间。',
  author,
  category: KNOWLEDGE_DEMO_CATEGORIES[0]!,
  jobs: [],
  playstyles: [],
  gameVersions: [],
  editMode: 'AUTHOR',
  createdAt,
  updatedAt: createdAt,
  body,
  bodyFormat: 'PLAIN',
  revision: 0,
  canEdit: true,
  canManage: true,
  canDelete: true,
  canHistory: true,
  isAdmin: false,
  hasOtherContributions: false,
  reads: 28,
  collections: 3,
  likes: 6,
  comments: 2,
  collected: false,
  liked: false
};
export const KNOWLEDGE_DEMO_EDITOR = {
  title: '一起记录冒险中的小发现',
  body,
  bodyFormat: 'PLAIN' as const,
  categoryId: KNOWLEDGE_DEMO_CATEGORIES[0]!.id
};
const summaries: ArticleSummary[] = [
  KNOWLEDGE_DEMO_ARTICLE,
  {
    ...KNOWLEDGE_DEMO_ARTICLE,
    id: '00000000-0000-4000-8000-000000000702',
    title: '周末的游戏记录',
    category: KNOWLEDGE_DEMO_CATEGORIES[3]!,
    summary: '一次轻松的周末相聚。'
  }
];
const commenter = { ...author, id: '00000000-0000-4000-8000-000000000098', displayName: '示例朋友', bio: '' };
const comments: DailyCommentView[] = [
  {
    id: '00000000-0000-4000-8000-000000000721',
    body: '谢谢分享，期待下一次一起出发！',
    author: commenter,
    parentId: null,
    replyTo: null,
    createdAt: '2026-10-30T10:30:00.000Z',
    revision: 0,
    removed: false,
    canDelete: false,
    canModerate: false,
    media: []
  },
  {
    id: '00000000-0000-4000-8000-000000000722',
    body: '下次也一起记录吧。',
    author: { ...author, bio: '' },
    parentId: '00000000-0000-4000-8000-000000000721',
    replyTo: commenter,
    createdAt: '2026-10-30T10:35:00.000Z',
    revision: 0,
    removed: false,
    canDelete: true,
    canModerate: false,
    media: []
  }
];
const version: Version = {
  id: '00000000-0000-4000-8000-000000000731',
  number: 1,
  body,
  bodyFormat: 'PLAIN',
  editor: author,
  createdAt,
  restoredFromId: null
};

/** Return only a data payload. The isolated host wraps it in the usual API envelope.
 * Only the detail's automatic read receipt has a synthetic POST response. All user
 * mutations (publish/upload/like/collect/comment/delete/restore) remain unhandled
 * and must be rejected by the host, never forwarded.
 */
export function knowledgeDemoResponse(path: string, method = 'GET', _body?: unknown): unknown | undefined {
  void _body;
  const url = new URL(path, 'https://guide.invalid'),
    route = url.pathname;
  if (method.toUpperCase() === 'POST' && route === '/api/knowledge/' + KNOWLEDGE_DEMO_ID + '/read')
    return { reads: 28 };
  if (method.toUpperCase() !== 'GET') return undefined;
  if (route === '/api/knowledge/categories') return structuredClone({ items: KNOWLEDGE_DEMO_CATEGORIES });
  if (route === '/api/knowledge') {
    const query = (url.searchParams.get('query') ?? '').toLocaleLowerCase(),
      label = url.searchParams.get('categoryLabel');
    const items = summaries.filter(
      (item) => (!label || item.category.label === label) && item.title.toLocaleLowerCase().includes(query)
    );
    return structuredClone({ items, total: items.length, page: 1, pageSize: 10 });
  }
  if (route === '/api/knowledge/' + KNOWLEDGE_DEMO_ID) return structuredClone(KNOWLEDGE_DEMO_ARTICLE);
  if (route === '/api/knowledge/' + KNOWLEDGE_DEMO_ID + '/comments')
    return structuredClone({ items: comments, page: 1, totalPages: 1, total: 2 });
  if (route === '/api/knowledge/' + KNOWLEDGE_DEMO_ID + '/history')
    return structuredClone({ items: [version], total: 1, page: 1 });
  return undefined;
}
