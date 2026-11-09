'use client';
import { Select, Spin } from 'antd';
import type { AlbumView, PhotoView } from '../../server/albums/contract';
import Modal from '../ui/paper-modal';

type Props = {
  movingPhoto: Pick<PhotoView, 'originalName'> | null;
  moveTarget: string | undefined;
  moveTargets: { loading: boolean; data: { items: Pick<AlbumView, 'id' | 'name'>[] } | undefined };
  retrying: boolean;
  busy: boolean;
  locked: boolean;
  onCancel: () => void;
  onOk: () => void;
  setMoveTarget: (value: string) => void;
};

export default function AlbumPhotoMoveModal({
  movingPhoto,
  moveTarget,
  moveTargets,
  retrying,
  busy,
  locked,
  onCancel,
  onOk,
  setMoveTarget
}: Props) {
  return (
    <Modal
      open={!!movingPhoto}
      title="移动照片"
      closable={!locked}
      mask={{ closable: !locked }}
      onCancel={onCancel}
      onOk={onOk}
      confirmLoading={busy}
      okText={retrying ? '重试移动' : '确认移动'}
      cancelText="取消"
      cancelButtonProps={{ disabled: locked }}
      okButtonProps={{
        disabled:
          !retrying &&
          (!moveTarget ||
            moveTargets.loading ||
            !moveTargets.data?.items.some((target) => target.id === moveTarget))
      }}
      className="album-modal"
    >
      <div className="album-form">
        <p className="album-detail-move-description">将“{movingPhoto?.originalName}”移动到其他相册。</p>
        <label>
          目标相册
          <Select
            aria-label="目标相册"
            placeholder={moveTargets.loading ? '正在读取可移动相册…' : '请选择目标相册'}
            value={moveTarget}
            onChange={setMoveTarget}
            disabled={locked || moveTargets.loading}
            loading={moveTargets.loading}
            options={(moveTargets.data?.items ?? []).map((target) => ({
              value: target.id,
              label: target.name
            }))}
            notFoundContent={moveTargets.loading ? <Spin size="small" /> : '没有可移动的目标相册'}
          />
        </label>
        {moveTargets.data && !moveTargets.data.items.length ? (
          <p className="album-detail-move-note">暂无你有上传权限且可接收这张照片的其他相册。</p>
        ) : null}
        {retrying ? <p role="alert">暂未确认移动结果，重试会使用同一目标和请求。</p> : null}
      </div>
    </Modal>
  );
}
