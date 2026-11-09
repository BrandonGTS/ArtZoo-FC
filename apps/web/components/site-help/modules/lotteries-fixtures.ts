import type { LotteryView } from '../../../server/lottery/contract';

export const LOTTERY_DEMO_ID = '00000000-0000-4000-8000-000000000061';
export const LOTTERY_DEMO_MONTHLY_ID = '00000000-0000-4000-8000-000000000062';
const ordinary: LotteryView = {
  id: LOTTERY_DEMO_ID,
  title: '周末相聚的小礼物',
  kind: 'ORDINARY',
  mode: 'MANUAL',
  audience: 'MEMBER',
  month: null,
  minDays: null,
  prizes: [{ name: '冒险纪念小礼物', quantity: 2 }],
  drawAt: '2030-11-02T12:00:00.000Z',
  createdAt: '2030-10-31T02:00:00.000Z',
  creator: { id: '00000000-0000-4000-8000-000000000063', displayName: '示例发起人' },
  state: 'OPEN',
  result: null,
  isCreator: false,
  serverNow: '2030-10-31T04:00:00.000Z',
  mine: {
    gameNickname: '示例成员',
    membership: 'MEMBER',
    eligible: true,
    reason: null,
    count: null,
    prize: null,
    state: 'NONE',
    source: null,
    joinedAt: null
  }
};
const monthly: LotteryView = {
  ...ordinary,
  id: LOTTERY_DEMO_MONTHLY_ID,
  title: '月签到的相聚纪念',
  kind: 'MONTHLY',
  mode: 'AUTO',
  month: '2030-11',
  minDays: 10,
  drawAt: '2030-12-01T12:00:00.000Z',
  prizes: [{ name: '月签到纪念小礼物', quantity: 3 }],
  mine: { ...ordinary.mine, reason: '等待统计月份开始' }
};

/** A closed, read-only fixture namespace: no mutation, upload, draw or participation route. */
export function lotteryDemoResponse(path: string, method = 'GET', _body?: unknown): unknown | undefined {
  void _body;
  if (method.toUpperCase() !== 'GET') return undefined;
  const url = new URL(path, 'http://guide.invalid');
  if (url.pathname === '/api/lotteries') {
    const items = url.searchParams.get('category') === 'completed' ? [] : [ordinary, monthly];
    const query = (url.searchParams.get('search') ?? '').trim();
    const filtered = items.filter((item) => item.title.includes(query));
    return structuredClone({ items: filtered, total: filtered.length, page: 1, pageSize: 12 });
  }
  if (url.pathname === '/api/lotteries/' + LOTTERY_DEMO_ID) return structuredClone(ordinary);
  if (url.pathname === '/api/lotteries/' + LOTTERY_DEMO_MONTHLY_ID) return structuredClone(monthly);
  return undefined;
}
