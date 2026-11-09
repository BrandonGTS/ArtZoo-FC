'use client';
import { useId, useState, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button, Tag, theme } from 'antd';
import HomeCardSurface from '../home-card-surface';
import {
  isLotteryPrizeImageUrl,
  modeLabel,
  prizeCount,
  scopeLabel,
  type LotteryView
} from '../../server/lottery/contract';
import { LotteryPaper, timeLabel } from './lottery-ui';

export type LotteryCardData = Pick<
  LotteryView,
  'title' | 'kind' | 'mode' | 'audience' | 'month' | 'minDays' | 'prizes' | 'creator'
> & { id?: string; drawAt?: string; participation: string };
export function LotteryFactIcon({
  kind
}: {
  kind: 'creator' | 'mode' | 'scope' | 'time' | 'status' | 'prize';
}) {
  if (kind === 'time')
    return <Image src="/artzoo/icons/calendar-days.svg" alt="" width={20} height={20} unoptimized />;
  if (kind === 'creator' || kind === 'scope')
    return (
      <Image
        src={kind === 'creator' ? '/artzoo/lottery/user-round.svg' : '/artzoo/icons/users.svg'}
        alt=""
        width={20}
        height={20}
        unoptimized
      />
    );
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.67"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'mode' ? (
        <>
          <path d="M4 5h12M4 10h12M4 15h12" />
          <circle cx="7" cy="5" r="2" />
          <circle cx="13" cy="10" r="2" />
          <circle cx="8" cy="15" r="2" />
        </>
      ) : kind === 'status' ? (
        <>
          <circle cx="10" cy="10" r="7" />
          <path d="m6 10 3 3 5-6" />
        </>
      ) : (
        <>
          <path d="M3 8h14v3H3zM5 11v6h10v-6M10 8v9" />
          <path d="M10 8C4 8 4 2 7 3c2 0 3 5 3 5Zm0 0c6 0 6-6 3-5-2 0-3 5-3 5Z" />
        </>
      )}
    </svg>
  );
}
export function participationLabel(row: LotteryView) {
  if (row.state === 'CANCELLED') return '抽奖已取消';
  if (row.state === 'DRAWN') return row.mine.prize ? `你已中奖：${row.mine.prize}` : '结果已公布';
  return row.mine.state === 'ACTIVE'
    ? row.mine.source === 'AUTO'
      ? '你已自动纳入'
      : '你已参加'
    : row.mine.reason || '尚未参加';
}
export default function LotteryCard({
  row,
  motion = true,
  footer,
  detail = false,
  headerAction
}: {
  row: LotteryCardData;
  motion?: boolean;
  footer?: ReactNode;
  detail?: boolean;
  headerAction?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(detail),
    detailsId = useId(),
    { token } = theme.useToken();
  const facts = [
    { kind: 'creator' as const, label: '发起人', value: row.creator.displayName || '成员' },
    { kind: 'mode' as const, label: '参与方式', value: modeLabel(row.mode) },
    {
      kind: 'scope' as const,
      label: '资格范围',
      value:
        scopeLabel(row.audience) +
        (row.kind === 'MONTHLY' ? ` · ${row.month || '待选月份'} 签到至少 ${row.minDays ?? 'N'} 天` : '')
    },
    {
      kind: 'time' as const,
      label: '开奖时间',
      value: row.drawAt ? timeLabel(row.drawAt) : '待设置（北京时间）'
    },
    { kind: 'status' as const, label: '参与状态', value: row.participation }
  ].filter((fact) => !detail || fact.kind !== 'status');
  if (detail)
    facts.sort(
      (a, b) =>
        ['creator', 'time', 'mode', 'scope'].indexOf(a.kind) -
        ['creator', 'time', 'mode', 'scope'].indexOf(b.kind)
    );
  const card = (
    <LotteryPaper className="lottery-summary-card">
      <article className="lottery-stack">
        <div className="lottery-summary-title">
          <Tag color={row.kind === 'MONTHLY' ? token.colorError : token.colorPrimary} variant="solid">
            {row.kind === 'MONTHLY' ? '月签到抽奖' : '普通抽奖'}
          </Tag>
          <h2>
            {row.id && !detail ? (
              <Link href={`/lotteries/${row.id}`} data-home-card-link>
                {row.title}
              </Link>
            ) : (
              row.title || '抽奖标题'
            )}
          </h2>
          {headerAction}
        </div>
        <dl className="lottery-summary-facts">
          {facts.map((fact) => (
            <div className="lottery-summary-fact" key={fact.kind}>
              <dt>
                <LotteryFactIcon kind={fact.kind} />
                <span>{fact.label}：</span>
              </dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        <div
          className="lottery-prize-disclosure"
          data-home-card-independent
          onClick={(event) => event.stopPropagation()}
          onAuxClick={(event) => event.stopPropagation()}
        >
          <Button
            type="text"
            className="lottery-prize-toggle"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-controls={detailsId}
          >
            <LotteryFactIcon kind="prize" />
            <span>奖品详情（共 {prizeCount(row.prizes)} 份）</span>
            <span className={`lottery-chevron ${expanded ? 'is-expanded' : ''}`} aria-hidden="true" />
          </Button>
          {expanded ? (
            <div className="lottery-summary-prizes" id={detailsId}>
              {row.prizes.map((prize, index) => (
                <div className="lottery-summary-prize" key={index}>
                  {isLotteryPrizeImageUrl(prize.imageUrl) ? (
                    <Image
                      src={prize.imageUrl}
                      alt={prize.name || '奖品图片'}
                      width={64}
                      height={64}
                      unoptimized
                    />
                  ) : null}
                  <span>{prize.name || '奖品名称'}</span>
                  <span className="lottery-prize-quantity">{prize.quantity || 0} 份</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {footer}
      </article>
    </LotteryPaper>
  );
  return motion ? <HomeCardSurface motionProfile="feed">{card}</HomeCardSurface> : card;
}
