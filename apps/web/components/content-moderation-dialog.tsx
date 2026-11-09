'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, Input, Modal } from 'antd';
import { errorDetail } from './account/api';
import { useFeedbackMessage } from './use-feedback-message';
import { useWishCommand } from './wishes/use-wish-command';
import './content-moderation-dialog.css';

/** One explicit governance confirmation; uncertain retries retain their exact payload/key. */
export default function ContentModerationDialog({
  scope,
  id,
  revision,
  open,
  blocked = false,
  onClose,
  onRemoved,
  onStale,
  onLockedChange
}: {
  scope: 'wishes' | 'lotteries';
  id: string;
  revision: number;
  open: boolean;
  blocked?: boolean;
  onClose(): void;
  onRemoved(): void;
  onStale(): void;
  onLockedChange(locked: boolean): void;
}) {
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const [reason, setReason] = useState(''),
    command = useWishCommand(),
    { notify, contextHolder } = useFeedbackMessage(),
    locked = command.busy || command.uncertain;
  useEffect(() => {
    onLockedChange(locked);
    return () => onLockedChange(false);
  }, [locked, onLockedChange]);
  function close() {
    if (locked) return;
    setReason('');
    onClose();
  }
  const label = scope === 'wishes' ? '心愿' : '抽奖';
  async function submit() {
    if (command.busy || blocked) return;
    try {
      const result = command.uncertain
        ? await command.retry<{ moderated: true }>()
        : await command.send<{ moderated: true }>(`/api/${scope}/${id}/moderate`, {
            expectedRevision: revision,
            reason,
            confirmed: true
          });
      if (!live.current) return;
      if (result) {
        notify('success', label + '已违规删除');
        onRemoved();
      }
    } catch (failure) {
      if (!live.current) return;
      const error = errorDetail(failure);
      notify('error', error.message);
      if (error.code === 'CONFLICT' && !command.uncertain) onStale();
    }
  }
  return (
    <>
      {contextHolder}
      <Modal
        title={'违规删除' + label}
        open={open}
        closable={!locked}
        mask={{ closable: !locked }}
        keyboard={!locked}
        onCancel={() => {
          close();
        }}
        footer={
          <div className="content-moderation-actions">
            <Button disabled={locked} onClick={close}>
              取消
            </Button>
            <Button
              danger
              type="primary"
              loading={command.busy}
              disabled={blocked || (!command.uncertain && !reason.trim())}
              onClick={() => void submit()}
            >
              {command.uncertain ? '重试本次违规删除' : '确认违规删除'}
            </Button>
          </div>
        }
      >
        <p>
          {scope === 'wishes'
            ? '将移除这条心愿及留言展示，保留原内容、关联活动和关联记录，不取消活动。'
            : '将移除这场抽奖展示，停止报名和后续开奖，保留参与名单、记录及已出结果。'}
        </p>
        <p>本次处理不新增通知或处罚。确认违规删除？</p>
        <Input.TextArea
          aria-label="处理原因"
          placeholder="处理原因（必填）"
          autoComplete="off"
          maxLength={1000}
          value={reason}
          disabled={locked}
          onChange={(event) => setReason(event.target.value)}
        />
        {command.uncertain ? <p role="status">暂未确认处理结果，请重试本次违规删除。</p> : null}
      </Modal>
    </>
  );
}
