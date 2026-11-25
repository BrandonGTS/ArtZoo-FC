import type { DutyType } from '@artzoo/domain';

export type PreviewActivity = {
  id: string;
  title: string;
  location: string;
  dutyType?: DutyType;
  artwork?: string;
  registeredCount: number;
  capacity: number;
  startsAt: string;
  durationMinutes: number;
  registrationClosesAt: string;
  agenda: readonly { minutesAfterStart: number; description: string }[];
  requirements: string;
};

export const previewWeekdays = ['一', '二', '三', '四', '五', '六', '日'];

export const previewActivities = [
  {
    id: 'group-photo',
    title: '部队合照',
    location: '海雾村 · 部队小屋集合',
    artwork: '/artzoo/preview/activities/guild-courtyard.webp',
    registeredCount: 6,
    capacity: 8,
    startsAt: '2026-11-21T20:00:00+08:00',
    durationMinutes: 60,
    registrationClosesAt: '2026-11-21T19:30:00+08:00',
    agenda: [
      { minutesAfterStart: 0, description: '在部队小屋门口集合，确认合照站位' },
      { minutesAfterStart: 15, description: '拍摄庭院和室内合照，自由补拍' }
    ],
    requirements: '请带一套想穿的幻化，提前到部队小屋集合。'
  },
  {
    id: 'treasure-maps',
    title: '周末寻宝',
    location: '摩杜纳 · 丧灵钟集合',
    artwork: '/artzoo/preview/activities/treasure-maps.webp',
    registeredCount: 3,
    capacity: 8,
    startsAt: '2026-11-21T21:30:00+08:00',
    durationMinutes: 45,
    registrationClosesAt: '2026-11-21T21:00:00+08:00',
    agenda: [
      { minutesAfterStart: 0, description: '在丧灵钟组队，确认藏宝图和路线' },
      { minutesAfterStart: 10, description: '按路线出发，轮流开图' }
    ],
    requirements: '有藏宝图可以带一张，提前整理背包。'
  },
  {
    id: 'raid-workshop',
    title: '周末零式教学团：万魔殿天狱篇从机制讲解到全队实战，欢迎新人和回归成员',
    location: '万魔殿 · 天狱篇',
    dutyType: 'SAVAGE',
    artwork: '/artzoo/preview/activities/moonlit-raid.webp',
    registeredCount: 5,
    capacity: 8,
    startsAt: '2026-11-21T22:45:00+08:00',
    durationMinutes: 90,
    registrationClosesAt: '2026-11-21T22:15:00+08:00',
    agenda: [
      { minutesAfterStart: 0, description: '组队集合，说明分工和站位' },
      { minutesAfterStart: 15, description: '讲解重点机制，分段练习' },
      { minutesAfterStart: 45, description: '全队连打，结束后简短复盘' }
    ],
    requirements: '请提前解锁天狱篇零式，进队后告知自己的练习进度。'
  },
  {
    id: 'stargazing',
    title: '观星小队',
    location: '观星台',
    artwork: '/artzoo/preview/activities/stargazing.webp',
    registeredCount: 2,
    capacity: 8,
    startsAt: '2026-11-22T21:00:00+08:00',
    durationMinutes: 45,
    registrationClosesAt: '2026-11-22T20:30:00+08:00',
    agenda: [
      { minutesAfterStart: 0, description: '在观星台集合，选好观景位置' },
      { minutesAfterStart: 10, description: '自由观景和截图' }
    ],
    requirements: '请提前确认观星台的传送点已解锁。'
  },
  {
    id: 'fishing',
    title: '海钓之夜',
    location: '利姆萨·罗敏萨',
    artwork: '/artzoo/preview/activities/night-fishing.webp',
    registeredCount: 4,
    capacity: 8,
    startsAt: '2026-11-28T20:30:00+08:00',
    durationMinutes: 60,
    registrationClosesAt: '2026-11-28T20:00:00+08:00',
    agenda: [
      { minutesAfterStart: 0, description: '在渡轮码头集合，检查鱼饵' },
      { minutesAfterStart: 10, description: '一起出发，分享各自的渔获' }
    ],
    requirements: '请提前解锁海钓，并准备常用鱼饵。'
  },
  {
    id: 'house-decor',
    title: '小屋布置',
    location: '海雾村 · 部队小屋',
    artwork: '/artzoo/preview/activities/guild-interior.webp',
    registeredCount: 2,
    capacity: 6,
    startsAt: '2026-12-06T21:00:00+08:00',
    durationMinutes: 75,
    registrationClosesAt: '2026-12-06T20:30:00+08:00',
    agenda: [
      { minutesAfterStart: 0, description: '在部队小屋看现有布置，选定要调整的区域' },
      { minutesAfterStart: 15, description: '试摆家具，确认最终布局' }
    ],
    requirements: '有想尝试的家具或布置参考，可以在集合时一起看。'
  }
] as const satisfies readonly PreviewActivity[];

export function formatPreviewDuration(totalMinutes: number) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分钟` : ''].filter(Boolean).join(' ');
}
