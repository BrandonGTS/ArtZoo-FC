'use client';
import { useRef, useState } from 'react';
import { ACTIVITY_ALBUM_NAME_LIMIT } from '@artzoo/domain';
import { Button, Input, Radio, Select, Switch } from 'antd';
import type { AlbumView, Category, Primary, UploadMode } from '../../server/albums/contract';
import {
  ALBUM_VISIBILITY_LABELS,
  PUBLIC_FEATURED_UPLOAD_NOTICE,
  type AlbumVisibility
} from '../../content/album-publicity';
import { primaryLabels } from '../../server/albums/contract';
import Modal from './album-modal';
import { useFeedbackMessage } from '../use-feedback-message';
import { albumPatch, albumRequest, errorDetail } from './api';
export default function AlbumEditor({
  album,
  close,
  saved,
  activity
}: {
  album?: AlbumView;
  categories?: Category[];
  close: () => void;
  saved: (id: string) => void;
  activity?: { id: string; primary: Primary };
}) {
  const [name, setName] = useState(album?.name ?? ''),
    [description, setDescription] = useState(album?.description ?? ''),
    [primary, setPrimary] = useState<Primary>(album?.primary ?? activity?.primary ?? 'GAME'),
    [uploadMode, setUploadMode] = useState<UploadMode>(album?.uploadMode ?? 'AUTHOR'),
    [closed, setClosed] = useState(album?.uploadsClosed ?? false);
  const [visibility, setVisibility] = useState<AlbumVisibility>(album?.visibility ?? 'MEMBERS');
  const [busy, setBusy] = useState(false),
    pending = useRef(false),
    { notify, contextHolder } = useFeedbackMessage();
  async function save() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const body = {
        name,
        description,
        primary,
        uploadMode,
        uploadsClosed: closed,
        visibility,
        ...(album ? { revision: album.revision } : {}),
        ...(activity ? { activityId: activity.id } : {})
      };
      const result = album
        ? await albumPatch<{ id?: string }>(`/api/albums/${album.id}`, body)
        : await albumRequest<{ id: string }>('/api/albums', body);
      saved(album?.id ?? result.id!);
    } catch (e) {
      notify('error', errorDetail(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={album ? '修改相册' : '创建相册'}
      width={592}
      footer={null}
      onCancel={() => {
        if (!pending.current) close();
      }}
      mask={{ closable: !busy }}
      className="album-modal album-editor-modal"
    >
      {contextHolder}
      <div className="album-form">
        <label className="album-name-field">
          相册名称
          <Input
            autoComplete="off"
            value={name}
            maxLength={album?.activityId || album?.seriesId ? ACTIVITY_ALBUM_NAME_LIMIT : 100}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          一级分类
          <Select
            value={primary}
            disabled={!!activity || !!album?.activityId}
            options={Object.entries(primaryLabels).map(([value, label]) => ({ value, label }))}
            onChange={setPrimary}
          />
        </label>
        {album ? (
          <label>
            相册说明
            <Input.TextArea
              autoComplete="off"
              value={description}
              maxLength={2000}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        ) : null}
        {!activity && !album?.activityId ? (
          <div>
            <div>上传权限</div>
            <Radio.Group
              className="album-upload-modes"
              orientation="vertical"
              value={uploadMode}
              onChange={(e) => setUploadMode(e.target.value)}
              options={[
                { value: 'AUTHOR', label: '仅创建者上传' },
                { value: 'COMMUNITY', label: '成员与朋友共同上传' }
              ]}
            />
          </div>
        ) : null}
        <div>
          <div id="album-visibility-label">可见范围</div>
          <Radio.Group
            aria-labelledby="album-visibility-label"
            className="album-upload-modes"
            orientation="vertical"
            value={visibility}
            disabled={busy || (!!album && !album.canManage)}
            onChange={(event) => setVisibility(event.target.value)}
            options={Object.entries(ALBUM_VISIBILITY_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <p className="album-upload-notice">
            {visibility === 'PUBLIC'
              ? PUBLIC_FEATURED_UPLOAD_NOTICE.replace('本站无法阻止访客保存，也无法追回已保存的副本。', '')
              : '相册照片仅供站内查看，不能设为公开精选。'}
          </p>
        </div>
        {album ? (
          <label className="album-switch">
            停止接收新照片
            <Switch checked={closed} onChange={setClosed} />
          </label>
        ) : null}
        <div className="album-actions">
          <Button onClick={close} disabled={busy}>
            取消
          </Button>
          <Button type="primary" loading={busy} onClick={() => void save()}>
            {album ? '保存' : '创建相册'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
