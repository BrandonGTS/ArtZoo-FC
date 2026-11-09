'use client';
import { useRef, useState } from 'react';
import type { InlineStickerInputRef } from './inline-sticker-input';
import { Button, Modal } from 'antd';
import Image from 'next/image';
import { stickers } from './sticker-codec';
import DailyToolbarIcon from '../daily/daily-toolbar-icon';
import './stickers.css';

export function useStickerInput(disabled: boolean) {
  const ref = useRef<InlineStickerInputRef>(null);
  return {
    inputProps: { ref },
    read() {
      return ref.current?.read() ?? null;
    },
    restore() {
      if (!disabled) ref.current?.focus();
    },
    insert(id: string) {
      return !disabled && (ref.current?.insertSticker(id) ?? false);
    }
  };
}
export default function StickerPicker({
  disabled = false,
  compact = false,
  className,
  zIndex,
  onSelect,
  onClosed
}: {
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  zIndex?: number;
  onSelect(id: string): boolean;
  onClosed?(): void;
}) {
  const [open, setOpen] = useState(false),
    [full, setFull] = useState(false);
  const selecting = useRef(false);
  // A command lock closes the picker instead of reviving it after the request ends.
  if (disabled && open) setOpen(false);
  function close() {
    setOpen(false);
    setFull(false);
  }
  return (
    <>
      <Button
        data-home-card-independent
        className={className}
        type={compact ? 'text' : 'default'}
        htmlType="button"
        disabled={disabled}
        aria-label="选择表情"
        aria-haspopup="dialog"
        aria-expanded={open && !disabled}
        icon={compact ? <DailyToolbarIcon kind="emoji" /> : undefined}
        onClick={() => {
          selecting.current = false;
          setFull(false);
          setOpen(true);
        }}
      >
        {compact ? null : '表情'}
      </Button>
      <Modal
        title="插入表情"
        zIndex={zIndex}
        open={open && !disabled}
        centered
        footer={null}
        width={560}
        className="sticker-picker-modal"
        destroyOnHidden
        focusable={{ focusTriggerAfterClose: false }}
        afterClose={onClosed}
        onCancel={close}
        styles={{
          container: { background: '#fff' },
          body: { maxHeight: 'min(70vh, 36rem)', overflowY: 'auto' }
        }}
      >
        {open && !disabled ? (
          <div className="sticker-picker-grid" data-home-card-independent>
            {stickers.map((sticker) => (
              <Button
                key={sticker.id}
                type="text"
                htmlType="button"
                className="sticker-picker-option"
                aria-label={'插入表情：' + sticker.label}
                title={sticker.label}
                onClick={() => {
                  if (selecting.current) return;
                  selecting.current = true;
                  if (onSelect(sticker.id)) close();
                  else {
                    selecting.current = false;
                    setFull(true);
                  }
                }}
              >
                <Image
                  src={sticker.url}
                  width={sticker.width}
                  height={sticker.height}
                  alt={sticker.label}
                  unoptimized
                  loading="lazy"
                />
              </Button>
            ))}
          </div>
        ) : null}
        {full ? (
          <p role="status" className="sticker-picker-status">
            剩余字数不足，请先删减内容再插入表情。
          </p>
        ) : null}
      </Modal>
    </>
  );
}
