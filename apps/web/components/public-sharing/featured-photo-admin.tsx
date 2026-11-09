'use client';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { Button, Input, Tag } from 'antd';
import { ListPagination } from '../collection-controls';
import { beijingFull } from '../activities/activity-ui';
import { AlbumActionMenu, AlbumPhotoThumbnail, PhotoCanvas } from '../albums/photo-preview';
import Modal from '../albums/album-modal';
import type { AlbumVisibility, FeaturedPool } from '../../content/album-publicity';
import { useSharingCommand, useSharingResource } from './sharing-api';
import '../albums/albums.css';
import '../albums/album-detail-qc.css';
type Photo = {
  id: string;
  albumId: string;
  description: string;
  revision: number;
  previewUrl: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  rotation: number;
  originalName: string;
  album: { name: string; visibility: AlbumVisibility };
  uploader: { displayName: string | null };
  createdAt: string;
  featuredAt: string;
  featuredPool: FeaturedPool;
  featuredSelectedAt: string | null;
};
type Audit = {
  id: string;
  action: string;
  reason: string;
  createdAt: string;
  actor: { displayName: string | null };
};
type Props = {
  pool: FeaturedPool;
  query: string;
  notify(type: 'success' | 'error', text: string): void;
  onLock(value: boolean): void;
};
const auditLabels: Record<string, string> = {
  PHOTO_FEATURED: '设为精选，加入备选池',
  PHOTO_UNFEATURED: '取消精选',
  PHOTO_FEATURED_POOL_CHANGED: '调整精选池',
  PHOTO_FEATURED_SELECTED: '移入入选池',
  PHOTO_FEATURED_CANDIDATE: '移回备选池'
};
export default function FeaturedPhotoAdmin({ pool, query, notify, onLock }: Props) {
  const [reload, setReload] = useState(0),
    [page, setPage] = useState(1),
    [preview, setPreview] = useState<Photo | null>(null),
    [removing, setRemoving] = useState<Photo | null>(null),
    [reason, setReason] = useState(''),
    [auditPhoto, setAuditPhoto] = useState<Photo | null>(null);
  const command = useSharingCommand<{ saved: boolean }>({
    notify,
    success(result, request) {
      if (!result?.saved) throw new Error('Invalid response');
      const action = request.kind === 'json' ? request.body.action : null;
      setReload((value) => value + 1);
      setRemoving(null);
      setReason('');
      notify(
        'success',
        action === 'unfeature'
          ? '已取消精选，原照片仍保留在相册中'
          : pool === 'CANDIDATE'
            ? '已移入入选池'
            : '已移回备选池'
      );
      window.dispatchEvent(new Event('artzoo:featured-updated'));
    },
    failure(code) {
      if (code === 'CONFLICT' || code === 'REVISION_CONFLICT') {
        setReload((value) => value + 1);
        setRemoving(null);
        setReason('');
      }
    }
  });
  const list = useSharingResource<{ items: Photo[]; hasMore: boolean; total: number; totalPages: number }>(
    '/api/albums/featured?manage=1&pool=' +
      pool +
      '&page=' +
      page +
      '&refresh=' +
      reload +
      '&query=' +
      encodeURIComponent(query),
    'admin',
    false,
    !command.locked
  );
  const audits = useSharingResource<{ items: Audit[] }>(
    auditPhoto ? '/api/album-photos/' + auditPhoto.id + '/audit?refresh=' + reload : null,
    'admin',
    false,
    !command.locked
  );
  const locked = command.locked || !!removing || !!preview || !!auditPhoto;
  useEffect(() => {
    onLock(locked);
    return () => onLock(false);
  }, [locked, onLock]);
  useEffect(() => {
    if (list.error) notify('error', list.error);
  }, [list.error, notify]);
  useEffect(() => {
    if (audits.error) notify('error', audits.error);
  }, [audits.error, notify]);
  if (list.data && page > list.data.totalPages) setPage(Math.max(1, list.data.totalPages));
  function move(photo: Photo) {
    if (command.locked) return;
    if (photo.album.visibility !== 'PUBLIC') {
      notify('error', '仅成员可见的相册不能调整精选池。');
      return;
    }
    void command.submit({
      kind: 'json',
      method: 'PATCH',
      path: '/api/album-photos/' + photo.id,
      body: {
        action: 'featured-pool',
        pool: pool === 'CANDIDATE' ? 'SELECTED' : 'CANDIDATE',
        revision: photo.revision
      }
    });
  }
  function remove() {
    if (!removing || command.locked) return;
    if (!reason.trim()) {
      command.setError('请填写操作原因。');
      return;
    }
    void command.submit({
      kind: 'json',
      method: 'PATCH',
      path: '/api/album-photos/' + removing.id,
      body: { action: 'unfeature', revision: removing.revision, reason: reason.trim() }
    });
  }
  return (
    <section
      className="photos-manager-content"
      aria-label={pool === 'CANDIDATE' ? '备选照片' : '入选照片'}
      aria-busy={list.loading}
    >
      {list.loading ? <p role="status">正在读取照片…</p> : null}
      <div className="photos-manager-wall">
        {list.data?.items.map((photo) => (
          <article className="photos-manager-photo" key={photo.id}>
            <div className="photos-manager-image">
              <button
                type="button"
                className="photos-manager-photo-open"
                aria-label={`查看 ${photo.description || photo.originalName}`}
                disabled={command.locked}
                onClick={() => setPreview(photo)}
              >
                <AlbumPhotoThumbnail photo={photo} />
              </button>
              <div className="photos-manager-photo-menu">
                <AlbumActionMenu
                  label={`${photo.originalName}的精选操作`}
                  disabled={command.locked}
                  items={[
                    {
                      key: 'move',
                      label: pool === 'CANDIDATE' ? '移入入选池' : '移回备选池',
                      disabled: photo.album.visibility !== 'PUBLIC'
                    },
                    { key: 'unfeature', label: '取消精选' },
                    { key: 'audit', label: '操作记录' }
                  ]}
                  onAction={(action) => {
                    if (action === 'move') move(photo);
                    if (action === 'unfeature') {
                      setRemoving(photo);
                      setReason('');
                      command.setError(null);
                    }
                    if (action === 'audit') setAuditPhoto(photo);
                  }}
                />
              </div>
            </div>
            <div className="photos-manager-caption">
              <strong title={photo.description || photo.originalName}>
                {photo.description || photo.originalName}
              </strong>
              <Link
                href={'/albums/' + photo.albumId + '?photoId=' + photo.id}
                aria-disabled={command.locked || undefined}
                onClick={(event) => {
                  if (command.locked) event.preventDefault();
                }}
              >
                {photo.album.name}
              </Link>
              <span>{photo.uploader.displayName ?? '成员'}</span>
              {photo.album.visibility !== 'PUBLIC' ? (
                <Tag color="#a34335" variant="solid">
                  仅成员可见
                </Tag>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      {list.data && !list.data.items.length ? (
        <p className="photos-manager-empty">
          {query
            ? '没有符合搜索条件的照片'
            : pool === 'CANDIDATE'
              ? '暂无备选照片，可在允许精选公开展示的相册中将照片设为精选。'
              : '暂无入选照片，可从备选池挑选。'}
        </p>
      ) : null}
      <ListPagination
        page={page}
        totalPages={list.data?.totalPages ?? 1}
        loading={list.loading || locked}
        onPageChange={setPage}
        label="相册精选分页"
      />
      {command.unknown && !removing ? (
        <div className="photos-manager-retry" role="status">
          <span>暂未确认移池结果，请重试确认。</span>
          <Button type="primary" loading={command.busy} onClick={() => void command.retry()}>
            重试确认操作
          </Button>
        </div>
      ) : null}
      <Modal
        open={!!preview}
        title={preview?.description || preview?.originalName}
        footer={null}
        width={1000}
        onCancel={() => setPreview(null)}
        className="album-modal photos-manager-preview"
      >
        {preview ? (
          <>
            <div className="photos-manager-preview-canvas">
              <PhotoCanvas photo={preview} navigation={null} />
            </div>
            <p className="photos-manager-preview-meta">
              {preview.album.name} · {preview.uploader.displayName ?? '成员'} ·{' '}
              {beijingFull(preview.createdAt)}
            </p>
            <Link className="album-text-link" href={'/albums/' + preview.albumId + '?photoId=' + preview.id}>
              返回原相册查看
            </Link>
          </>
        ) : null}
      </Modal>
      <Modal
        open={!!removing}
        title="取消精选"
        closable={!command.locked}
        keyboard={!command.locked}
        mask={{ closable: !command.locked }}
        onCancel={() => {
          if (!command.locked) setRemoving(null);
        }}
        onOk={() => (command.unknown ? void command.retry() : remove())}
        okText={command.unknown ? '重试确认操作' : '取消精选'}
        cancelText="返回"
        cancelButtonProps={{ disabled: command.locked }}
        confirmLoading={command.busy}
        okButtonProps={{ danger: true, disabled: !command.unknown && !reason.trim() }}
        className="album-modal"
      >
        <div className="album-form">
          <p>取消后，这张照片将退出备选池、入选池及游客首页，原照片仍保留在相册中。</p>
          <label>
            操作原因
            <Input.TextArea
              autoComplete="off"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={500}
              disabled={command.locked}
            />
          </label>
          {command.unknown ? <p role="status">操作结果尚未确认，重试将使用同一请求。</p> : null}
        </div>
      </Modal>
      <Modal
        open={!!auditPhoto}
        title="精选操作记录"
        footer={null}
        width={760}
        onCancel={() => setAuditPhoto(null)}
        className="album-modal"
      >
        <div className="sharing-audit-scroll">
          <table>
            <thead>
              <tr>
                <th>时间 / 操作人</th>
                <th>操作</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {audits.data?.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {beijingFull(item.createdAt)} · {item.actor.displayName ?? '管理员'}
                  </td>
                  <td>{auditLabels[item.action] ?? '内容处理'}</td>
                  <td>{item.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {audits.loading ? (
            <p role="status">正在读取操作记录…</p>
          ) : audits.data && !audits.data.items.length ? (
            <p>暂无操作记录</p>
          ) : null}
        </div>
      </Modal>
    </section>
  );
}
