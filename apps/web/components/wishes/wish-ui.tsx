'use client';

import { useState, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button, Card, Tag } from 'antd';
import { WISH_CATEGORIES, type WishSummary, type WishWrite } from '../../server/wishes/contract';
import { errorDetail } from '../account/api';
import { useFeedbackMessage } from '../use-feedback-message';
import HomeCardSurface from '../home-card-surface';
import { useWishCommand } from './use-wish-command';
import './wishes.css';

export function WishPaper({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <Card
      variant="borderless"
      classNames={{ root: 'paper-panel paper-wish wish-paper ' + className, body: 'wish-paper-body' }}
    >
      {children}
    </Card>
  );
}

const categoryColors: Record<string, string> = {
  MOUNT: '#254B38',
  CHALLENGE: '#D3972A',
  CRAFT_GATHER: '#D9553F',
  EXPLORE: '#315F67',
  ACHIEVEMENT: '#746087',
  OTHER: '#687747'
};
export function WishCategoryTag({ category }: { category: WishSummary['category'] }) {
  const label = WISH_CATEGORIES.find((item) => item.value === category)?.label;
  return (
    <Tag color={category ? categoryColors[category] : undefined} variant={category ? 'solid' : 'outlined'}>
      {label ?? '未分类'}
    </Tag>
  );
}

export function WishFactIcon({ kind }: { kind: 'content' | 'interest' | 'time' }) {
  if (kind !== 'content')
    return (
      <Image
        className="wish-fact-icon"
        src={'/artzoo/icons/' + (kind === 'interest' ? 'users.svg' : 'calendar-days.svg')}
        alt=""
        width={20}
        height={20}
        unoptimized
      />
    );
  return (
    <svg
      className="wish-fact-icon"
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.67"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 5c-2-2-5-2-8-1v12c3-1 6-1 8 1 2-2 5-2 8-1V4c-3-1-6-1-8 1Zm0 0v12" />
    </svg>
  );
}

export type WishCardData = Pick<
  WishSummary,
  'id' | 'category' | 'title' | 'body' | 'convenientTime' | 'interestCount' | 'interested' | 'isAuthor'
>;
export function WishCard({
  wish,
  variant = 'list',
  onInterestChanged
}: {
  wish: WishCardData;
  variant?: 'list' | 'home' | 'preview';
  onInterestChanged?(): void;
}) {
  const command = useWishCommand(),
    { notify, contextHolder } = useFeedbackMessage();
  const [snapshot, setSnapshot] = useState<{ source: WishCardData; wish: WishSummary } | null>(null);
  const current = snapshot?.source === wish ? snapshot.wish : wish,
    preview = variant === 'preview';
  async function toggleInterest() {
    if (preview || current.isAuthor || command.busy) return;
    try {
      const result = command.uncertain
        ? await command.retry<WishWrite>()
        : await command.send<WishWrite>(
            '/api/wishes/' + wish.id + '/interest' + (current.interested ? '/cancel' : ''),
            {}
          );
      if (result) {
        setSnapshot({ source: wish, wish: result.wish });
        notify('success', result.wish.interested ? '已表达兴趣' : '已取消兴趣');
        onInterestChanged?.();
      }
    } catch (failure) {
      notify('error', errorDetail(failure).message);
    }
  }
  const card = (
    <WishPaper
      className={
        'wish-card' + (variant === 'home' ? ' wish-home-paper' : '') + (preview ? ' wish-preview-card' : '')
      }
    >
      {contextHolder}
      <div className="wish-card-title">
        <WishCategoryTag category={current.category} />
        <h3>
          {preview ? (
            current.title || '心愿标题'
          ) : (
            <Link data-home-card-link href={'/wishes/' + current.id}>
              {current.title}
            </Link>
          )}
        </h3>
      </div>
      <div className="wish-card-fact">
        <WishFactIcon kind="content" />
        <div>
          <span className="wish-card-fact-title">想玩的内容</span>
          <p className="wish-card-excerpt">{current.body || '想玩的内容'}</p>
        </div>
      </div>
      <p className="wish-card-fact">
        <WishFactIcon kind="interest" />
        <span>{current.interestCount} 人感兴趣</span>
      </p>
      <p className="wish-card-fact">
        <WishFactIcon kind="time" />
        <span className="wish-card-time">
          {current.convenientTime || (preview ? '方便时间' : '暂未填写')}
        </span>
      </p>
      <div className="wish-card-footer">
        <Button
          className="wish-card-interest"
          type={current.interested ? 'default' : 'primary'}
          aria-pressed={current.interested}
          disabled={preview || current.isAuthor}
          loading={command.busy}
          onClick={(event) => {
            event.stopPropagation();
            void toggleInterest();
          }}
        >
          {command.uncertain
            ? '重试兴趣操作'
            : current.isAuthor
              ? '我的心愿'
              : current.interested
                ? '取消兴趣'
                : '我也想'}
        </Button>
      </div>
      {command.uncertain ? (
        <p className="wish-meta" role="status">
          暂未确认兴趣操作结果，请重试。
        </p>
      ) : null}
    </WishPaper>
  );
  return preview ? (
    card
  ) : (
    <HomeCardSurface motionProfile="feed" interactionPaused={command.busy || command.uncertain}>
      {card}
    </HomeCardSurface>
  );
}
