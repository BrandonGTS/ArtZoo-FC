'use client';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { Upload } from 'antd';
import type { UploadProps } from 'antd';
type RcFile = Parameters<NonNullable<UploadProps['beforeUpload']>>[0];
import { useFeedbackMessage } from '../use-feedback-message';
import { useUserOperation } from '../user-operation-provider';
import { isLotteryPrizeImageUrl } from '../../server/lottery/contract';

export default function LotteryPrizeUpload({
  value,
  onChange,
  disabled = false,
  onBusyChange
}: {
  value?: string;
  onChange?(value: string): void;
  disabled?: boolean;
  onBusyChange?(busy: boolean): void;
}) {
  const [busy, setBusy] = useState(false),
    pending = useRef(false),
    active = useRef<AbortController | null>(null),
    { notify, contextHolder } = useFeedbackMessage(),
    { run } = useUserOperation();
  useEffect(() => () => active.current?.abort(), []);
  async function upload(file: RcFile, files: RcFile[]) {
    if (pending.current || disabled) return Upload.LIST_IGNORE;
    if (files.length !== 1) {
      if (file.uid === files[0]?.uid) notify('error', '每项奖品请选择一张图片');
      return Upload.LIST_IGNORE;
    }
    if (file.size > 30 * 1024 * 1024 || !file.size) {
      notify('error', '每张图片最多30MiB');
      return Upload.LIST_IGNORE;
    }
    if (!/\.(jpg|jpeg|png|webp|bmp|gif|tif|tiff|avif|mpo)$/i.test(file.name)) {
      notify('error', '请选择支持的图片格式');
      return Upload.LIST_IGNORE;
    }
    pending.current = true;
    setBusy(true);
    onBusyChange?.(true);
    const controller = new AbortController();
    active.current = controller;
    try {
      await run(
        async () => {
          const body = new FormData();
          body.set('file', file);
          body.set('batchId', crypto.randomUUID());
          body.set('batchIndex', '0');
          const response = await fetch('/api/lotteries/upload', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'X-ArtZoo-Request': '1' },
            body,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)])
          });
          const result = await response.json();
          if (!response.ok || !result.ok || !isLotteryPrizeImageUrl(result.data?.imageUrl))
            throw new Error(result.error?.message || '奖品图片上传失败');
          if (!controller.signal.aborted) onChange?.(result.data.imageUrl);
        },
        { signal: controller.signal }
      );
    } catch (error) {
      if (!controller.signal.aborted)
        notify('error', error instanceof Error ? error.message : '图片上传失败，请重试');
    } finally {
      pending.current = false;
      active.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
        onBusyChange?.(false);
      }
    }
    return Upload.LIST_IGNORE;
  }
  return (
    <>
      {contextHolder}
      <Upload.Dragger
        className="lottery-prize-upload"
        accept=".jpg,.jpeg,.png,.webp,.bmp,.gif,.tif,.tiff,.avif,.mpo"
        multiple={false}
        showUploadList={false}
        beforeUpload={upload}
        disabled={disabled || busy}
      >
        <span
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            padding: 0,
            overflow: 'hidden',
            clipPath: 'inset(50%)',
            whiteSpace: 'nowrap',
            border: 0
          }}
        >
          上传奖品图片（可选）
        </span>
        {busy ? (
          <span role="status">上传中</span>
        ) : isLotteryPrizeImageUrl(value) ? (
          <Image src={value} width={64} height={64} alt="" unoptimized />
        ) : (
          <span aria-hidden="true">＋</span>
        )}
      </Upload.Dragger>
    </>
  );
}
