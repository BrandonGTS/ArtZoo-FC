import {
  dutyPresetSeats,
  type ActivityList,
  type DutyCatalogList,
  type OfficialCalendar
} from '@artzoo/domain';

export const ACTIVITY_GUIDE_DAY = '2026-10-31';
export const ACTIVITY_GUIDE_TEMPLATE = dutyPresetSeats('FULL');
export const ACTIVITY_GUIDE_DUTY = {
  id: 'guide-bahamut',
  name: '巴哈姆特大迷宫',
  type: 'RAID' as const,
  capacity: 8,
  partyComposition: 'FULL' as const,
  defaultSeats: ACTIVITY_GUIDE_TEMPLATE,
  enabled: true,
  entryRevision: 1
};
export const ACTIVITY_GUIDE_CATALOG: DutyCatalogList = {
  catalogVersion: 'guide-v1',
  items: [ACTIVITY_GUIDE_DUTY]
};
const serverNow = '2026-10-31T04:00:00.000Z';
const organizer = { id: '00000000-0000-4000-8000-000000000099', displayName: '示例成员', avatarUrl: null };
export const ACTIVITY_GUIDE_LIST: ActivityList = {
  items: [
    {
      id: '00000000-0000-4000-8000-000000000301',
      revision: 1,
      title: '周末一起冒险',
      description: '一起体验副本，熟悉流程后再出发。',
      category: 'DUNGEON',
      startsAt: '2026-10-31T12:00:00.000Z',
      endsAt: '2026-10-31T14:00:00.000Z',
      registrationClosesAt: '2026-10-31T11:30:00.000Z',
      createdAt: '2026-10-30T04:00:00.000Z',
      organizer,
      capacity: 8,
      registeredCount: 2,
      participants: [
        organizer,
        { ...organizer, id: '00000000-0000-4000-8000-000000000098', displayName: '示例伙伴' }
      ],
      status: 'OPEN',
      isOrganizer: false,
      myRegistration: null,
      myParticipation: null,
      cancelledAt: null,
      cancellationReason: null,
      continuedAt: null,
      scene: 'GAME',
      mode: 'SINGLE',
      series: null,
      capacityUnlimited: false,
      duty: {
        id: ACTIVITY_GUIDE_DUTY.id,
        name: ACTIVITY_GUIDE_DUTY.name,
        type: ACTIVITY_GUIDE_DUTY.type,
        capacity: 8,
        partyComposition: 'FULL',
        catalogVersion: 'guide-v1',
        entryRevision: 1,
        finalSeats: ACTIVITY_GUIDE_TEMPLATE
      }
    }
  ],
  serverNow,
  timeZone: 'Asia/Shanghai'
};
export const ACTIVITY_GUIDE_OFFICIAL: OfficialCalendar = {
  items: [
    {
      id: '00000000-0000-4000-8000-000000000302',
      title: '守护天节 · 示例活动',
      summary: '在活动期间体验季节任务，并查看原文中的具体安排。',
      sourceUrl: '#guide-official-event',
      startsAt: '2026-10-28T02:00:00.000Z',
      endsAt: '2026-11-07T15:59:00.000Z',
      image: null
    }
  ],
  month: '2026-10',
  serverNow,
  timeZone: 'Asia/Shanghai'
};
/** Payloads only. The isolated host wraps these in the existing ok/data transport.
 * No real source or business API may be used as fallback for guide requests.
 */
export function activityDemoResponse(path: string, method = 'GET', _body?: unknown): unknown | undefined {
  void _body;
  const url = new URL(path, 'http://guide.local');
  if (method.toUpperCase() !== 'GET') return undefined;
  if (url.pathname === '/api/activities/duties') return ACTIVITY_GUIDE_CATALOG;
  if (url.pathname === '/api/activities') return ACTIVITY_GUIDE_LIST;
  if (url.pathname === '/api/official-events/calendar')
    return { ...ACTIVITY_GUIDE_OFFICIAL, month: url.searchParams.get('month') ?? '2026-10' };
  return undefined;
}
