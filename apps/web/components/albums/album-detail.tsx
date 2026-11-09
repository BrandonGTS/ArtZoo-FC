'use client';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useUserRouter as useRouter } from '../user-operation-provider';
import { Button, Checkbox, Empty, Select, Spin, Tag } from 'antd';
import type { AlbumView, PhotoView } from '../../server/albums/contract';
import { ALBUM_VISIBILITY_LABELS } from '../../content/album-publicity';
import { primaryLabels } from '../../server/albums/contract';
import Modal from '../ui/paper-modal';
import { ActivityPaper } from '../activities/activity-ui';
import { AccountApiError } from '../account/api';
import { useAuthSession } from '../auth-session';
import { PageHeading } from '../home-content';
import { ListPagination } from '../collection-controls';
import { useFeedbackMessage } from '../use-feedback-message';
import AlbumEditor from './album-editor';
import AlbumPhotoEditPanel from './album-photo-edit-panel';
import AlbumPhotoMoveModal from './album-photo-move-modal';
import AlbumRemoveModal from './album-remove-modal';
import AlbumUpload from './album-upload';
import AlbumComments from './album-comments';
import PhotoPreview, { AlbumActionMenu, AlbumPhotoThumbnail } from './photo-preview';
import {
  showReclamationFeedback,
  stopReclamationRuns,
  type ReclamationResponse
} from './reclamation-feedback';
import { albumPatch, errorDetail } from './api';
import { useAlbumResource } from './use-album-resource';
import './albums.css';
import './album-detail-qc.css';

type PhotoPage = { items: PhotoView[]; page: number; total: number; totalPages: number };
type PhotoCommand =
  | {
      action: 'rotate';
      photoId: string;
      direction: 'left' | 'right';
      revision: number;
      submissionKey: string;
    }
  | {
      action: 'remove';
      intent: 'SELF' | 'MODERATE';
      reason?: string;
      photos: { id: string; revision: number }[];
      submissionKey: string;
    }
  | { action: 'cover'; photoId: string; revision: number; albumRevision: number; submissionKey: string }
  | { action: 'move'; photoId: string; targetAlbumId: string; revision: number; submissionKey: string };
function uncertain(failure: unknown) {
  return (
    failure instanceof AccountApiError &&
    ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(failure.detail.code)
  );
}
function FactIcon({ kind }: { kind: 'type' | 'photos' | 'visibility' | 'upload' | 'creator' }) {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'type' ? (
        <>
          <path d="M4 4h16v16H4zM4 9h16M9 9v11" />
        </>
      ) : null}
      {kind === 'photos' ? (
        <>
          <path d="M4 4h16v16H4zM4 16l5-5 5 5 3-3 3 3" />
          <circle cx="16" cy="8" r="1.5" />
        </>
      ) : null}
      {kind === 'visibility' ? (
        <>
          <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : null}
      {kind === 'creator' ? (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
        </>
      ) : null}
      {kind === 'upload' ? (
        <>
          <path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" />
        </>
      ) : null}
    </svg>
  );
}
export default function AlbumDetail({
  id,
  initialPeriod,
  initialPhoto,
  initialComments,
  initialCommentId
}: {
  id: string;
  initialPeriod?: string;
  initialPhoto?: string;
  initialComments?: boolean;
  initialCommentId?: string;
}) {
  const { session } = useAuthSession();
  return session?.user ? (
    <DetailContent
      key={[
        session.user.id,
        id,
        initialPeriod ?? '',
        initialPhoto ?? '',
        initialComments ? 'comments' : '',
        initialCommentId ?? ''
      ].join(':')}
      id={id}
      initialPeriod={initialPeriod}
      initialPhoto={initialPhoto}
      initialComments={initialComments}
      initialCommentId={initialCommentId}
    />
  ) : (
    <main className="home-content">
      <PageHeading level={1} decoration="burger">
        相册
      </PageHeading>
    </main>
  );
}
function DetailContent({
  id,
  initialPeriod,
  initialPhoto,
  initialComments,
  initialCommentId
}: {
  id: string;
  initialPeriod?: string;
  initialPhoto?: string;
  initialComments?: boolean;
  initialCommentId?: string;
}) {
  const router = useRouter(),
    { notify, contextHolder } = useFeedbackMessage();
  const [reload, setReload] = useState(0),
    [period, setPeriod] = useState(initialPeriod),
    [page, setPage] = useState(1);
  const [editor, setEditor] = useState(false),
    [upload, setUpload] = useState(false),
    [comments, setComments] = useState(!!initialComments);
  const [photo, setPhoto] = useState<PhotoView | null>(null),
    [requestedPhotoOpen, setRequestedPhotoOpen] = useState(!!initialPhoto);
  const [bulk, setBulk] = useState(false),
    [selected, setSelected] = useState<Map<string, PhotoView>>(() => new Map());
  const [remove, setRemove] = useState<'album' | 'photos' | null>(null),
    [moderateRemoval, setModerateRemoval] = useState(false),
    [removeReason, setRemoveReason] = useState('');
  const [editingPhoto, setEditingPhoto] = useState<PhotoView | null>(null),
    [description, setDescription] = useState(''),
    [photoPeriod, setPhotoPeriod] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [retryCommand, setRetryCommand] = useState<PhotoCommand | null>(null);
  const [movingPhoto, setMovingPhoto] = useState<PhotoView | null>(null),
    [moveTarget, setMoveTarget] = useState<string>();
  const pending = useRef(false);
  const albumResource = useAlbumResource<AlbumView>(`/api/albums/${id}?refresh=${reload}`, true);
  const query = new URLSearchParams({
    page: String(page),
    refresh: String(reload),
    ...(period ? { periodActivityId: period } : {})
  });
  const photos = useAlbumResource<PhotoPage>(`/api/albums/${id}/photos?${query}`);
  const moveTargets = useAlbumResource<{ items: AlbumView[] }>(
    movingPhoto ? `/api/albums/${id}/move-targets?photoId=${movingPhoto.id}&refresh=${reload}` : null
  );
  const requestedPhoto = useAlbumResource<PhotoView>(
    requestedPhotoOpen && initialPhoto ? `/api/album-photos/${initialPhoto}` : null
  );
  const activePhoto =
    photo ?? (requestedPhotoOpen && requestedPhoto.data?.albumId === id ? requestedPhoto.data : null);
  const album = albumResource.data;
  useEffect(() => () => stopReclamationRuns(), [id]);
  const resourceError = requestedPhoto.error ?? photos.error ?? albumResource.error ?? moveTargets.error;
  useEffect(() => {
    if (resourceError) notify('error', resourceError);
  }, [resourceError, notify]);
  useEffect(() => {
    if (error) notify('error', error);
  }, [error, notify]);
  if (photos.data && page > photos.data.totalPages) setPage(Math.max(1, photos.data.totalPages));
  function changed() {
    setReload((value) => value + 1);
  }
  useEffect(() => {
    if (album || !albumResource.error) return;
    const controller = new AbortController();
    let active = true;
    const dismissals: (() => void)[] = [];
    const recoveryNotify: typeof notify = (kind, text, action) => {
      if (!active) return () => {};
      const dismiss = notify(
        kind,
        text,
        action ? { ...action, onClick: () => active && action.onClick() } : undefined
      );
      dismissals.push(dismiss);
      return dismiss;
    };
    void (async () => {
      const seen = new Set<string>();
      let cursor: string | undefined;
      // Follow only this album's read-only status pages, never a deletion or a background poll.
      for (let page = 0; page < 100 && active; page++) {
        const result = await albumPatch<ReclamationResponse>(
          `/api/albums/${id}`,
          { action: 'storage-removal-status', ...(cursor ? { cursor } : {}) },
          { signal: controller.signal }
        );
        if (!active) return;
        const state = result.storageReclamation;
        if (state?.status !== 'pending' && state?.status !== 'retained') return;
        if (state.targets.length) {
          if (
            state.targets.every((photoId) =>
              state.authorizations?.some((a) => a.photoId === photoId && a.auditId)
            )
          )
            showReclamationFeedback(result, `/api/albums/${id}`, recoveryNotify, () =>
              setReload((value) => value + 1)
            );
          return;
        }
        const next = state.recovery?.nextCursor;
        if (!next || seen.has(next)) return;
        seen.add(next);
        cursor = next;
      }
    })().catch(() => {
      // A failed status read is not evidence of an unfinished deletion.
    });
    return () => {
      active = false;
      controller.abort();
      dismissals.forEach((dismiss) => dismiss());
    };
  }, [album, albumResource.error, id, notify]);

  function clearBulk() {
    setBulk(false);
    setSelected(new Map());
  }
  function toggle(item: PhotoView) {
    if (!item.canRemove || busy || retryCommand) return;
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  }
  function startRemove(items?: PhotoView[], moderate = false) {
    setError(null);
    setModerateRemoval(moderate);
    setRemoveReason('');
    if (items) setSelected(new Map(items.map((item) => [item.id, item])));
    setRemove('photos');
  }
  async function command(body: PhotoCommand) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await albumPatch<ReclamationResponse>(`/api/albums/${id}/photos`, body);
      setRetryCommand(null);
      if (
        body.action === 'remove' &&
        showReclamationFeedback(result, `/api/albums/${id}/photos`, notify, () => {
          setRemove(null);
          setSelected(new Map());
          changed();
          notify('success', '照片删除请求已处理');
        })
      ) {
        setRemove(null);
        return;
      }
      if (body.action === 'remove') {
        setRemove(null);
        setSelected(new Map());
        notify('success', `已删除 ${body.photos.length} 张照片`);
      } else if (body.action === 'move') {
        setMovingPhoto(null);
        setMoveTarget(undefined);
        notify('success', '照片已移动到目标相册');
      } else notify('success', body.action === 'cover' ? '相册封面已更新' : '照片已旋转');
      changed();
    } catch (failure) {
      setError(errorDetail(failure));
      setRetryCommand(uncertain(failure) ? body : null);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function removeAlbum() {
    if (!album || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await albumPatch<ReclamationResponse>(`/api/albums/${id}`, {
        action: 'remove',
        revision: album.revision,
        intent: moderateRemoval ? 'MODERATE' : 'SELF',
        ...(moderateRemoval ? { reason: removeReason } : {})
      });
      if (showReclamationFeedback(result, `/api/albums/${id}`, notify, () => router.push('/albums'))) {
        setRemove(null);
        return;
      }
      router.push('/albums');
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function savePhoto() {
    if (!editingPhoto || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await albumPatch(`/api/album-photos/${editingPhoto.id}`, {
        action: 'edit',
        revision: editingPhoto.revision,
        description,
        periodActivityId: photoPeriod
      });
      setEditingPhoto(null);
      changed();
      notify('success', '照片已保存');
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function photoAction(item: PhotoView, action: string) {
    if (busy || retryCommand) return;
    if (action === 'left' || action === 'right')
      void command({
        action: 'rotate',
        photoId: item.id,
        direction: action,
        revision: item.revision,
        submissionKey: crypto.randomUUID()
      });
    if (action === 'edit') {
      setEditingPhoto(item);
      setDescription(item.description);
      setPhotoPeriod(item.periodActivityId);
      setError(null);
    }
    if (action === 'remove' || action === 'moderate') startRemove([item], action === 'moderate');
    if (action === 'cover' && album && item.canSetCover)
      void command({
        action: 'cover',
        photoId: item.id,
        revision: item.revision,
        albumRevision: album.revision,
        submissionKey: crypto.randomUUID()
      });
    if (action === 'move' && item.canMove) {
      setMovingPhoto(item);
      setMoveTarget(undefined);
      setError(null);
    }
  }
  if (!album)
    return (
      <main className="home-content">
        <PageHeading level={1} decoration="burger">
          相册
        </PageHeading>
        {albumResource.error ? <p>相册暂时无法读取，请刷新重试。</p> : <Spin />}
        {contextHolder}
      </main>
    );
  const uploadPeriod = period,
    canUpload =
      album.canUpload &&
      (!uploadPeriod || album.periods.some((item) => item.id === uploadPeriod && item.canUpload));
  const uploadLabel = album.uploadsClosed
    ? '已停止接收新照片'
    : album.uploadMode === 'ACTIVITY'
      ? '有效报名参与者上传'
      : album.uploadMode === 'AUTHOR'
        ? '仅创建者上传'
        : '成员与朋友共同上传';
  const locked = busy || !!retryCommand;
  return (
    <main className="home-content albums-content album-detail-qc" id="main-content">
      {contextHolder}
      <header className="album-detail-heading">
        <div className="album-detail-title">
          <PageHeading level={1} decoration="burger">
            {album.name}
          </PageHeading>
          {bulk ? (
            <Tag color="#a34335" variant="solid">
              批量操作模式
            </Tag>
          ) : null}
        </div>
        <Link className="album-text-link" href="/albums">
          返回相册列表
        </Link>
      </header>
      <section aria-label="相册信息">
        <ActivityPaper className="album-detail-information">
          <div className="album-detail-cover">
            {album.cover ? (
              <Image
                unoptimized
                src={album.cover}
                alt={`${album.name}封面`}
                width={480}
                height={300}
                style={{
                  transform: `rotate(${album.coverRotation || 0}deg)`,
                  ...(album.coverRotation % 180 !== 0
                    ? { width: '57.142857%', height: '175%', flexShrink: 0 }
                    : {})
                }}
              />
            ) : (
              <FactIcon kind="photos" />
            )}
          </div>
          <div className="album-detail-facts">
            <div>
              <FactIcon kind="type" />
              <span>相册类型</span>
              <strong>
                {primaryLabels[album.primary]}
                {album.category ? ` / ${album.category.label}` : ''}
              </strong>
            </div>
            <div>
              <FactIcon kind="photos" />
              <span>照片数量</span>
              <strong>{album.photoCount} 张</strong>
            </div>
            <div>
              <FactIcon kind="creator" />
              <span>创建用户</span>
              <strong>
                <Link href={`/members/${album.creator.id}`}>{album.creator.displayName ?? '成员'}</Link>
              </strong>
            </div>
            <div>
              <FactIcon kind="visibility" />
              <span>可见范围</span>
              <Tag color={album.visibility === 'PUBLIC' ? '#436B4E' : '#a34335'} variant="solid">
                {ALBUM_VISIBILITY_LABELS[album.visibility]}
              </Tag>
            </div>
            <div>
              <FactIcon kind="upload" />
              <span>上传权限</span>
              <Tag
                color={album.uploadMode === 'AUTHOR' || album.uploadsClosed ? '#a34335' : '#436b4e'}
                variant="solid"
              >
                {uploadLabel}
              </Tag>
            </div>
          </div>
          {album.canManage || album.canDelete || photos.data?.items.some((item) => item.canRemove) ? (
            <div className="album-detail-menu">
              <AlbumActionMenu
                label="相册管理操作"
                disabled={locked}
                items={[
                  ...(album.canManage ? [{ key: 'edit', label: '修改相册' }] : []),
                  { key: 'bulk', label: '批量操作' },
                  ...(album.canDeleteSelf ? [{ key: 'remove', label: '删除相册' }] : []),
                  ...(album.isAdmin ? [{ key: 'moderate', label: '违规删除' }] : [])
                ]}
                onAction={(action) => {
                  setError(null);
                  if (action === 'edit') setEditor(true);
                  if (action === 'remove' || action === 'moderate') {
                    setModerateRemoval(action === 'moderate');
                    setRemoveReason('');
                    setRemove('album');
                  }
                  if (action === 'bulk') {
                    setSelected(new Map());
                    setBulk(true);
                  }
                }}
              />
            </div>
          ) : null}
        </ActivityPaper>
      </section>
      {album.periods.length ? (
        <div className="album-detail-period">
          <label htmlFor="album-period">期次</label>
          <Select
            id="album-period"
            value={period ?? ''}
            disabled={locked}
            onChange={(value) => {
              setPeriod(value || undefined);
              setPage(1);
            }}
            options={[
              { value: '', label: '全部期次' },
              ...album.periods.map((item) => ({
                value: item.id,
                label: item.periodNumber ? `第${item.periodNumber}期` : item.title
              }))
            ]}
          />
        </div>
      ) : null}
      {bulk ? (
        <div className="album-detail-bulk-actions">
          <Button
            danger
            type="primary"
            disabled={!selected.size || locked || [...selected.values()].some((item) => !item.canRemoveSelf)}
            onClick={() => startRemove()}
          >
            批量删除
          </Button>
          {album.isAdmin ? (
            <Button danger disabled={!selected.size || locked} onClick={() => startRemove(undefined, true)}>
              违规删除
            </Button>
          ) : null}
          <Button type="primary" disabled={locked} onClick={clearBulk}>
            退出批量操作
          </Button>
        </div>
      ) : null}
      {retryCommand && !remove && !movingPhoto ? (
        <div role="alert" className="album-detail-retry">
          <span>
            暂未确认{retryCommand.action === 'cover' ? '设置封面' : '旋转'}结果，请重试确认后再操作。
          </span>
          <Button loading={busy} onClick={() => void command(retryCommand)}>
            重试
          </Button>
        </div>
      ) : null}
      <div className="album-detail-wall" aria-label="相册照片" aria-busy={photos.loading}>
        <button
          type="button"
          className="album-detail-upload"
          onClick={() =>
            canUpload
              ? setUpload(true)
              : notify(
                  'warning',
                  album.uploadsClosed
                    ? '这本相册已停止接收新照片。'
                    : album.uploadMode === 'AUTHOR'
                      ? '这本相册仅创建者可以上传照片。'
                      : album.uploadMode === 'ACTIVITY'
                        ? '仅有效报名参与者可向对应期次上传照片。'
                        : '当前账号没有向这本相册上传照片的权限。'
                )
          }
          disabled={locked}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M13 20H3V4h18v9M3 16l5-5 5 5 3-3M19 16v6m-3-3h6" />
            <circle cx="16" cy="8" r="2" />
          </svg>
          <span>上传照片</span>
        </button>
        {photos.data?.items.map((item) => (
          <article
            key={item.id}
            className={`album-detail-photo${selected.has(item.id) && bulk ? ' is-selected' : ''}`}
          >
            <button
              type="button"
              className="album-detail-photo-open"
              aria-label={
                bulk
                  ? `${selected.has(item.id) ? '取消选择' : '选择'} ${item.originalName}`
                  : `查看 ${item.originalName}`
              }
              aria-pressed={bulk ? selected.has(item.id) : undefined}
              disabled={locked || (bulk && !item.canRemove)}
              onClick={() => (bulk ? toggle(item) : setPhoto(item))}
            >
              <AlbumPhotoThumbnail photo={item} />
            </button>
            {bulk ? (
              <div className="album-detail-checkbox" onClick={(event) => event.stopPropagation()}>
                <Checkbox
                  aria-label={`选择 ${item.originalName}`}
                  checked={selected.has(item.id)}
                  disabled={!item.canRemove || locked}
                  onChange={() => toggle(item)}
                />
              </div>
            ) : item.canEdit || item.canRemove || item.canSetCover || item.canMove ? (
              <div className="album-detail-photo-menu">
                <AlbumActionMenu
                  label={`${item.originalName}的管理操作`}
                  disabled={locked}
                  items={[
                    ...(item.canEdit
                      ? [
                          { key: 'edit', label: '编辑照片' },
                          { key: 'left', label: '向左旋转 90°' },
                          { key: 'right', label: '向右旋转 90°' }
                        ]
                      : []),
                    ...(item.canSetCover ? [{ key: 'cover', label: '设为封面' }] : []),
                    ...(item.canMove ? [{ key: 'move', label: '移动到其他相册' }] : []),
                    ...(item.canRemoveSelf ? [{ key: 'remove', label: '删除照片' }] : []),
                    ...(item.isAdmin ? [{ key: 'moderate', label: '违规删除' }] : [])
                  ]}
                  onAction={(action) => photoAction(item, action)}
                />
              </div>
            ) : null}
          </article>
        ))}
      </div>
      {photos.loading ? (
        <div className="album-detail-loading">
          <Spin />
        </div>
      ) : photos.data && !photos.data.items.length && !photos.error ? (
        <Empty description="暂无照片，上传第一张照片吧" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : null}
      <ListPagination
        page={page}
        totalPages={photos.data?.totalPages ?? 1}
        loading={photos.loading || locked}
        onPageChange={setPage}
        label="相册照片分页"
      />
      {editor ? (
        <AlbumEditor
          album={album}
          close={() => setEditor(false)}
          saved={() => {
            setEditor(false);
            changed();
            notify('success', '相册已保存');
          }}
        />
      ) : null}
      <AlbumUpload
        key={album.id + ':' + (uploadPeriod ?? '')}
        album={album}
        initialPeriod={uploadPeriod}
        open={upload && canUpload}
        close={() => setUpload(false)}
        changed={() => {
          setPage(1);
          changed();
        }}
      />
      {activePhoto ? (
        <PhotoPreview
          key={activePhoto.id}
          photo={activePhoto}
          album={album}
          focusCommentId={activePhoto.id === initialPhoto ? initialCommentId : undefined}
          close={() => {
            setPhoto(null);
            setRequestedPhotoOpen(false);
            if (initialPhoto)
              router.replace(`/albums/${id}${initialPeriod ? '?periodActivityId=' + initialPeriod : ''}`, {
                scroll: false
              });
          }}
          changed={changed}
        />
      ) : null}
      <Modal
        open={comments}
        title="相册评论"
        footer={null}
        onCancel={() => {
          setComments(false);
          if (initialComments)
            router.replace(`/albums/${id}${initialPeriod ? '?periodActivityId=' + initialPeriod : ''}`, {
              scroll: false
            });
        }}
        className="album-modal"
      >
        {comments ? <AlbumComments albumId={id} commentId={initialCommentId} changed={changed} /> : null}
      </Modal>
      <AlbumRemoveModal
        remove={remove}
        moderateRemoval={moderateRemoval}
        removeReason={removeReason}
        selectedCount={selected.size}
        retrying={!!retryCommand}
        busy={busy}
        locked={locked}
        onCancel={() => {
          if (!locked) setRemove(null);
        }}
        onOk={() => {
          if (remove === 'album') void removeAlbum();
          else
            void command(
              retryCommand ?? {
                action: 'remove',
                intent: moderateRemoval ? 'MODERATE' : 'SELF',
                ...(moderateRemoval ? { reason: removeReason } : {}),
                photos: [...selected.values()].map((item) => ({ id: item.id, revision: item.revision })),
                submissionKey: crypto.randomUUID()
              }
            );
        }}
        setRemoveReason={setRemoveReason}
      />
      <AlbumPhotoMoveModal
        movingPhoto={movingPhoto}
        moveTarget={moveTarget}
        moveTargets={moveTargets}
        retrying={retryCommand?.action === 'move'}
        busy={busy}
        locked={locked}
        onCancel={() => {
          if (!locked) {
            setMovingPhoto(null);
            setMoveTarget(undefined);
            setError(null);
          }
        }}
        onOk={() => {
          if (retryCommand?.action === 'move') void command(retryCommand);
          else if (
            movingPhoto &&
            moveTarget &&
            moveTargets.data?.items.some((target) => target.id === moveTarget)
          )
            void command({
              action: 'move',
              photoId: movingPhoto.id,
              targetAlbumId: moveTarget,
              revision: movingPhoto.revision,
              submissionKey: crypto.randomUUID()
            });
        }}
        setMoveTarget={setMoveTarget}
      />
      <AlbumPhotoEditPanel
        open={!!editingPhoto}
        busy={busy}
        description={description}
        photoPeriod={photoPeriod}
        periods={album.periods}
        onCancel={() => {
          if (!busy) setEditingPhoto(null);
        }}
        onOk={() => void savePhoto()}
        setDescription={setDescription}
        setPhotoPeriod={setPhotoPeriod}
      />
    </main>
  );
}
