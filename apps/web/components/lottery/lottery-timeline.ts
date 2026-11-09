import { monthBounds, type LotteryView } from '../../server/lottery/contract';
export type LotteryStage = {
  title: string;
  time?: string;
  tone: 'normal' | 'waiting' | 'done' | 'cancelled';
};
/** Only recorded times are shown; waiting is a state, never a fabricated draw. */
export function lotteryStages(row: LotteryView, now: number): LotteryStage[] {
  const stages: LotteryStage[] = [{ title: '已发布', time: row.createdAt, tone: 'done' }];
  if (row.state === 'CANCELLED') return [...stages, { title: '已取消', tone: 'cancelled' }];
  if (row.state === 'DRAWN' && row.result)
    return [
      ...stages,
      { title: '预定开奖', time: row.drawAt, tone: 'done' },
      { title: '开奖已完成', time: row.result.processedAt, tone: 'done' }
    ];
  if (row.kind === 'MONTHLY' && row.month && now < monthBounds(row.month).start.getTime())
    return [
      ...stages,
      { title: '等待签到统计', time: monthBounds(row.month).start.toISOString(), tone: 'normal' },
      { title: '预定开奖', time: row.drawAt, tone: 'waiting' }
    ];
  const collecting =
    row.kind === 'MONTHLY' && row.month
      ? now < Math.min(monthBounds(row.month).end.getTime(), Date.parse(row.drawAt))
      : now < Date.parse(row.drawAt);
  return [
    ...stages,
    {
      title:
        row.kind === 'MONTHLY'
          ? collecting
            ? '签到统计中'
            : '签到统计已结束'
          : collecting
            ? '参与进行中'
            : '参与已结束',
      tone: collecting ? 'normal' : 'done'
    },
    { title: now < Date.parse(row.drawAt) ? '预定开奖' : '等待开奖', time: row.drawAt, tone: 'waiting' }
  ];
}
