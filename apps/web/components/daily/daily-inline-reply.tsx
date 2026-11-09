import type { DiscussionTransport } from './discussion-transport';
import { useCallback, useEffect, useState } from 'react';
import { Button } from 'antd';
import { useFeedbackMessage } from '../use-feedback-message';
import type { DailyCommentView } from '../../server/daily/contract';
import DailyActionIcon from './daily-action-icon';
import { DailyReplyComposer } from './lazy-composers';

export default function DailyInlineReply({
  postId,
  comment,
  count,
  disabled,
  onSaved,
  onLockedChange,
  transport
}: {
  postId: string;
  transport?: DiscussionTransport;
  comment: DailyCommentView;
  count: number;
  disabled: boolean;
  onSaved(): Promise<void>;
  onLockedChange(id: string, locked: boolean): void;
}) {
  const { notify, contextHolder } = useFeedbackMessage();
  const [open, setOpen] = useState(false),
    [opened, setOpened] = useState(false),
    [locked, setLocked] = useState(false);
  const reportLock = useCallback(
    (value: boolean) => {
      setLocked(value);
      onLockedChange(comment.id, value);
    },
    [comment.id, onLockedChange]
  );
  useEffect(() => () => onLockedChange(comment.id, false), [comment.id, onLockedChange]);
  return (
    <div className="daily-inline-reply" data-home-card-independent>
      {contextHolder}
      <div className="daily-home-actions">
        <Button
          type="text"
          aria-label={'回复 ' + (comment.author.displayName || '成员') + ' ' + count}
          aria-expanded={open}
          aria-controls={'daily-reply-editor-' + comment.id}
          disabled={disabled || locked}
          icon={<DailyActionIcon kind="reply" active={open} />}
          onClick={() => {
            setOpened(true);
            setOpen((value) => !value);
          }}
        >
          {count}
        </Button>
      </div>
      {opened ? (
        <div id={'daily-reply-editor-' + comment.id} hidden={!open}>
          <DailyReplyComposer
            transport={transport}
            postId={postId}
            parentId={comment.id}
            inputId={'daily-comment-input-' + postId + '-' + comment.id}
            replyName={comment.author.displayName || '成员'}
            autoFocus
            compactTools
            submitLabel="发布"
            disabled={disabled}
            onLockedChange={reportLock}
            onPublished={() => notify('success', '评论已发布')}
            onSaved={async () => {
              await onSaved();
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
