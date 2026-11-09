'use client';
import { Input, Select } from 'antd';
import type { AlbumView } from '../../server/albums/contract';
import Modal from './album-modal';

type Props = {
  open: boolean;
  busy: boolean;
  description: string;
  photoPeriod: string | null;
  periods: AlbumView['periods'];
  onCancel: () => void;
  onOk: () => void;
  setDescription: (value: string) => void;
  setPhotoPeriod: (value: string | null) => void;
};

export default function AlbumPhotoEditPanel({
  open,
  busy,
  description,
  photoPeriod,
  periods,
  onCancel,
  onOk,
  setDescription,
  setPhotoPeriod
}: Props) {
  return (
    <Modal
      open={open}
      title="编辑照片"
      onCancel={onCancel}
      onOk={onOk}
      confirmLoading={busy}
      okText="保存"
      cancelText="取消"
      className="album-modal"
    >
      <div className="album-form">
        <label>
          照片说明
          <Input.TextArea
            autoComplete="off"
            rows={3}
            value={description}
            disabled={busy}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={2000}
          />
        </label>
        {periods.length ? (
          <label>
            期次（可选）
            <Select
              value={photoPeriod}
              disabled={busy}
              onChange={setPhotoPeriod}
              options={[
                { value: null, label: '未标期次' },
                ...periods.map((item) => ({
                  value: item.id,
                  label: item.periodNumber ? `第${item.periodNumber}期` : item.title
                }))
              ]}
            />
          </label>
        ) : null}
      </div>
    </Modal>
  );
}
