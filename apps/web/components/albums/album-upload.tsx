'use client';
import Image from 'next/image';
import { useRef, useState } from 'react';
import { Button, Select, Tooltip, Upload } from 'antd';
import type { UploadProps } from 'antd';
type RcFile = Parameters<NonNullable<UploadProps['beforeUpload']>>[0];
import { PUBLIC_FEATURED_UPLOAD_NOTICE } from '../../content/album-publicity';
import type { AlbumView } from '../../server/albums/contract';
import Modal from './album-modal';
import { ErrorNotice } from '../account/account-ui';
import { useFeedbackMessage } from '../use-feedback-message';
type Item = {
  file: RcFile;
  batchId: string;
  index: number;
  percent: number;
  error?: string;
  period?: string | null;
};
export default function AlbumUpload({
  album,
  initialPeriod,
  open,
  close,
  changed
}: {
  album: AlbumView;
  initialPeriod?: string;
  open: boolean;
  close: () => void;
  changed: () => void;
}) {
  const [queue, setQueue] = useState<Item[]>([]),
    [period, setPeriod] = useState<string | null>(initialPeriod ?? null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const pending = useRef(false),
    { notify, contextHolder } = useFeedbackMessage();
  function select(file: RcFile, batch: RcFile[]) {
    if (file.uid !== batch[0]?.uid) return Upload.LIST_IGNORE;
    if (pending.current) return Upload.LIST_IGNORE;
    if (queue.length + batch.length > 10) {
      setError('每批最多10张图片');
      return Upload.LIST_IGNORE;
    }
    const batchId = crypto.randomUUID();
    setError(null);
    setQueue((current) => [
      ...current,
      ...batch.map((file, index) => ({
        file,
        batchId,
        index,
        percent: 0,
        ...(file.size > 30 * 1024 * 1024 ? { error: '每张图片最多30MiB' } : {})
      }))
    ]);
    return Upload.LIST_IGNORE;
  }
  function uploadOne(item: Item, tag: string | null) {
    return new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest(),
        form = new FormData();
      form.set('file', item.file);
      form.set('batchId', item.batchId);
      form.set('batchIndex', String(item.index));
      if (tag) form.set('periodActivityId', tag);
      request.open('POST', `/api/albums/${album.id}/upload`);
      request.setRequestHeader('x-artzoo-request', '1');
      request.timeout = 120000;
      request.upload.onprogress = (event) => {
        if (event.lengthComputable)
          setQueue((current) =>
            current.map((row) =>
              row.file.uid === item.file.uid
                ? { ...row, percent: Math.min(99, Math.round((event.loaded / event.total) * 100)) }
                : row
            )
          );
      };
      request.onload = () => {
        try {
          const result = JSON.parse(request.responseText);
          if (request.status >= 200 && request.status < 300 && result.ok) resolve();
          else reject(new Error(result.error?.message || '上传失败'));
        } catch {
          reject(new Error('上传响应无效'));
        }
      };
      request.onerror = () => reject(new Error('网络连接失败，请再次上传'));
      request.ontimeout = () => reject(new Error('上传超时，请再次上传'));
      request.send(form);
    });
  }
  async function upload() {
    if (pending.current || !queue.length) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    let successes = 0;
    try {
      for (const item of queue) {
        const tag = item.period === undefined ? period : item.period;
        setQueue((current) =>
          current.map((row) =>
            row.file.uid === item.file.uid ? { ...row, error: undefined, percent: 0, period: tag } : row
          )
        );
        try {
          if (!album.canUpload || (tag && !album.periods.some((p) => p.id === tag && p.canUpload)))
            throw new Error('本期当前不允许你上传');
          if (item.file.size > 30 * 1024 * 1024) throw new Error('每张图片最多30MiB');
          await uploadOne(item, tag);
          setQueue((current) => current.filter((row) => row.file.uid !== item.file.uid));
          successes++;
        } catch (e) {
          setQueue((current) =>
            current.map((row) =>
              row.file.uid === item.file.uid
                ? { ...row, percent: 0, error: e instanceof Error ? e.message : '上传失败' }
                : row
            )
          );
        }
      }
      if (successes) {
        changed();
        notify('success', '照片上传成功');
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      {contextHolder}
      <Modal
        open={open}
        title="上传照片"
        width={832}
        footer={null}
        onCancel={() => {
          if (!pending.current) close();
        }}
        closable={!busy}
        maskClosable={!busy}
        className="album-modal album-upload-modal"
      >
        <div className="album-form">
          {album.periods.length ? (
            <label>
              期次（可选）
              <Select
                value={period}
                onChange={setPeriod}
                disabled={busy || !!initialPeriod}
                options={[
                  { value: null, label: '未标期次' },
                  ...album.periods.map((p) => ({
                    value: p.id,
                    label: p.periodNumber ? `第${p.periodNumber}期` : p.title,
                    disabled: !p.canUpload
                  }))
                ]}
              />
            </label>
          ) : null}
          {album.visibility === 'PUBLIC' ? (
            <p className="album-upload-notice" role="note">
              {PUBLIC_FEATURED_UPLOAD_NOTICE}
            </p>
          ) : null}
          <div>
            <Upload
              accept=".jpg,.jpeg,.png,.webp,.bmp,.gif,.tif,.tiff,.avif,.mpo"
              multiple
              showUploadList={false}
              beforeUpload={select}
              disabled={busy}
            >
              <Button disabled={busy}>选择图片</Button>
            </Upload>
          </div>
          {error ? <ErrorNotice message={error} /> : null}
          <div className="album-upload-queue">
            {queue.map((item) => (
              <div className="album-upload-row" key={item.file.uid}>
                <div className="album-upload-card">
                  <span className="album-upload-fill" style={{ width: `${item.percent}%` }} />
                  <span className="album-upload-file-icon">
                    <Image src="/artzoo/albums/image.svg" alt="" width={24} height={24} />
                  </span>
                  <span className="album-upload-filename">{item.file.name}</span>
                </div>
                <div className="album-upload-status">
                  {item.error ? (
                    <Tooltip title={item.error}>
                      <span className="album-upload-error" role="img" aria-label={`上传失败：${item.error}`}>
                        <Image src="/artzoo/albums/alert.svg" alt="" width={18} height={18} />
                        上传失败
                      </span>
                    </Tooltip>
                  ) : busy ? (
                    <span>{item.percent}%</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <div className="album-actions">
            <Button type="primary" loading={busy} disabled={!queue.length} onClick={() => void upload()}>
              上传
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
