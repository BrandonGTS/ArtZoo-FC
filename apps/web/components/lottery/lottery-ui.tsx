'use client';
import Image from 'next/image';
import { Card } from 'antd';
import type { LotteryView } from '../../server/lottery/contract';
import './lottery.css';
export function LotteryPaper({
  children,
  variant = 'left',
  className = ''
}: {
  children: React.ReactNode;
  variant?: 'left' | 'right' | 'q0' | 'q1' | 'q2' | 'q3';
  className?: string;
}) {
  return (
    <Card
      variant="borderless"
      className={`paper-panel paper-activity lottery-paper lottery-paper-${variant} ${className}`}
      styles={{ body: { padding: 24 } }}
    >
      {children}
    </Card>
  );
}
export const timeLabel = (time: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(time));
export const statusLabel = (row: LotteryView) =>
  row.state === 'CANCELLED'
    ? '已取消'
    : row.state === 'DRAWN'
      ? '已开奖'
      : new Date(row.drawAt) <= new Date(row.serverNow)
        ? '等待开奖'
        : row.kind === 'MONTHLY'
          ? '统计中'
          : '进行中';
export function LotteryPerson({ name, membership }: { name: string; membership?: string }) {
  return (
    <div className="lottery-person">
      <span className="lottery-avatar">
        <Image src="/artzoo/lottery/user-round.svg" alt="" width={16} height={16} unoptimized />
      </span>
      <span>
        {name}
        {membership ? ` · ${membership === 'MEMBER' ? '正式成员' : '朋友'}` : ''}
      </span>
    </div>
  );
}
export function ClaimNotes() {
  return (
    <section className="lottery-stack">
      <h3>领奖</h3>
      <p>
        中奖者请站外联系发起者。
        <br />
        网站不收取地址。
      </p>
    </section>
  );
}
export function LoadState({ loading, error }: { loading: boolean; error: string | null }) {
  return loading ? (
    <p role="status">加载中…</p>
  ) : error ? (
    <p role="alert" className="lottery-error">
      {error}
    </p>
  ) : null;
}
