'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Button, Modal, Slider, Upload } from 'antd';
import type { MemberProfile } from '@artzoo/domain';
import { ErrorNotice } from '../account/account-ui';
import { errorDetail } from '../account/api';
import { MemberAvatar } from './member-ui';
import { decodeAvatar } from './avatar-source';
import { uploadAvatar } from './avatar-api';
import { clampCrop, cropPixels, initialCrop, panCrop, wheelZoom, zoomCrop } from './avatar-crop';
import type { CropView } from './avatar-crop';
import './avatar-crop.css';

type Source = { file: File; bitmap: ImageBitmap };
export default function AvatarEditor({
  member,
  disabled,
  onBusy,
  onSaved,
  onReloadRequired,
  onSaveFeedback
}: {
  onSaveFeedback(type: 'success' | 'error', content: string): void;
  member: MemberProfile;
  disabled: boolean;
  onBusy(busy: boolean): void;
  onSaved(profile: MemberProfile): void;
  onReloadRequired(message: string): void;
}) {
  const [source, setSource] = useState<Source | null>(null);
  const [view, setView] = useState<CropView>({ zoom: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => () => source?.bitmap.close(), [source]);
  const updateView = useCallback((next: CropView) => {
    viewRef.current = next;
    setView(next);
  }, []);
  const { side } = source ? cropPixels(source.bitmap, view) : { side: 0 };
  const horizontal =
    source && source.bitmap.width > side ? (view.x / (source.bitmap.width - side)) * 100 : 50;
  const vertical =
    source && source.bitmap.height > side ? (view.y / (source.bitmap.height - side)) * 100 : 50;
  const draw = useCallback(
    (canvas: HTMLCanvasElement, current: CropView) => {
      const context = canvas.getContext('2d');
      if (!source || !context) return;
      const pixels = cropPixels(source.bitmap, current);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        source.bitmap,
        pixels.left,
        pixels.top,
        pixels.side,
        pixels.side,
        0,
        0,
        canvas.width,
        canvas.height
      );
    },
    [source]
  );
  const drawPreview = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      canvasRef.current = canvas;
      draw(canvas, viewRef.current);
      const onWheel = (event: WheelEvent) => {
        // Native non-passive listener is required: React's delegated wheel listener is passive.
        event.preventDefault();
        if (!source || lock.current) return;
        const rect = canvas.getBoundingClientRect();
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (!width || !height) return;
        const current = viewRef.current;
        updateView(
          zoomCrop(
            source.bitmap,
            current,
            wheelZoom(current.zoom, event.deltaY, event.deltaMode, height),
            (event.clientX - rect.left - canvas.clientLeft) / width,
            (event.clientY - rect.top - canvas.clientTop) / height
          )
        );
      };
      canvas.addEventListener('wheel', onWheel, { passive: false });
      return () => {
        canvas.removeEventListener('wheel', onWheel);
        drag.current = null;
        if (canvasRef.current === canvas) canvasRef.current = null;
      };
    },
    [source, draw, updateView]
  );
  useEffect(() => {
    if (canvasRef.current) draw(canvasRef.current, view);
  }, [draw, view]);
  function stopDrag() {
    const active = drag.current;
    drag.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.dataset.dragging = 'false';
      if (active && canvas.hasPointerCapture(active.pointerId))
        canvas.releasePointerCapture(active.pointerId);
    }
  }
  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!source || lock.current || !event.isPrimary || event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.dataset.dragging = 'true';
  }
  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const active = drag.current;
    if (!source || lock.current || !active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    updateView(
      panCrop(
        source.bitmap,
        viewRef.current,
        event.clientX - active.x,
        event.clientY - active.y,
        event.currentTarget.clientWidth,
        event.currentTarget.clientHeight
      )
    );
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }
  function pointerEnd(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (drag.current?.pointerId === event.pointerId) stopDrag();
  }
  function changeZoom(value: number) {
    if (source && !lock.current) updateView(zoomCrop(source.bitmap, viewRef.current, value));
  }
  function changePosition(axis: 'x' | 'y', value: number) {
    if (!source || lock.current) return;
    const current = viewRef.current;
    const pixels = cropPixels(source.bitmap, current);
    const span = (axis === 'x' ? source.bitmap.width : source.bitmap.height) - pixels.side;
    updateView(clampCrop(source.bitmap, { ...current, [axis]: (span * value) / 100 }));
  }
  async function choose(file: File) {
    if (lock.current || disabled) return false;
    lock.current = true;
    setPreparing(true);
    onBusy(true);
    setError(null);
    try {
      const bitmap = await decodeAvatar(file);
      if (!alive.current) {
        bitmap.close();
        return false;
      }
      updateView(initialCrop(bitmap));
      setSource({ file, bitmap });
    } catch (failure) {
      if (alive.current) {
        setError(failure instanceof Error ? failure.message : '无法读取图片');
        onBusy(false);
      }
    } finally {
      lock.current = false;
      if (alive.current) setPreparing(false);
    }
    return false;
  }
  function close() {
    if (lock.current) return;
    stopDrag();
    setSource(null);
    setError(null);
    onBusy(false);
  }
  async function save() {
    if (!source || lock.current) return;
    lock.current = true;
    stopDrag();
    setUploading(true);
    setError(null);
    const { left, top, side } = cropPixels(source.bitmap, viewRef.current);
    try {
      const result = await uploadAvatar(
        source.file,
        {
          x: left / source.bitmap.width,
          y: top / source.bitmap.height,
          size: side / Math.min(source.bitmap.width, source.bitmap.height)
        },
        member.revision
      );
      if (alive.current) {
        setSource(null);
        onSaved(result);
        onBusy(false);
        onSaveFeedback('success', '头像已保存。');
      }
    } catch (failure) {
      if (alive.current) {
        const detail = errorDetail(failure);
        onSaveFeedback('error', detail.message);
        if (['CONFLICT', 'NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(detail.code)) {
          setSource(null);
          onBusy(false);
          onReloadRequired(detail.message);
        } else setError(detail.message);
      }
    } finally {
      lock.current = false;
      if (alive.current) setUploading(false);
    }
  }
  return (
    <div className="member-avatar-editor">
      <MemberAvatar member={member} size={80} />
      <div>
        <Upload
          accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
          multiple={false}
          showUploadList={false}
          disabled={disabled || preparing || uploading || !!source}
          beforeUpload={choose}
        >
          <Button disabled={disabled || preparing || uploading || !!source} loading={preparing}>
            更换头像
          </Button>
        </Upload>
      </div>
      {!source ? <ErrorNotice message={error} /> : null}
      <Modal
        title="裁剪头像"
        open={!!source}
        onCancel={close}
        onOk={() => void save()}
        okText="保存头像"
        cancelText="取消"
        confirmLoading={uploading}
        cancelButtonProps={{ disabled: uploading }}
        okButtonProps={{ disabled: !source }}
        keyboard={!uploading}
        mask={{ closable: false }}
        closable={{ disabled: uploading, 'aria-label': '关闭裁剪' }}
        destroyOnHidden
        width={520}
      >
        <div className="avatar-crop-content">
          <p className="member-note">拖动图片调整位置，滚轮缩放；也可使用下方滑块。</p>
          <canvas
            ref={drawPreview}
            width={512}
            height={512}
            className="avatar-crop-preview avatar-crop-interactive"
            role="img"
            aria-label="裁剪后的方形头像预览"
            data-disabled={uploading}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerEnd}
            onPointerCancel={pointerEnd}
            onLostPointerCapture={pointerEnd}
          />
          <div>
            <p id="avatar-zoom-label">放大</p>
            <Slider
              ariaLabelledByForHandle="avatar-zoom-label"
              min={1}
              max={4}
              step={0.01}
              value={view.zoom}
              onChange={changeZoom}
              disabled={uploading}
              tooltip={{ formatter: (value) => `${value?.toFixed(2)} 倍` }}
            />
          </div>
          <div>
            <p id="avatar-x-label">左右位置</p>
            <Slider
              ariaLabelledByForHandle="avatar-x-label"
              min={0}
              max={100}
              value={horizontal}
              onChange={(value) => changePosition('x', value)}
              disabled={uploading || (source?.bitmap.width ?? 0) <= side}
            />
          </div>
          <div>
            <p id="avatar-y-label">上下位置</p>
            <Slider
              ariaLabelledByForHandle="avatar-y-label"
              min={0}
              max={100}
              value={vertical}
              onChange={(value) => changePosition('y', value)}
              disabled={uploading || (source?.bitmap.height ?? 0) <= side}
            />
          </div>
          <ErrorNotice message={error} />
        </div>
      </Modal>
    </div>
  );
}
