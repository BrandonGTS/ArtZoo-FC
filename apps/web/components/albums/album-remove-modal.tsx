'use client';
import { Input } from 'antd';
import Modal from '../ui/paper-modal';

type Props = {
  remove: 'album' | 'photos' | null;
  moderateRemoval: boolean;
  removeReason: string;
  selectedCount: number;
  retrying: boolean;
  busy: boolean;
  locked: boolean;
  onCancel: () => void;
  onOk: () => void;
  setRemoveReason: (value: string) => void;
};

export default function AlbumRemoveModal({
  remove,
  moderateRemoval,
  removeReason,
  selectedCount,
  retrying,
  busy,
  locked,
  onCancel,
  onOk,
  setRemoveReason
}: Props) {
  return (
    <Modal
      open={!!remove}
      title={moderateRemoval ? '违规删除' : remove === 'album' ? '删除相册' : '删除照片'}
      closable={!locked}
      mask={{ closable: !locked }}
      onCancel={onCancel}
      onOk={onOk}
      confirmLoading={busy}
      okText={retrying ? '重试删除' : '确认删除'}
      cancelText="取消"
      cancelButtonProps={{ disabled: locked }}
      okButtonProps={{
        danger: true,
        className: 'album-danger',
        disabled:
          !retrying && ((remove === 'photos' && !selectedCount) || (moderateRemoval && !removeReason.trim()))
      }}
      className="album-modal album-confirm-modal"
    >
      <p>
        {remove === 'album'
          ? '确认删除这本相册及其中的照片？本次新增照片的原图和缩略图将永久删除，无法恢复；仍被其他内容使用的文件会保留。'
          : `确认删除已选择的 ${selectedCount} 张照片？新照片的原图和缩略图将永久删除，无法恢复；仍被其他内容使用的文件会保留。`}
      </p>
      {moderateRemoval ? (
        <Input.TextArea
          autoComplete="off"
          aria-label="处理原因"
          placeholder="处理原因"
          value={removeReason}
          maxLength={500}
          disabled={locked}
          onChange={(event) => setRemoveReason(event.target.value)}
        />
      ) : null}
      {retrying ? <p role="alert">暂未确认删除结果，重试会使用同一请求。</p> : null}
    </Modal>
  );
}
