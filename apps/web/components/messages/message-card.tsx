'use client';
import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Avatar, Button, Modal } from 'antd';
import type { MessageItem, MessageSource } from '@artzoo/domain';
import { useUserRouter as useRouter } from '../user-operation-provider';
import { beijingFull } from '../activities/activity-ui';
import DailyToolbarIcon from '../daily/daily-toolbar-icon';
import OperationMenu from '../operation-menu';
const sourceLabels: Record<MessageSource['type'], [string, string]> = {
  activity: ['calendar-days', '活动'],
  team: ['users', '固定队'],
  album: ['image', '相册'],
  knowledge: ['book-open', '知识分享'],
  daily: ['message-circle-more', '日常动态'],
  wish: ['heart', '心愿'],
  lottery: ['gift', '抽奖'],
  system: ['bell', '系统']
};
function SourceIcon({ type }: { type: MessageSource['type'] }) {
  const paths: Record<MessageSource['type'], React.ReactNode> = {
    activity: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M16 3v4M8 3v4M3 11h18" />
      </>
    ),
    team: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 6" />
      </>
    ),
    album: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8" cy="8" r="1" />
        <path d="m21 15-6-6L3 21" />
      </>
    ),
    knowledge: (
      <>
        <path d="M12 5c-3-2-6-2-9-1v16c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1ZM12 5v16" />
      </>
    ),
    daily: <path d="M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4Z" />,
    wish: <path d="M20 5a5 5 0 0 0-8 1 5 5 0 0 0-8-1c-5 5 0 10 8 16 8-6 13-11 8-16Z" />,
    lottery: (
      <>
        <rect x="3" y="8" width="18" height="4" />
        <path d="M5 12v9h14v-9M12 8v13M12 8C1 9 6-4 12 8c6-12 11 1 0 0Z" />
      </>
    ),
    system: (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M10 20h4" />
      </>
    )
  };
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[type]}
    </svg>
  );
}

function SourceBlock({ source, id }: { source: MessageSource; id: string }) {
  const [, label] = sourceLabels[source.type];
  return (
    <span id={id} className={`message-source${source.available ? '' : ' message-source-unavailable'}`}>
      <span className="message-source-copy">
        <span className="message-source-type">
          <SourceIcon type={source.type} />
          {label}
        </span>
        {source.available ? (
          <>
            {source.title ? <strong>{source.title}</strong> : null}
            {source.summary ? <span className="message-source-summary">{source.summary}</span> : null}
          </>
        ) : (
          <span>原内容已删除或当前不可访问</span>
        )}
      </span>
      {source.available && source.thumbnailUrl ? (
        <Image
          className="message-source-thumbnail"
          src={source.thumbnailUrl}
          alt="来源照片缩略图"
          width={64}
          height={64}
          unoptimized
        />
      ) : null}
    </span>
  );
}
/** Card background and ordinary content read; independent operation controls never bubble. */
export default function MessageCard({
  item,
  onRead,
  onDelete,
  disabled
}: {
  item: MessageItem;
  onRead(item: MessageItem): Promise<void>;
  onDelete(item: MessageItem): Promise<void>;
  disabled: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false),
    [reading, setReading] = useState(false),
    alive = useRef(false),
    inFlight = useRef(false),
    router = useRouter(),
    description = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const href = item.source ? (item.source.available ? item.source.href : null) : item.link?.href;
  const actor = item.actor ?? { id: null, name: '系统', server: null, avatarUrl: null };
  async function activate(event?: MouseEvent<HTMLElement>, destination = href, nativeLink = false) {
    event?.stopPropagation();
    const separateContext = !!(
      nativeLink &&
      destination &&
      event &&
      (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button === 1)
    );
    if (!separateContext) event?.preventDefault();
    if (disabled || inFlight.current) return;
    if (item.readAt) {
      if (destination && !separateContext) router.push(destination);
      return;
    }
    inFlight.current = true;
    setReading(true);
    try {
      await onRead(item);
      if (alive.current && destination && !separateContext) router.push(destination);
    } catch {
      /* The owner displays the shared failure feedback. No read state or navigation is fabricated. */
    } finally {
      inFlight.current = false;
      if (alive.current) setReading(false);
    }
  }
  const content = (
    <>
      <span className="message-event">
        <strong>{item.title}</strong>
      </span>
      {item.source ? (
        <SourceBlock source={item.source} id={description} />
      ) : item.link ? (
        <span id={description} className="message-source">
          {item.link.label}
        </span>
      ) : null}
    </>
  );
  const actionProps = {
    className: 'message-activation',
    'aria-label': `${item.readAt ? '已读' : '未读'}消息：${item.title}`,
    'aria-describedby': item.source || item.link ? description : undefined,
    'aria-disabled': disabled || reading || undefined,
    'aria-busy': reading || undefined
  };
  return (
    <article
      className="message-item"
      data-message-id={item.id}
      data-unread={!item.readAt}
      onClick={(event) => void activate(event, null)}
    >
      <div className="message-actor-avatar">
        {actor.id ? (
          <Link
            href={`/members/${actor.id}`}
            aria-label={`查看${actor.name}的资料`}
            onClick={(event) => void activate(event, `/members/${actor.id}`, true)}
            onAuxClick={(event) => {
              if (event.button === 1) void activate(event, `/members/${actor.id}`, true);
            }}
          >
            <Avatar size={44} src={actor.avatarUrl}>
              {Array.from(actor.name)[0]}
            </Avatar>
          </Link>
        ) : (
          <Avatar size={44}>
            <SourceIcon type="system" />
          </Avatar>
        )}
      </div>
      <div className="message-item-content">
        <div className="message-item-heading">
          <div className="message-actor-line">
            {actor.id ? (
              <Link
                className="message-actor-name"
                href={`/members/${actor.id}`}
                onClick={(event) => void activate(event, `/members/${actor.id}`, true)}
                onAuxClick={(event) => {
                  if (event.button === 1) void activate(event, `/members/${actor.id}`, true);
                }}
              >
                {actor.name}
              </Link>
            ) : (
              <strong className="message-actor-name">{actor.name}</strong>
            )}
            {actor.server ? (
              <span className="message-actor-server">
                <DailyToolbarIcon kind="server" />
                {actor.server}
              </span>
            ) : null}
          </div>
          <time dateTime={item.receivedAt ?? item.createdAt}>
            {beijingFull(item.receivedAt ?? item.createdAt)}
          </time>
        </div>
        {href ? (
          <div className="message-activation-group">
            <Link
              {...actionProps}
              className="message-activation message-title-activation"
              href={href}
              onClick={(event) => void activate(event, href, true)}
              onAuxClick={(event) => {
                if (event.button === 1) void activate(event, href, true);
              }}
              onKeyDown={(event) => {
                if (event.key === ' ') {
                  event.preventDefault();
                  if (!event.repeat) void activate();
                }
              }}
            >
              <span className="message-event">
                <strong>{item.title}</strong>
              </span>
            </Link>
            <Link
              className="message-source-activation"
              href={href}
              aria-label={`查看消息来源：${item.source?.title || item.link?.label || item.title}`}
              aria-disabled={disabled || reading || undefined}
              aria-busy={reading || undefined}
              onClick={(event) => void activate(event, href, true)}
              onAuxClick={(event) => {
                if (event.button === 1) void activate(event, href, true);
              }}
              onKeyDown={(event) => {
                if (event.key === ' ') {
                  event.preventDefault();
                  if (!event.repeat) void activate();
                }
              }}
            >
              {item.source ? (
                <SourceBlock source={item.source} id={description} />
              ) : (
                <span id={description} className="message-source">
                  {item.link?.label}
                </span>
              )}
            </Link>
          </div>
        ) : (
          <button {...actionProps} type="button" onClick={(event) => void activate(event, null)}>
            {content}
          </button>
        )}
      </div>
      <div
        className="message-independent-controls"
        onClick={(event) => event.stopPropagation()}
        onAuxClick={(event) => event.stopPropagation()}
      >
        <OperationMenu
          label="消息操作"
          disabled={disabled || reading}
          items={[{ key: 'delete', label: '删除消息', danger: true }]}
          onAction={() => setConfirmOpen(true)}
        />
        <Modal
          title="删除消息"
          open={confirmOpen}
          onCancel={() => {
            if (!disabled) setConfirmOpen(false);
          }}
          closable={!disabled}
          mask={{ closable: !disabled }}
          footer={
            <>
              <Button disabled={disabled} onClick={() => setConfirmOpen(false)}>
                取消
              </Button>
              <Button
                type="primary"
                danger
                disabled={disabled}
                onClick={() => {
                  if (!disabled)
                    void onDelete(item)
                      .then(() => setConfirmOpen(false))
                      .catch(() => {});
                }}
              >
                确认删除
              </Button>
            </>
          }
        >
          <p>确认删除这条消息？</p>
        </Modal>
      </div>
    </article>
  );
}
