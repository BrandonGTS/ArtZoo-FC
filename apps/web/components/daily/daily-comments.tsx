import StickerText from '../stickers/sticker-text';
import type { DiscussionTransport } from './discussion-transport';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button, Image, Input, Modal } from 'antd';
import { MemberAvatar } from '../members/member-ui';
import { accountRequest, errorDetail } from '../account/api';
import { useFeedbackMessage } from '../use-feedback-message';
import type { DailyCommentView } from '../../server/daily/contract';
import { useDailyCommand, dailyError } from './use-command';
import { DailyReplyComposer } from './lazy-composers';
import DailyToolbarIcon from './daily-toolbar-icon';
import DailyDeleteMenu from './daily-delete-menu';
import DailyInlineReply from './daily-inline-reply';

export function DailyTime({ value }: { value: string }) {
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date(value))}
    </time>
  );
}
export default function DailyComments({
  postId,
  onChange,
  variant = 'default',
  composerAvatar,
  onLockedChange,
  transport,
  composerMode = 'daily',
  onPageInfo,
  focusCommentId,
  composerActions,
  onLoadingChange,
  deferComposerUntilOpen = false
}: {
  postId: string;
  onChange(): Promise<void>;
  variant?: 'default' | 'home';
  composerAvatar?: ReactNode;
  onLockedChange?(locked: boolean): void;
  transport?: DiscussionTransport;
  onLoadingChange?(loading: boolean): void;
  composerMode?: 'daily' | 'bottom' | 'folding-bottom';
  deferComposerUntilOpen?: boolean;
  onPageInfo?(page: number, totalPages: number): void;
  focusCommentId?: string;
  composerActions?: ReactNode;
}) {
  const home = variant === 'home';
  const deferBottomComposer = home && composerMode === 'bottom' && deferComposerUntilOpen;
  const commentsUrl = transport?.listUrl ?? '/api/daily/' + postId + '/comments';
  const previousCommentsUrl = useRef(commentsUrl);
  const pageInfo = useRef(onPageInfo),
    loadingChange = useRef(onLoadingChange),
    loadGeneration = useRef(0);
  useEffect(() => {
    loadingChange.current = onLoadingChange;
  }, [onLoadingChange]);
  useEffect(() => {
    pageInfo.current = onPageInfo;
  }, [onPageInfo]);
  const focusedComment = useRef<string | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [composerOpened, setComposerOpened] = useState(
    !home || (composerMode !== 'folding-bottom' && !deferBottomComposer)
  );
  const [items, setItems] = useState<DailyCommentView[]>([]),
    [loading, setLoading] = useState(true);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null),
    [reply, setReply] = useState<DailyCommentView | null>(null);
  const [remove, setRemove] = useState<DailyCommentView | null>(null),
    [moderate, setModerate] = useState<DailyCommentView | null>(null),
    [reason, setReason] = useState('');
  const [inlineLocks, setInlineLocks] = useState<Set<string>>(() => new Set());
  const reportInlineLock = useCallback(
    (id: string, locked: boolean) =>
      setInlineLocks((current) => {
        if (current.has(id) === locked) return current;
        const next = new Set(current);
        if (locked) next.add(id);
        else next.delete(id);
        return next;
      }),
    []
  );
  const [commentLocked, setCommentLocked] = useState(false),
    { notify, contextHolder } = useFeedbackMessage();
  const command = useDailyCommand(),
    mounted = useRef(false),
    pending = useRef(false),
    locked = command.busy || command.uncertain || commentLocked || inlineLocks.size > 0;
  useEffect(() => {
    onLockedChange?.(locked);
  }, [locked, onLockedChange]);
  async function load() {
    const generation = ++loadGeneration.current;
    setLoading(true);
    loadingChange.current?.(true);
    try {
      const result = await accountRequest<{ items: DailyCommentView[]; page?: number; totalPages?: number }>(
        commentsUrl
      );
      if (mounted.current && loadGeneration.current === generation) {
        setItems(result.items);
        if (result.page && result.totalPages) pageInfo.current?.(result.page, result.totalPages);
      }
    } finally {
      if (mounted.current && loadGeneration.current === generation) {
        setLoading(false);
        loadingChange.current?.(false);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(),
      generation = ++loadGeneration.current;
    queueMicrotask(() => {
      if (!controller.signal.aborted && loadGeneration.current === generation) {
        setLoading(true);
        loadingChange.current?.(true);
      }
    });
    const userInitiated = previousCommentsUrl.current !== commentsUrl;
    previousCommentsUrl.current = commentsUrl;
    void accountRequest<{ items: DailyCommentView[]; page?: number; totalPages?: number }>(commentsUrl, {
      signal: controller.signal,
      userInitiated
    })
      .then((result) => {
        if (!controller.signal.aborted && loadGeneration.current === generation) {
          setItems(result.items);
          setError(null);
          if (result.page && result.totalPages) pageInfo.current?.(result.page, result.totalPages);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted && loadGeneration.current === generation)
          setError(dailyError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted && loadGeneration.current === generation) {
          setLoading(false);
          loadingChange.current?.(false);
        }
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [postId, commentsUrl]);
  useEffect(() => {
    if (
      !focusCommentId ||
      focusedComment.current === focusCommentId ||
      !items.some((item) => item.id === focusCommentId)
    )
      return;
    const target = document.getElementById('comment-' + focusCommentId);
    if (target) {
      focusedComment.current = focusCommentId;
      target.scrollIntoView({ block: 'center' });
    }
  }, [focusCommentId, items]);
  async function act(kind: 'remove' | 'moderate') {
    if (pending.current || command.busy || commentLocked || inlineLocks.size > 0) return;
    pending.current = true;
    setCommandError(null);
    let removed = false;
    try {
      const result = command.uncertain
        ? await command.retry()
        : kind === 'remove'
          ? await command.send(
              transport?.removeUrl?.(remove!.id) ?? '/api/daily/comments/' + remove!.id + '/remove',
              { revision: remove!.revision, ...(transport?.removeUrl ? { intent: 'SELF' } : {}) },
              transport?.removeMethod ?? 'POST'
            )
          : await command.send(
              transport?.moderateUrl?.(moderate!.id) ?? '/api/daily/' + postId + '/moderate',
              {
                commentId: moderate!.id,
                revision: moderate!.revision,
                reason,
                ...(transport?.moderateUrl ? { intent: 'MODERATE' } : {})
              },
              transport?.removeMethod ?? 'POST'
            );
      if (result && mounted.current) {
        removed = true;
        const rootId = (kind === 'remove' ? remove : moderate)!.id;
        setItems((current) => {
          const branch = new Set([rootId]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const item of current)
              if (item.parentId && branch.has(item.parentId) && !branch.has(item.id)) {
                branch.add(item.id);
                changed = true;
              }
          }
          return current.filter((item) => !branch.has(item.id));
        });
        setRemove(null);
        setModerate(null);
        setReason('');
        notify('success', '评论及其回复已删除');
        await Promise.all([load(), onChange()]);
      }
    } catch (failure) {
      if (mounted.current) {
        if (removed) setError(dailyError(failure));
        else if (['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(errorDetail(failure).code))
          setCommandError(dailyError(failure));
        else notify('error', dailyError(failure));
      }
    } finally {
      pending.current = false;
    }
  }
  const children = new Map<string | null, DailyCommentView[]>();
  for (const item of items) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item]);
  const visited = new Set<string>();
  const ordered: DailyCommentView[] = [],
    stack = [...(children.get(null) ?? [])].reverse();
  while (stack.length) {
    const item = stack.pop()!;
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    ordered.push(item);
    stack.push(...[...(children.get(item.id) ?? [])].reverse());
  }
  // Once requested, keep the same editor across close/save and later mode changes.
  if (!composerOpened && (editing || !home || (composerMode !== 'folding-bottom' && !deferBottomComposer)))
    setComposerOpened(true);
  const composer = (
    <DailyReplyComposer
      transport={transport}
      disabled={command.busy}
      autoFocus={home && (!transport || (deferBottomComposer && editing))}
      compactTools={home}
      submitLabel={home ? '发布' : undefined}
      postId={postId}
      parentId={reply?.id}
      replyName={reply ? reply.author.displayName || '成员' : undefined}
      onCancelReply={() => setReply(null)}
      onLockedChange={setCommentLocked}
      onSaved={async () => {
        setReply(null);
        await Promise.all([load(), onChange()]);
        if (composerMode === 'folding-bottom') setEditing(false);
      }}
    />
  );
  return (
    <section
      className={'daily-comments' + (home ? ' daily-home-comments' : '')}
      aria-label="评论与回复"
      data-home-card-independent={home || undefined}
      onClick={(event) => {
        if (home) event.stopPropagation();
      }}
      onAuxClick={(event) => {
        if (home) event.stopPropagation();
      }}
    >
      {home && composerMode === 'daily' && composerAvatar ? (
        <div className="daily-home-reply">
          {composerAvatar}
          <div className="daily-home-reply-content">
            {editing ? (
              composer
            ) : (
              <Button block className="daily-home-reply-placeholder" onClick={() => setEditing(true)}>
                说点什么吧
              </Button>
            )}
          </div>
        </div>
      ) : null}
      {contextHolder}
      {loading ? <p role="status">正在读取评论…</p> : null}
      {error ? (
        <p role="alert" className="daily-error">
          {error}
        </p>
      ) : null}
      <div className="daily-comment-list">
        {ordered.map((comment) => (
          <div
            id={'comment-' + comment.id}
            className={'daily-comment' + (comment.parentId ? ' daily-reply' : '')}
            key={comment.id}
          >
            <MemberAvatar member={comment.author} size={home ? 40 : 32} />
            <div className="daily-comment-content">
              <div className="daily-comment-heading">
                <div className="daily-person">
                  <Link href={'/members/' + comment.author.id}>{comment.author.displayName || '成员'}</Link>
                  {home && (comment.author.gameRegion || comment.author.gameServer) ? (
                    <span className="daily-meta daily-home-location">
                      <DailyToolbarIcon kind="server" />
                      {[comment.author.gameRegion, comment.author.gameServer].filter(Boolean).join(' · ')}
                    </span>
                  ) : null}
                  <DailyTime value={comment.createdAt} />
                </div>
                {home && (comment.canDelete || comment.canModerate) ? (
                  <DailyDeleteMenu
                    label={(comment.author.displayName || '成员') + '的评论管理操作'}
                    disabled={locked}
                    onDelete={comment.canDelete ? () => setRemove(comment) : undefined}
                    onModerate={
                      comment.canModerate
                        ? () => {
                            setModerate(comment);
                            setReason('');
                          }
                        : undefined
                    }
                  />
                ) : null}
              </div>
              <p className="daily-body">
                {comment.replyTo && !comment.removed ? (
                  <span>回复 {comment.replyTo.displayName || '成员'}： </span>
                ) : null}
                <StickerText text={comment.body} />
              </p>
              {comment.media?.length ? (
                <Image.PreviewGroup>
                  <div className="daily-comment-images">
                    {comment.media.map((media) => (
                      <Image
                        key={media.id}
                        src={media.thumbnailUrl}
                        alt="评论配图"
                        preview={{ src: media.previewUrl }}
                      />
                    ))}
                  </div>
                </Image.PreviewGroup>
              ) : null}
              {home ? (
                !comment.removed ? (
                  <DailyInlineReply
                    transport={transport}
                    postId={postId}
                    comment={comment}
                    count={(children.get(comment.id) ?? []).filter((item) => !item.removed).length}
                    disabled={command.busy}
                    onLockedChange={reportInlineLock}
                    onSaved={async () => {
                      await Promise.all([load(), onChange()]);
                    }}
                  />
                ) : null
              ) : (
                <>
                  <div className="daily-actions">
                    {!comment.removed ? (
                      <Button
                        type="link"
                        disabled={locked}
                        onClick={() => {
                          setReply(comment);
                          if (home) setEditing(true);
                          document.getElementById('daily-comment-input-' + postId)?.focus();
                        }}
                      >
                        回复
                      </Button>
                    ) : null}
                    {comment.canDelete ? (
                      <Button type="link" danger disabled={locked} onClick={() => setRemove(comment)}>
                        删除
                      </Button>
                    ) : null}
                    {comment.canModerate ? (
                      <Button
                        type="link"
                        danger
                        disabled={locked}
                        onClick={() => {
                          setModerate(comment);
                          setReason('');
                        }}
                      >
                        处理违规
                      </Button>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {!home ? composer : null}
      {home && composerMode !== 'daily' && composerActions ? (
        <div className="discussion-composer-actions">{composerActions}</div>
      ) : null}
      {home && composerMode !== 'daily' ? (
        <div className="daily-bottom-composer">
          {(composerMode === 'folding-bottom' && !editing) || (deferBottomComposer && !composerOpened) ? (
            <Button block className="daily-bottom-composer-placeholder" onClick={() => setEditing(true)}>
              说点什么吧…
            </Button>
          ) : null}
          <div hidden={composerMode === 'folding-bottom' && !editing}>
            {composerMode === 'folding-bottom' ? (
              <div className="daily-bottom-composer-heading">
                <Button
                  type="text"
                  aria-label="收起评论输入"
                  disabled={locked}
                  onClick={() => setEditing(false)}
                >
                  关闭
                </Button>
              </div>
            ) : null}
            {(composerMode !== 'folding-bottom' && !deferBottomComposer) || composerOpened ? composer : null}
          </div>
        </div>
      ) : null}
      <Modal
        title="删除评论"
        open={!!remove}
        onCancel={(event) => {
          event.stopPropagation();
          if (!locked) setRemove(null);
        }}
        modalRender={(modal) => (
          <div
            data-home-card-independent
            onClick={(event) => event.stopPropagation()}
            onAuxClick={(event) => event.stopPropagation()}
          >
            {modal}
          </div>
        )}
        closable={!locked}
        mask={{ closable: !locked }}
        footer={
          <div className="daily-actions daily-modal-actions">
            <Button disabled={locked} onClick={() => setRemove(null)}>
              取消
            </Button>
            <Button danger type="primary" loading={command.busy} onClick={() => void act('remove')}>
              {command.uncertain ? '重试删除' : '删除评论'}
            </Button>
          </div>
        }
      >
        <p>确定删除这条评论及其全部回复？</p>
        {commandError ? <p role="alert">{commandError}</p> : null}
      </Modal>
      <Modal
        title="处理违规评论"
        open={!!moderate}
        onCancel={(event) => {
          event.stopPropagation();
          if (!locked) setModerate(null);
        }}
        modalRender={(modal) => (
          <div
            data-home-card-independent
            onClick={(event) => event.stopPropagation()}
            onAuxClick={(event) => event.stopPropagation()}
          >
            {modal}
          </div>
        )}
        closable={!locked}
        mask={{ closable: !locked }}
        footer={
          <div className="daily-actions daily-modal-actions">
            <Button disabled={locked} onClick={() => setModerate(null)}>
              取消
            </Button>
            <Button
              danger
              type="primary"
              disabled={!command.uncertain && !reason.trim()}
              loading={command.busy}
              onClick={() => void act('moderate')}
            >
              {command.uncertain ? '重试删除' : '删除违规评论'}
            </Button>
          </div>
        }
      >
        <p>删除后，这条评论及其全部回复将一并移除。</p>
        <Input.TextArea
          autoComplete="off"
          aria-label="处理原因"
          value={reason}
          maxLength={1000}
          disabled={locked || command.uncertain}
          onChange={(event) => setReason(event.target.value)}
        />
        {commandError ? <p role="alert">{commandError}</p> : null}
      </Modal>
    </section>
  );
}
