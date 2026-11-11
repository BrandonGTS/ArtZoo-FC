import type { ActivityList, ActivitySummary, MemberSummary } from '@artzoo/domain';
import type { DailyCommentView, DailyPage, DailyPostView } from '../../../server/daily/contract';
import type { WishHomeList, WishSummary } from '../../../server/wishes/contract';

export const HOME_DAILY_MEMBER: MemberSummary = {
  id: '00000000-0000-4000-8000-000000000098',
  displayName: '示例成员',
  gameRegion: '莫古力',
  gameServer: '神拳痕',
  membership: 'MEMBER',
  avatar: null,
  bio: '一起记录日常与相聚。'
};
const person = { id: HOME_DAILY_MEMBER.id, displayName: HOME_DAILY_MEMBER.displayName, avatarUrl: null };
export const HOME_ACTIVITY_EXAMPLE: ActivitySummary = {
  id: '00000000-0000-4000-8000-000000000101',
  title: '周末一起冒险',
  description: '和朋友一起完成冒险，欢迎提前了解活动安排。',
  scene: 'GAME',
  mode: 'SINGLE',
  category: 'DUNGEON',
  startsAt: '2030-06-15T12:00:00.000Z',
  endsAt: '2030-06-15T14:00:00.000Z',
  registrationClosesAt: '2030-06-15T11:30:00.000Z',
  createdAt: '2030-06-01T10:00:00.000Z',
  organizer: person,
  capacity: 8,
  registeredCount: 3,
  participants: [person, { ...person, id: '00000000-0000-4000-8000-000000000097', displayName: '示例伙伴' }],
  status: 'OPEN',
  isOrganizer: false,
  myRegistration: null,
  revision: 0,
  cancelledAt: null,
  cancellationReason: null,
  continuedAt: null,
  myParticipation: null,
  duty: {
    id: null,
    name: '巴哈姆特大迷宫',
    type: 'OTHER',
    capacity: 8,
    partyComposition: 'FULL',
    catalogVersion: null,
    entryRevision: null,
    finalSeats: []
  }
};
export const DAILY_POST_EXAMPLE: DailyPostView = {
  id: '00000000-0000-4000-8000-000000000201',
  body: '今天和朋友们一起完成了冒险，期待下次相聚！',
  mentions: [],
  author: HOME_DAILY_MEMBER,
  createdAt: '2026-10-30T10:00:00.000Z',
  editedAt: null,
  revision: 0,
  media: [],
  likes: 3,
  liked: false,
  comments: 2,
  canEdit: false,
  canModerate: false
};
const comment: DailyCommentView = {
  id: '00000000-0000-4000-8000-000000000202',
  body: '下次也一起出发吧！',
  author: { ...HOME_DAILY_MEMBER, id: '00000000-0000-4000-8000-000000000097', displayName: '示例伙伴' },
  parentId: null,
  replyTo: null,
  createdAt: '2026-10-30T10:10:00.000Z',
  revision: 0,
  removed: false,
  canDelete: false,
  canModerate: false,
  media: []
};
export const HOME_WISH_EXAMPLE: WishSummary = {
  id: '00000000-0000-4000-8000-000000000301',
  title: '想一起看日出',
  category: 'EXPLORE',
  body: '找一个周末，和大家一起出发。',
  convenientTime: '周末清晨',
  revision: 0,
  author: HOME_DAILY_MEMBER,
  createdAt: '2026-10-30T10:00:00.000Z',
  interestCount: 3,
  commentCount: 0,
  interested: false,
  isAuthor: false,
  activity: null
};

/** Data only. Never forwards to live APIs; the iframe host rejects writes.
 * Returning undefined lets another isolated module respond to its own routes.
 */
export function homeDailyDemoResponse(path: string, method = 'GET', body?: unknown): unknown | undefined {
  void body;
  if (method.toUpperCase() !== 'GET') return undefined;
  const url = new URL(path, 'http://guide.invalid'),
    route = url.pathname;
  if (route === '/api/activities' && url.searchParams.get('upcoming') === '1')
    return {
      items: [HOME_ACTIVITY_EXAMPLE],
      serverNow: '2030-06-01T10:00:00.000Z',
      timeZone: 'Asia/Shanghai'
    } satisfies ActivityList;
  if (route === '/api/daily')
    return { items: [DAILY_POST_EXAMPLE], next: null, page: 1, totalPages: 1, total: 1 } satisfies DailyPage;
  if (route === '/api/daily/' + DAILY_POST_EXAMPLE.id) return DAILY_POST_EXAMPLE;
  if (route === '/api/daily/' + DAILY_POST_EXAMPLE.id + '/comments')
    return { items: [comment], page: 1, totalPages: 1 };
  if (route === '/api/wishes/home') return { items: [HOME_WISH_EXAMPLE] } satisfies WishHomeList;
  if (route === '/api/members') return { items: [HOME_DAILY_MEMBER] };
  if (route === '/api/quick-links')
    return {
      items: [
        {
          id: '00000000-0000-4000-8000-000000000401',
          name: '示例常用网站',
          url: 'https://example.invalid/',
          revision: 0,
          icon: null,
          ordinal: 0
        }
      ],
      revision: 0,
      page: 1,
      pageSize: 10,
      total: 1,
      totalPages: 1
    };
  return undefined;
}
