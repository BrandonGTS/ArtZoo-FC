import type { LotteryView } from '../../server/lottery/contract';
export type LotteryControl = { label: string; action: 'join' | 'leave' | null; disabled: boolean };
/** Presentation only. Command eligibility and permanent AUTO withdrawal remain server-owned. */
export function lotteryControls(
  row: Pick<LotteryView, 'state' | 'mode' | 'drawAt' | 'mine'>,
  now: number
): LotteryControl[] {
  const inactive = (label: string): LotteryControl[] => [{ label, action: null, disabled: true }];
  if (row.state === 'CANCELLED') return inactive('本场已取消');
  if (row.state === 'DRAWN') return inactive('本场已开奖');
  if (Date.parse(row.drawAt) <= now) return inactive('等待开奖');
  if (row.mine.state === 'ACTIVE' && !row.mine.eligible)
    return [
      ...inactive(row.mine.reason || '当前不符合参与资格'),
      { label: row.mode === 'AUTO' ? '退出抽奖' : '取消报名', action: 'leave', disabled: false }
    ];
  if (row.mine.state === 'ACTIVE')
    return row.mode === 'AUTO'
      ? [...inactive('已参与'), { label: '退出抽奖', action: 'leave', disabled: false }]
      : [{ label: '取消报名', action: 'leave', disabled: false }];
  if (row.mode === 'AUTO')
    return inactive(
      row.mine.state === 'WITHDRAWN'
        ? '已退出，不可恢复'
        : !row.mine.eligible
          ? row.mine.reason || '不符合参与资格'
          : '尚未自动纳入'
    );
  return row.mine.eligible
    ? [{ label: '报名参与', action: 'join', disabled: false }]
    : inactive(row.mine.reason || '不符合参与资格');
}
