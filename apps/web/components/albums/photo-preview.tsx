'use client';
import Image from 'next/image';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button, Input, Spin } from 'antd';
import type { AlbumView, PhotoView } from '../../server/albums/contract';
import Modal from './album-modal';
import { AccountApiError } from '../account/api';
import { MemberAvatar } from '../members/member-ui';
import { DailyTime } from '../daily/daily-comments';
import DailyToolbarIcon from '../daily/daily-toolbar-icon';
import DailyActionIcon from '../daily/daily-action-icon';
import { useFeedbackMessage } from '../use-feedback-message';
import AlbumComments from './album-comments';
import {
  showReclamationFeedback,
  stopReclamationRuns,
  type ReclamationResponse
} from './reclamation-feedback';
import { albumPatch, albumRequest, errorDetail } from './api';
import { useAlbumResource } from './use-album-resource';
import './album-detail-qc.css';
import OperationMenu from '../operation-menu';

export function AlbumActionMenu({
  label,
  items,
  onAction,
  disabled = false
}: {
  label: string;
  items: { key: string; label: string; disabled?: boolean }[];
  onAction(action: string): void;
  disabled?: boolean;
}) {
  return (
    <OperationMenu
      label={label}
      disabled={disabled}
      items={items.map((item) => ({
        ...item,
        danger: item.key === 'remove' || item.key === 'moderate' || item.key === 'unfeature'
      }))}
      onAction={onAction}
    />
  );
}
export function AlbumPhotoThumbnail({
  photo
}: {
  photo: Pick<PhotoView, 'thumbnailUrl' | 'description' | 'originalName' | 'width' | 'height' | 'rotation'>;
}) {
  return (
    <Image
      unoptimized
      draggable={false}
      src={photo.thumbnailUrl}
      alt={photo.description || photo.originalName}
      width={photo.width}
      height={photo.height}
      style={{ transform: `rotate(${photo.rotation || 0}deg)` }}
    />
  );
}
function ToolIcon({ kind }: { kind: 'back' | 'previous' | 'next' | 'plus' | 'minus' }) {
  return (
    <svg
      aria-hidden="true"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'back' ? (
        <path d="M20 12H4m7-7-7 7 7 7" />
      ) : kind === 'previous' ? (
        <path d="m15 5-7 7 7 7" />
      ) : kind === 'next' ? (
        <path d="m9 5 7 7-7 7" />
      ) : kind === 'plus' ? (
        <path d="M5 12h14M12 5v14" />
      ) : (
        <path d="M5 12h14" />
      )}
    </svg>
  );
}
export function PhotoCanvas({
  photo,
  navigation
}: {
  photo: Pick<PhotoView, 'previewUrl' | 'description' | 'originalName' | 'width' | 'height' | 'rotation'>;
  navigation: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null),
    drag = useRef<{ id: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const [size, setSize] = useState({ width: 1, height: 1 }),
    [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [dragging, setDragging] = useState(false);
  const width = Math.max(1, photo.width),
    height = Math.max(1, photo.height),
    sideways = photo.rotation % 180 !== 0;
  const fit = Math.min(
      size.width / (sideways ? height : width),
      size.height / (sideways ? width : height),
      1
    ),
    scale = fit * zoom;
  function adjust(factor: number) {
    setZoom((value) => Math.max(0.25, Math.min(16 / Math.max(fit, 0.01), value * factor)));
  }
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: box.width, height: box.height });
    });
    observer.observe(node);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((value) => Math.max(0.25, Math.min(64, value * (event.deltaY < 0 ? 1.15 : 1 / 1.15))));
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      node.removeEventListener('wheel', wheel);
    };
  }, []);
  return (
    <>
      <div
        className={`album-photo-canvas${dragging ? ' is-dragging' : ''}`}
        ref={viewport}
        tabIndex={0}
        role="group"
        aria-label="照片预览，可滚轮缩放、拖动查看；聚焦后方向键平移，加减键缩放，Home适应窗口"
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const step = event.shiftKey ? 160 : 80;
          const directions: Record<string, [number, number]> = {
            ArrowLeft: [step, 0],
            ArrowRight: [-step, 0],
            ArrowUp: [0, step],
            ArrowDown: [0, -step]
          };
          const direction = directions[event.key];
          if (direction) setPan((value) => ({ x: value.x + direction[0]!, y: value.y + direction[1]! }));
          else if (event.key === '+' || event.key === '=') adjust(1.25);
          else if (event.key === '-' || event.key === '_') adjust(1 / 1.25);
          else if (event.key === 'Home') {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          } else return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            startX: pan.x,
            startY: pan.y
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const pointer = drag.current;
          if (pointer?.id === event.pointerId)
            setPan({
              x: pointer.startX + event.clientX - pointer.x,
              y: pointer.startY + event.clientY - pointer.y
            });
        }}
        onPointerUp={(event) => {
          if (drag.current?.id === event.pointerId) {
            drag.current = null;
            setDragging(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
      >
        <Image
          unoptimized
          draggable={false}
          src={photo.previewUrl}
          alt={photo.description || photo.originalName}
          width={width}
          height={height}
          style={{
            width: width * scale,
            height: height * scale,
            left: `calc(50% + ${pan.x}px)`,
            top: `calc(50% + ${pan.y}px)`,
            transform: `translate(-50%, -50%) rotate(${photo.rotation || 0}deg)`
          }}
        />
      </div>
      <div className="album-photo-bottom">
        <p className="album-photo-filename" title={photo.originalName}>
          {photo.originalName}{' '}
          <span>
            ({width} × {height})
          </span>
        </p>
        <div className="album-photo-toolbar">
          <div className="album-photo-zoom">
            <Button
              type="text"
              aria-label="放大照片"
              onClick={() => adjust(1.25)}
              icon={<ToolIcon kind="plus" />}
            />
            <Button
              type="text"
              aria-label="缩小照片"
              onClick={() => adjust(1 / 1.25)}
              icon={<ToolIcon kind="minus" />}
            />
            <Button
              type="text"
              aria-label="按原始尺寸一比一查看"
              onClick={() => {
                setZoom(1 / Math.max(fit, 0.001));
                setPan({ x: 0, y: 0 });
              }}
            >
              1:1
            </Button>
            <Button
              type="text"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              aria-label="适应窗口"
            >
              适应
            </Button>
            <span className="album-photo-scale" aria-live="polite">
              {Math.round(scale * 100)}%
            </span>
          </div>
          {navigation}
        </div>
      </div>
    </>
  );
}
export default function PhotoPreview({
  photo: initial,
  album,
  close,
  changed,
  focusCommentId
}: {
  photo: PhotoView;
  album: AlbumView;
  close: () => void;
  changed: () => void;
  focusCommentId?: string;
}) {
  const [activeId, setActiveId] = useState(initial.id),
    [reload, setReload] = useState(0),
    [updated, setUpdated] = useState<Map<string, PhotoView>>(() => new Map());
  const [confirm, setConfirm] = useState<'remove' | 'unfeature' | null>(null),
    [moderateRemoval, setModerateRemoval] = useState(false),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [discussionLocked, setDiscussionLocked] = useState(false),
    [retryAction, setRetryAction] = useState<'feature' | 'unfeature' | 'remove' | 'like' | null>(null);
  const retryRemoval = useRef<{ intent: 'SELF' | 'MODERATE'; reason?: string } | null>(null);
  const pending = useRef(false),
    strip = useRef<HTMLDivElement>(null),
    { notify, contextHolder } = useFeedbackMessage();
  const viewer = useAlbumResource<{ items: PhotoView[] }>(
    `/api/albums/${album.id}/photos/viewer?refresh=${reload}`,
    true
  );
  const items = useMemo(() => {
    const rows = viewer.data?.items ?? [initial];
    return rows.some((item) => item.id === initial.id) ? rows : [initial, ...rows];
  }, [viewer.data, initial]);
  const base = items.find((item) => item.id === activeId) ?? initial,
    photo = updated.get(base.id) ?? base,
    index = items.findIndex((item) => item.id === photo.id);
  const locked = busy || discussionLocked || !!confirm || !!retryAction;
  function navigate(id: string) {
    if (!locked) {
      setActiveId(id);
      setError(null);
    }
  }
  useEffect(() => {
    const node = strip.current?.querySelector<HTMLButtonElement>('[aria-current="true"]');
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, viewer.data]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        locked ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (event.target instanceof Element &&
          event.target.closest('input,textarea,[contenteditable="true"],[role="menu"]'))
      )
        return;
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault();
        setActiveId(items[index - 1]!.id);
      }
      if (event.key === 'ArrowRight' && index >= 0 && index < items.length - 1) {
        event.preventDefault();
        setActiveId(items[index + 1]!.id);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [locked, index, items]);
  useEffect(() => () => stopReclamationRuns(), []);
  async function write(action: 'feature' | 'unfeature' | 'remove') {
    if (pending.current || discussionLocked) return;
    if (action === 'feature' && !photo.canFeature) {
      notify('error', photo.featureUnavailableReason ?? '这本相册未允许精选公开展示。');
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    const removal =
      action === 'remove'
        ? (retryRemoval.current ?? {
            intent: moderateRemoval ? ('MODERATE' as const) : ('SELF' as const),
            ...(moderateRemoval ? { reason } : {})
          })
        : null;
    try {
      const result = await albumPatch<ReclamationResponse>(`/api/album-photos/${photo.id}`, {
        action,
        revision: photo.revision,
        ...(action === 'unfeature' ? { reason } : action === 'remove' ? removal : {})
      });
      setRetryAction(null);
      if (
        action === 'remove' &&
        showReclamationFeedback(result, `/api/album-photos/${photo.id}`, notify, () => {
          changed();
          close();
        })
      ) {
        setConfirm(null);
        return;
      }
      changed();
      if (action === 'remove') {
        close();
        return;
      }
      const fresh = await albumRequest<PhotoView>(`/api/album-photos/${photo.id}`);
      setUpdated((current) => new Map(current).set(fresh.id, fresh));
      setReload((value) => value + 1);
      setConfirm(null);
      setReason('');
      notify('success', action === 'feature' ? '已设为精选，加入备选池' : '已取消精选，原照片仍保留在相册中');
    } catch (failure) {
      const uncertain =
        failure instanceof AccountApiError &&
        ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(failure.detail.code);
      if (action === 'remove') retryRemoval.current = uncertain ? removal : null;
      setError(errorDetail(failure));
      setRetryAction(uncertain ? action : null);
      if (failure instanceof AccountApiError && failure.detail.code === 'CONFLICT') {
        try {
          const fresh = await albumRequest<PhotoView>(`/api/album-photos/${photo.id}`);
          setUpdated((current) => new Map(current).set(fresh.id, fresh));
          setReload((value) => value + 1);
          changed();
          setConfirm(null);
          setReason('');
        } catch {
          /* The original conflict remains visible; reopening refreshes the photo. */
        }
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function like() {
    if (pending.current || discussionLocked) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await albumRequest<{ liked: boolean; likes: number }>(
        `/api/album-photos/${photo.id}/like`,
        { liked: !photo.liked }
      );
      setUpdated((current) => new Map(current).set(photo.id, { ...photo, ...result }));
      setRetryAction(null);
      changed();
    } catch (failure) {
      setError(errorDetail(failure));
      setRetryAction(
        failure instanceof AccountApiError &&
          ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(failure.detail.code)
          ? 'like'
          : null
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (error) notify('error', error);
  }, [error, notify]);
  useEffect(() => {
    if (viewer.error) notify('error', viewer.error);
  }, [viewer.error, notify]);
  const location = [photo.uploader.gameRegion, photo.uploader.gameServer].filter(Boolean).join(' · ');
  return (
    <>
      {contextHolder}
      <Modal
        open
        width="calc(100vw - 40px)"
        style={{ top: 20, maxWidth: 'none' }}
        footer={null}
        title={null}
        closable={false}
        keyboard={!locked}
        onCancel={() => {
          if (!locked) close();
        }}
        className="album-photo-overlay"
        styles={{
          mask: { backgroundColor: 'rgba(19,28,22,.72)' },
          container: { background: 'transparent', padding: 0, border: 0, borderRadius: 0, boxShadow: 'none' },
          body: { background: 'transparent', padding: 0 }
        }}
      >
        <div className="album-photo-overlay-shell">
          <div className="album-photo-viewer">
            <div className="album-photo-topbar">
              <Button type="text" onClick={close} disabled={locked} icon={<ToolIcon kind="back" />}>
                返回相册
              </Button>
              <span aria-live="polite">
                {index >= 0 ? index + 1 : 1} / {items.length}
                {viewer.loading ? ' · 读取相册中' : ''}
              </span>
            </div>
            <PhotoCanvas
              key={`${photo.id}:${photo.rotation}`}
              photo={photo}
              navigation={
                <div className="album-photo-navigation">
                  <Button
                    type="text"
                    aria-label="上一张照片"
                    disabled={locked || index <= 0}
                    onClick={() => navigate(items[index - 1]!.id)}
                    icon={<ToolIcon kind="previous" />}
                  />
                  <Button
                    type="text"
                    aria-label="下一张照片"
                    disabled={locked || index < 0 || index >= items.length - 1}
                    onClick={() => navigate(items[index + 1]!.id)}
                    icon={<ToolIcon kind="next" />}
                  />
                </div>
              }
            />
            <div className="album-photo-filmstrip" ref={strip} aria-label="整个相册的照片">
              {items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-current={item.id === photo.id}
                  aria-label={`查看 ${item.originalName}`}
                  disabled={locked}
                  onClick={() => navigate(item.id)}
                >
                  <AlbumPhotoThumbnail photo={updated.get(item.id) ?? item} />
                </button>
              ))}
              {viewer.loading && !viewer.data ? <Spin size="small" /> : null}
            </div>
          </div>
          <aside className="album-photo-discussion" aria-label="照片信息与评论">
            <header className="album-photo-author">
              <MemberAvatar member={photo.uploader} size={60} />
              <div className="album-photo-author-copy">
                <div>
                  <Link href={`/members/${photo.uploader.id}`}>{photo.uploader.displayName || '成员'}</Link>
                  {location ? (
                    <span className="album-photo-location">
                      <DailyToolbarIcon kind="server" />
                      {location}
                    </span>
                  ) : null}
                </div>
                <DailyTime value={photo.createdAt} />
              </div>
              {photo.isAdmin || photo.canRemove ? (
                <AlbumActionMenu
                  label="照片操作"
                  disabled={locked}
                  items={[
                    ...(photo.isAdmin
                      ? [
                          {
                            key: photo.featuredAt ? 'unfeature' : 'feature',
                            label: photo.featuredAt
                              ? '取消精选'
                              : photo.canFeature
                                ? '设为精选'
                                : '设为精选（相册未允许公开展示）',
                            disabled: !photo.featuredAt && !photo.canFeature
                          }
                        ]
                      : []),
                    ...(photo.canRemoveSelf ? [{ key: 'remove', label: '删除照片' }] : []),
                    ...(photo.isAdmin ? [{ key: 'moderate', label: '违规删除' }] : [])
                  ]}
                  onAction={(action) => {
                    setError(null);
                    setReason('');
                    if (action === 'feature') void write('feature');
                    else {
                      setModerateRemoval(action === 'moderate');
                      setConfirm(action === 'moderate' ? 'remove' : (action as 'unfeature' | 'remove'));
                    }
                  }}
                />
              ) : null}
            </header>
            {photo.isAdmin ? (
              <p className="album-photo-description">
                {photo.featuredAt
                  ? photo.featuredPool === 'SELECTED'
                    ? '精选状态：入选池'
                    : '精选状态：备选池'
                  : (photo.featureUnavailableReason ?? '设为精选后先进入备选池，由管理员挑选入选照片。')}
              </p>
            ) : null}
            {photo.description ? <p className="album-photo-description">{photo.description}</p> : null}
            {retryAction ? (
              <div className="album-photo-retry" role="status">
                <span>暂未确认操作结果，请重试确认。</span>
                <Button
                  loading={busy}
                  onClick={() => {
                    if (retryAction === 'like') void like();
                    else void write(retryAction);
                  }}
                >
                  重试
                </Button>
              </div>
            ) : null}
            <h3 className="album-photo-comment-heading">评论 · {photo.comments}</h3>
            <AlbumComments
              key={photo.id}
              albumId={album.id}
              photoId={photo.id}
              commentId={photo.id === initial.id ? focusCommentId : undefined}
              compact
              composerActions={
                <div className="daily-home-actions">
                  <Button
                    type="text"
                    aria-label={`${photo.liked ? '取消点赞' : '点赞'} ${photo.likes}`}
                    aria-pressed={photo.liked}
                    disabled={locked}
                    loading={busy}
                    onClick={() => void like()}
                    icon={<DailyActionIcon kind="like" active={photo.liked} />}
                  >
                    {photo.likes}
                  </Button>
                </div>
              }
              changed={() => {
                setUpdated(new Map());
                setReload((value) => value + 1);
                changed();
              }}
              onLockedChange={setDiscussionLocked}
            />
          </aside>
        </div>
      </Modal>
      <Modal
        open={!!confirm}
        zIndex={1100}
        title={confirm === 'unfeature' ? '取消精选' : moderateRemoval ? '违规删除照片' : '删除照片'}
        closable={!busy}
        mask={{ closable: !busy }}
        onCancel={() => {
          if (!busy) setConfirm(null);
        }}
        onOk={() => {
          if (confirm) void write(confirm);
        }}
        okText={confirm === 'unfeature' ? '取消精选' : '确认删除'}
        cancelText="返回"
        confirmLoading={busy}
        okButtonProps={{
          danger: true,
          className: 'album-danger',
          disabled: (confirm === 'unfeature' || moderateRemoval) && !reason.trim()
        }}
        className="album-modal album-confirm-modal"
      >
        <div className="album-form">
          <p>
            {confirm === 'unfeature'
              ? '取消后，这张照片将退出备选池、入选池及游客首页，原照片仍保留在相册中。'
              : '确认删除这张照片？新照片的原图和缩略图将永久删除，无法恢复；仍被其他内容使用的文件会保留。'}
          </p>
          {confirm === 'unfeature' || moderateRemoval ? (
            <label>
              操作原因
              <Input.TextArea
                autoComplete="off"
                value={reason}
                disabled={busy || !!retryAction}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
              />
            </label>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
