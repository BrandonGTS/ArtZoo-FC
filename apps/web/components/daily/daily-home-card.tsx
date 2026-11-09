import StickerText from '../stickers/sticker-text';
import { useState } from 'react';
import { errorDetail } from '../account/api';
import { useFeedbackMessage } from '../use-feedback-message';
import Link from 'next/link';
import { Button, Image } from 'antd';
import type { DailyPostView } from '../../server/daily/contract';
import { useAuthSession } from '../auth-session';
import HomeCardSurface from '../home-card-surface';
import { MemberAvatar, MemberPaper } from '../members/member-ui';
import DailyComments, { DailyTime } from './daily-comments';
import DailyToolbarIcon from './daily-toolbar-icon';
import DailyActionIcon from './daily-action-icon';
import DailyPostMenu from './daily-post-menu';
import { DailyComposer } from './lazy-composers';
import { dailyError, useDailyCommand } from './use-command';

export default function DailyHomeCard({
  post,
  onChange,
  onRemove,
  onEdited,
  variant = 'home',
  focusCommentId
}: {
  post: DailyPostView;
  onChange(): Promise<void>;
  onRemove(): Promise<void>;
  onEdited?(): void;
  variant?: 'home' | 'feed' | 'detail';
  focusCommentId?: string;
}) {
  const [replyVisible, setReplyVisible] = useState(variant === 'detail'),
    [repliesOpened, setRepliesOpened] = useState(variant === 'detail'),
    [error, setError] = useState<string | null>(null);
  const [discussionLocked, setDiscussionLocked] = useState(false),
    [editing, setEditing] = useState(false),
    [editLocked, setEditLocked] = useState(false);
  const command = useDailyCommand(),
    { session, avatar } = useAuthSession();
  const { notify, contextHolder } = useFeedbackMessage();
  async function like() {
    if (command.busy) return;
    setError(null);
    let confirmed = false;
    try {
      const result = command.uncertain
        ? await command.retry()
        : await command.send('/api/daily/' + post.id + '/like', { liked: !post.liked });
      if (result) {
        confirmed = true;
        await onChange();
      }
    } catch (failure) {
      if (confirmed || ['NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(errorDetail(failure).code))
        setError(dailyError(failure));
      else notify('error', dailyError(failure));
    }
  }
  const location = [post.author.gameRegion, post.author.gameServer].filter(Boolean).join(' · ');
  const content = (
    <MemberPaper
      className={
        'daily-card daily-home-card' +
        (variant !== 'home' ? ' daily-feed-card' : '') +
        (variant === 'detail' ? ' daily-detail-card' : '') +
        (post.media.length ? ' daily-home-card-with-media' : '')
      }
    >
      <article id={'daily-' + post.id}>
        {contextHolder}
        <header className="daily-home-heading">
          <span data-home-card-independent>
            <MemberAvatar member={post.author} size={60} />
          </span>
          <div className="daily-home-author">
            <div className="daily-home-author-line">
              <Link href={'/members/' + post.author.id}>{post.author.displayName || '成员'}</Link>
              {location ? (
                <span className="daily-meta daily-home-location">
                  <DailyToolbarIcon kind="server" />
                  {location}
                </span>
              ) : null}
            </div>
            {variant === 'detail' ? (
              <div className="daily-detail-time">
                <DailyTime value={post.createdAt} />
                {post.editedAt ? <span className="daily-meta">已编辑</span> : null}
              </div>
            ) : (
              <Link
                data-home-card-link
                aria-label={(post.author.displayName || '成员') + '的动态'}
                href={'/daily/' + post.id}
              >
                <DailyTime value={post.createdAt} />
              </Link>
            )}
          </div>
          <DailyPostMenu
            post={post}
            onRemoved={onRemove}
            blocked={discussionLocked || editLocked || editing}
            onEdit={variant !== 'home' && post.canEdit ? () => setEditing(true) : undefined}
          />
        </header>
        {editing ? (
          <DailyComposer
            key={post.revision}
            post={post}
            variant="feed"
            onLockedChange={setEditLocked}
            onCancel={() => setEditing(false)}
            onSaved={async () => {
              await onChange();
              setEditing(false);
              onEdited?.();
            }}
          />
        ) : (
          <div className="daily-home-content">
            {post.body ? (
              <p className="daily-body daily-home-body">
                <StickerText text={post.body} />
              </p>
            ) : null}
            {post.media.length ? (
              <Image.PreviewGroup>
                <div className="daily-home-images" data-home-card-independent>
                  {post.media.map((media) => (
                    <Image
                      key={media.id}
                      src={media.thumbnailUrl}
                      alt={media.frames > 1 ? '动态配图' : '配图'}
                      preview={{ src: media.previewUrl }}
                    />
                  ))}
                </div>
              </Image.PreviewGroup>
            ) : null}
          </div>
        )}
        <div className="daily-home-actions" data-home-card-independent>
          <Button
            type="text"
            aria-label={'回复 ' + post.comments}
            aria-expanded={replyVisible}
            aria-controls={'daily-home-comments-' + post.id}
            icon={<DailyActionIcon kind="reply" active={replyVisible} />}
            onClick={() => {
              setRepliesOpened(true);
              setReplyVisible((current) => !current);
            }}
          >
            {post.comments}
          </Button>
          <Button
            type="text"
            aria-label={(post.liked ? '取消点赞 ' : '点赞 ') + post.likes}
            aria-pressed={post.liked}
            disabled={command.busy}
            aria-busy={command.busy}
            icon={<DailyActionIcon kind="like" active={post.liked} />}
            onClick={() => void like()}
          >
            {post.likes}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="daily-error" data-home-card-independent>
            {command.uncertain ? (
              <>
                <span>暂未确认点赞结果。</span>
                <Button type="link" onClick={() => void like()}>
                  重试
                </Button>
              </>
            ) : (
              error
            )}
          </p>
        ) : null}
        {repliesOpened ? (
          <div id={'daily-home-comments-' + post.id} hidden={!replyVisible} data-home-card-independent>
            <DailyComments
              variant="home"
              postId={post.id}
              onChange={onChange}
              onLockedChange={setDiscussionLocked}
              focusCommentId={focusCommentId}
              composerAvatar={
                session?.user ? (
                  <MemberAvatar member={{ avatar, membership: session.user.membership }} size={40} />
                ) : undefined
              }
            />
          </div>
        ) : null}
      </article>
    </MemberPaper>
  );
  if (variant === 'detail') return <div className="daily-detail-surface">{content}</div>;
  return (
    <HomeCardSurface
      motionProfile={variant === 'home' ? 'flat' : 'feed'}
      navigation={variant === 'home' ? 'card' : 'links'}
      interactionPaused={
        variant === 'home' ? replyVisible : replyVisible || editing || discussionLocked || editLocked
      }
    >
      {content}
    </HomeCardSurface>
  );
}
