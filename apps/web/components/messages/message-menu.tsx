'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useUserRouter as useRouter } from '../user-operation-provider';
import { Badge, Button, Popover } from 'antd';
import type { MessageItem } from '@artzoo/domain';
import { useAuthSession } from '../auth-session';
import { useFeedbackMessage } from '../use-feedback-message';
import { errorDetail } from '../account/api';
import { useMessageState } from './message-state';
import './messages.css';
export default function MessageMenu() {
  const { session } = useAuthSession(),
    owner = session?.user?.id ?? null;
  const { unreadCount, preview, previewLoading, previewError, loadPreview, markRead } = useMessageState();
  const { contextHolder, notify } = useFeedbackMessage(),
    router = useRouter();
  const [openOwner, setOpenOwner] = useState<string | null>(null),
    [busyOwner, setBusyOwner] = useState<string | null>(null);
  const busy = busyOwner === owner && owner !== null,
    mounted = useRef(false),
    active = useRef(owner),
    operation = useRef(false),
    revision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    active.current = owner;
    operation.current = false;
    ++revision.current;
  }, [owner]);
  async function view(item: MessageItem) {
    if (operation.current || !owner || !item.link) return;
    operation.current = true;
    setBusyOwner(owner);
    const actor = owner,
      stamp = ++revision.current;
    try {
      await markRead(item.id);
      if (!mounted.current || active.current !== actor || revision.current !== stamp) return;
      setOpenOwner(null);
      router.push(item.link.href);
    } catch (failure) {
      if (mounted.current && active.current === actor && revision.current === stamp)
        notify('error', errorDetail(failure).message);
    } finally {
      if (mounted.current && active.current === actor && revision.current === stamp) {
        operation.current = false;
        setBusyOwner(null);
      }
    }
  }
  return (
    <>
      {contextHolder}
      <Popover
        trigger={['hover', 'focus']}
        placement="bottomRight"
        align={{ overflow: { adjustX: true, adjustY: true, shiftX: 16 } }}
        mouseEnterDelay={0.15}
        mouseLeaveDelay={0.15}
        open={owner !== null && openOwner === owner}
        onOpenChange={(next) => {
          if (operation.current && !next) return;
          setOpenOwner(next ? owner : null);
          if (next) void loadPreview();
        }}
        classNames={{ root: 'message-preview-popover' }}
        content={
          <section className="message-preview" aria-label="未读消息预览" aria-busy={previewLoading}>
            <div className="message-preview-heading">
              <span>未读消息</span>
              <span className="activity-note">{unreadCount ?? '—'} 条</span>
            </div>
            {previewError ? (
              <div className="message-preview-error" role="alert">
                <span>{previewError}</span>
              </div>
            ) : null}
            {previewLoading && !preview ? (
              <p className="activity-note" role="status">
                正在读取消息…
              </p>
            ) : null}
            {preview?.length ? (
              preview.slice(0, 5).map((item) => (
                <article className="message-preview-item" key={item.id}>
                  <p className="message-unread-title">{item.title}</p>
                  <p className="message-preview-copy">{item.body}</p>
                  {item.link ? (
                    <Button type="link" disabled={busy || previewLoading} onClick={() => void view(item)}>
                      {item.link.label}
                    </Button>
                  ) : null}
                </article>
              ))
            ) : preview && !previewLoading && !previewError ? (
              <p className="activity-note">暂无未读消息</p>
            ) : null}
            <Link
              className="activity-text-link message-preview-all"
              href="/me/messages"
              onClick={() => setOpenOwner(null)}
            >
              {(unreadCount ?? 0) > 5 || (preview?.length ?? 0) > 5
                ? '更多消息请进入消息中心查看'
                : '进入消息中心'}
            </Link>
          </section>
        }
      >
        <span className="message-entry-trigger">
          <Badge dot={!!unreadCount} color="#436B4E">
            <Button
              type="text"
              className="message-entry"
              href="/me/messages"
              aria-label={unreadCount ? '消息中心，有未读消息' : '消息中心'}
              icon={
                <Image
                  className="local-icon"
                  src="/artzoo/icons/message-circle-more.svg"
                  alt=""
                  width={20}
                  height={20}
                  unoptimized
                  aria-hidden
                />
              }
            />
          </Badge>
        </span>
      </Popover>
    </>
  );
}
