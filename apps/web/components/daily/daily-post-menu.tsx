import { useState } from 'react';
import { errorDetail } from '../account/api';
import { useFeedbackMessage } from '../use-feedback-message';
import { Button, Input, Modal } from 'antd';
import type { DailyPostView } from '../../server/daily/contract';
import { dailyError, useDailyCommand } from './use-command';
import DailyDeleteMenu from './daily-delete-menu';

export default function DailyPostMenu({
  post,
  onRemoved,
  onEdit,
  blocked = false
}: {
  post: DailyPostView;
  onRemoved(): Promise<void>;
  onEdit?(): void;
  blocked?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState(''),
    [error, setError] = useState<string | null>(null);
  const command = useDailyCommand(),
    { notify, contextHolder } = useFeedbackMessage();
  const [moderate, setModerate] = useState(false);
  if (!post.canEdit && !post.canModerate) return null;
  const locked = blocked || command.busy || command.uncertain;
  async function remove() {
    if (blocked || command.busy) return;
    setError(null);
    let confirmed = false;
    try {
      const result = command.uncertain
        ? await command.retry()
        : await command.send('/api/daily/' + post.id + (moderate ? '/moderate' : '/remove'), {
            revision: post.revision,
            ...(moderate ? { reason } : {})
          });
      if (result) {
        confirmed = true;
        setOpen(false);
        await onRemoved();
      }
    } catch (failure) {
      if (!confirmed && ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(errorDetail(failure).code))
        setError(dailyError(failure));
      else notify('error', dailyError(failure));
    }
  }
  return (
    <span
      data-home-card-independent
      style={{ display: 'contents' }}
      onClick={(event) => event.stopPropagation()}
      onAuxClick={(event) => event.stopPropagation()}
    >
      {contextHolder}
      <DailyDeleteMenu
        label="动态管理操作"
        disabled={blocked || command.busy}
        onDelete={
          post.canEdit
            ? () => {
                setModerate(false);
                setReason('');
                setOpen(true);
              }
            : undefined
        }
        onModerate={
          post.canModerate
            ? () => {
                setModerate(true);
                setReason('');
                setOpen(true);
              }
            : undefined
        }
        onEdit={post.canEdit ? onEdit : undefined}
      />
      <Modal
        title={moderate ? '违规删除动态' : '删除动态'}
        open={open}
        closable={!locked}
        mask={{ closable: !locked }}
        onCancel={(event) => {
          event.stopPropagation();
          if (!locked) setOpen(false);
        }}
        modalRender={(modal) => (
          <div
            data-home-card-independent
            onClick={(event) => event.stopPropagation()}
            onAuxClick={(event) => event.stopPropagation()}
          >
            {modal}
          </div>
        )}
        footer={
          <div className="daily-actions daily-modal-actions">
            <Button disabled={locked} onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              danger
              type="primary"
              loading={command.busy}
              disabled={!command.uncertain && moderate && !reason.trim()}
              onClick={() => void remove()}
            >
              {command.uncertain ? '重试删除' : '删除动态'}
            </Button>
          </div>
        }
      >
        <p>确定删除这条动态及其评论展示？</p>
        {moderate ? (
          <Input.TextArea
            autoComplete="off"
            aria-label="处理原因"
            placeholder="处理原因"
            value={reason}
            maxLength={1000}
            disabled={locked}
            onChange={(event) => setReason(event.target.value)}
          />
        ) : null}
        {error && command.uncertain ? (
          <p role="alert" className="daily-error">
            暂未确认删除结果，请重试。
          </p>
        ) : null}
      </Modal>
    </span>
  );
}
