import StickerText from '../stickers/sticker-text';
import { useState } from 'react';
import { errorDetail } from '../account/api';
import Link from 'next/link';
import { Button, Image, Input, Modal } from 'antd';
import type { DailyPostView } from '../../server/daily/contract';
import { MemberAvatar, MemberPaper } from '../members/member-ui';
import { useFeedbackMessage } from '../use-feedback-message';
import { DailyComposer } from './lazy-composers';
import DailyComments, { DailyTime } from './daily-comments';
import { useDailyCommand, dailyError } from './use-command';
export default function DailyCard({
  post,
  onChange,
  onRemove,
  expanded = false,
  preview = false,
  wholeCardLink = false,
  focusCommentId
}: {
  post: DailyPostView;
  onChange(): Promise<void>;
  onRemove(): Promise<void>;
  expanded?: boolean;
  preview?: boolean;
  wholeCardLink?: boolean;
  focusCommentId?: string;
}) {
  const [comments, setComments] = useState(expanded),
    [commentsOpened, setCommentsOpened] = useState(expanded),
    [edit, setEdit] = useState(false),
    [remove, setRemove] = useState(false),
    [moderate, setModerate] = useState(false),
    [reason, setReason] = useState(''),
    [error, setError] = useState<string | null>(null),
    command = useDailyCommand(),
    { notify, contextHolder } = useFeedbackMessage();
  async function act(kind: 'like' | 'remove' | 'moderate') {
    setError(null);
    try {
      const result = await command.send(
        '/api/daily/' + post.id + '/' + kind,
        kind === 'like'
          ? { liked: !post.liked }
          : { revision: post.revision, ...(kind === 'moderate' ? { reason } : {}) }
      );
      if (result) {
        if (kind === 'like') await onChange();
        else {
          setRemove(false);
          setModerate(false);
          notify('success', '动态已删除');
          await onRemove();
        }
      }
    } catch (e) {
      if (['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(errorDetail(e).code)) setError(dailyError(e));
      else notify('error', dailyError(e));
    }
  }
  return (
    <MemberPaper className="daily-card">
      <article id={'daily-' + post.id}>
        {contextHolder}
        <div className="daily-card-heading">
          <div className="daily-person">
            {wholeCardLink ? (
              <span data-home-card-independent>
                <MemberAvatar member={post.author} size={32} />
              </span>
            ) : (
              <MemberAvatar member={post.author} size={32} />
            )}
            <Link href={'/members/' + post.author.id}>{post.author.displayName || '成员'}</Link>
            {wholeCardLink ? (
              <Link
                data-home-card-link
                aria-label={(post.author.displayName || '成员') + '的动态'}
                href={'/daily/' + post.id}
              >
                <DailyTime value={post.createdAt} />
              </Link>
            ) : (
              <DailyTime value={post.createdAt} />
            )}{' '}
            {post.editedAt ? <span className="daily-meta">已编辑</span> : null}
          </div>
          {!preview ? (
            <div className="daily-actions">
              {post.canEdit && !edit ? (
                <>
                  <Button type="link" disabled={command.busy} onClick={() => setEdit(!edit)}>
                    编辑
                  </Button>
                  <Button type="link" danger disabled={command.busy} onClick={() => setRemove(true)}>
                    删除
                  </Button>
                </>
              ) : null}
              {post.canModerate ? (
                <Button
                  type="link"
                  danger
                  disabled={command.busy}
                  onClick={() => {
                    setModerate(true);
                    setReason('');
                  }}
                >
                  处理违规
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="daily-error">
            {error}
          </p>
        ) : null}
        {edit ? (
          <DailyComposer
            key={post.revision}
            post={post}
            onCancel={() => setEdit(false)}
            onSaved={async () => {
              setEdit(false);
              await onChange();
              notify('success', '动态已修改');
            }}
          />
        ) : (
          <div className="daily-post-content">
            <p className="daily-body">
              <StickerText text={post.body} />
            </p>
            {post.media.length ? (
              <Image.PreviewGroup>
                <div className="daily-images">
                  {post.media.map((m) => (
                    <Image
                      key={m.id}
                      src={m.thumbnailUrl}
                      alt={m.frames > 1 ? '动态配图' : '配图'}
                      preview={{ src: m.previewUrl }}
                    />
                  ))}
                </div>
              </Image.PreviewGroup>
            ) : null}
          </div>
        )}
        {preview ? (
          wholeCardLink ? null : (
            <Link className="daily-text-link" href={'/daily/' + post.id}>
              查看动态
            </Link>
          )
        ) : (
          <>
            <div className="daily-card-footer">
              <div className="daily-actions">
                <Button
                  type="link"
                  aria-pressed={post.liked}
                  disabled={command.busy}
                  onClick={() => void act('like')}
                >
                  {post.liked ? '取消点赞' : '点赞'} {post.likes}
                </Button>
                <Button
                  type="link"
                  aria-expanded={comments}
                  onClick={() => {
                    setCommentsOpened(true);
                    setComments(!comments);
                  }}
                >
                  {comments ? '收起评论' : '评论'} {post.comments}
                </Button>
              </div>
            </div>
            {commentsOpened ? (
              <div hidden={!comments}>
                <DailyComments postId={post.id} onChange={onChange} focusCommentId={focusCommentId} />
              </div>
            ) : null}
          </>
        )}
        <Modal
          title="删除动态"
          open={remove}
          onCancel={() => !command.busy && setRemove(false)}
          closable={!command.busy}
          mask={{ closable: !command.busy }}
          footer={
            <div className="daily-actions daily-modal-actions">
              <Button disabled={command.busy} onClick={() => setRemove(false)}>
                取消
              </Button>
              <Button danger type="primary" loading={command.busy} onClick={() => void act('remove')}>
                删除动态
              </Button>
            </div>
          }
        >
          <p>确定删除这条动态及其评论展示？</p>
          {error ? <p role="alert">{error}</p> : null}
        </Modal>
        <Modal
          title="处理违规动态"
          open={moderate}
          onCancel={() => !command.busy && setModerate(false)}
          closable={!command.busy}
          mask={{ closable: !command.busy }}
          footer={
            <div className="daily-actions daily-modal-actions">
              <Button disabled={command.busy} onClick={() => setModerate(false)}>
                取消
              </Button>
              <Button
                danger
                type="primary"
                disabled={!reason.trim()}
                loading={command.busy}
                onClick={() => void act('moderate')}
              >
                删除违规动态
              </Button>
            </div>
          }
        >
          <Input.TextArea
            autoComplete="off"
            aria-label="处理原因"
            value={reason}
            maxLength={1000}
            disabled={command.busy}
            onChange={(e) => setReason(e.target.value)}
          />
          {error ? <p role="alert">{error}</p> : null}
        </Modal>
      </article>
    </MemberPaper>
  );
}
