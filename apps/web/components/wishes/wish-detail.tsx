'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Modal } from 'antd';
import OperationMenu from '../operation-menu';
import ContentModerationDialog from '../content-moderation-dialog';
import {
  type WishDelete,
  type WishDetail,
  type WishInterestList,
  type WishWrite
} from '../../server/wishes/contract';
import { PageHeading } from '../home-content';
import { ActivityHeading, beijingFull } from '../activities/activity-ui';
import { useActivityResource } from '../activities/use-activity-resource';
import { errorDetail } from '../account/api';
import { useFeedbackMessage } from '../use-feedback-message';
import { useAuthSession } from '../auth-session';
import DailyToolbarIcon from '../daily/daily-toolbar-icon';
import { HomeActivityCard } from '../home-activities';
import { ListPagination } from '../collection-controls';
import DiscussionComments from '../discussion-comments';
import { WishCategoryTag, WishPaper } from './wish-ui';
import { useWishCommand } from './use-wish-command';
import '../daily/daily.css';

export default function WishDetailPage({ id, commentId }: { id: string; commentId?: string }) {
  const { session } = useAuthSession(),
    router = useRouter();
  const [version, setVersion] = useState(0),
    [interestPage, setInterestPage] = useState(1),
    [deleteOpen, setDeleteOpen] = useState(false),
    [moderationTarget, setModerationTarget] = useState<{
      id: string;
      owner: string;
      revision: number;
    } | null>(null),
    [moderationLocked, setModerationLocked] = useState(false),
    [discussionLocked, setDiscussionLocked] = useState(false);
  const interestCommand = useWishCommand(),
    deleteCommand = useWishCommand();
  const resource = useActivityResource<WishDetail>('/api/wishes/' + id + '?v=' + version, {
      keepPreviousData: true
    }),
    wish = resource.data;
  const interestResource = useActivityResource<WishInterestList>(
    '/api/wishes/' + id + '/interests?page=' + interestPage + '&v=' + version,
    { keepPreviousData: true }
  );
  const { notify, contextHolder } = useFeedbackMessage();
  const lastInterestError = useRef<string | null>(null);
  useEffect(() => {
    if (interestResource.error && interestResource.error !== lastInterestError.current)
      notify('error', interestResource.error);
    lastInterestError.current = interestResource.error;
  }, [interestResource.error, notify]);
  const locked = deleteCommand.busy || deleteCommand.uncertain || moderationLocked;
  const canModerate = Boolean(
    wish?.id === id && wish.canModerate && session?.user?.adminRole === 'SUPER_ADMIN' && !resource.error
  );
  const moderationIdentity =
    id +
    ':' +
    (session?.user?.id ?? '') +
    ':' +
    (session?.expiresAt ?? '') +
    ':' +
    (session?.user?.adminRole ?? 'NONE') +
    ':' +
    canModerate;
  const [moderationGeneration, setModerationGeneration] = useState(moderationIdentity);
  if (moderationGeneration !== moderationIdentity) {
    setModerationGeneration(moderationIdentity);
    setModerationTarget(null);
  }

  async function interest() {
    if (!wish || wish.isAuthor || interestCommand.busy || locked || discussionLocked) return;
    try {
      const result = interestCommand.uncertain
        ? await interestCommand.retry<WishWrite>()
        : await interestCommand.send<WishWrite>(
            '/api/wishes/' + id + '/interest' + (wish.interested ? '/cancel' : ''),
            {}
          );
      if (result) {
        setVersion((value) => value + 1);
        notify('success', result.wish.interested ? '已表达兴趣' : '已取消兴趣');
      }
    } catch (failure) {
      notify('error', errorDetail(failure).message);
    }
  }
  async function complete() {
    if (deleteCommand.busy) return;
    try {
      const result = deleteCommand.uncertain
        ? await deleteCommand.retry<WishDelete>()
        : await deleteCommand.send<WishDelete>('/api/wishes/' + id + '/delete', { confirmed: true });
      if (result) router.push('/wishes');
    } catch (failure) {
      notify('error', errorDetail(failure).message);
      setVersion((value) => value + 1);
    }
  }
  return (
    <main className="home-content wishes-content" id="main-content">
      {contextHolder}
      <ActivityHeading title="心愿详情">
        <Link className="activity-text-link" href="/wishes">
          返回心愿板
        </Link>
      </ActivityHeading>
      {!wish ? (
        <p role={resource.error ? 'alert' : 'status'}>{resource.error || '正在读取心愿…'}</p>
      ) : (
        <>
          {resource.error ? <p role="alert">{resource.error}</p> : null}
          <div className="wish-columns">
            <div className="wish-stack">
              <WishPaper>
                <article className="wish-stack">
                  <div className="wish-detail-card-heading">
                    <div className="wish-card-title wish-detail-title">
                      <WishCategoryTag category={wish.category} />
                      <h2>{wish.title}</h2>
                    </div>
                    {wish.isAuthor || canModerate ? (
                      <OperationMenu
                        label="心愿管理操作"
                        disabled={
                          locked || discussionLocked || interestCommand.busy || interestCommand.uncertain
                        }
                        items={[
                          ...(wish.isAuthor
                            ? [
                                { key: 'edit', label: '修改心愿' },
                                { key: 'complete', label: '完成心愿' }
                              ]
                            : []),
                          ...(canModerate ? [{ key: 'moderate', label: '违规删除', danger: true }] : [])
                        ]}
                        onAction={(key) => {
                          if (key === 'edit') router.push('/wishes/' + id + '/edit');
                          else if (key === 'moderate')
                            setModerationTarget({
                              id,
                              owner: session?.user?.id ?? '',
                              revision: wish.revision
                            });
                          else setDeleteOpen(true);
                        }}
                      />
                    ) : null}
                  </div>
                  <section className="wish-detail-group">
                    <h3>基本信息</h3>
                    <dl className="wish-detail-facts">
                      <div>
                        <dt>组织者</dt>
                        <dd>
                          <Link href={'/members/' + wish.author.id}>{wish.author.displayName || '成员'}</Link>
                        </dd>
                      </div>
                      <div>
                        <dt>发起时间</dt>
                        <dd>
                          <time dateTime={wish.createdAt}>{beijingFull(wish.createdAt)}</time>
                        </dd>
                      </div>
                      <div>
                        <dt>关联情况</dt>
                        <dd>
                          {wish.activity ? (
                            <Link href={'/activities/' + wish.activity.id}>
                              {wish.activity.title}
                              {wish.activity.cancelledAt ? '（已取消）' : ''}
                            </Link>
                          ) : (
                            '暂无关联活动'
                          )}
                        </dd>
                      </div>
                    </dl>
                  </section>
                  <section className="wish-detail-group">
                    <h3>想玩的内容</h3>
                    <p className="wish-body">{wish.body}</p>
                  </section>
                  <section className="wish-detail-group">
                    <h3>方便时间</h3>
                    <p className="wish-body">{wish.convenientTime || '暂未填写'}</p>
                  </section>
                </article>
              </WishPaper>
              <WishPaper className="wish-discussion">
                <PageHeading decoration="cheese">留言讨论</PageHeading>
                <DiscussionComments
                  scope="wish"
                  id={id}
                  commentId={commentId}
                  onChange={() => setVersion((value) => value + 1)}
                  onLockedChange={setDiscussionLocked}
                />
              </WishPaper>
            </div>
            <aside className="wish-stack">
              <WishPaper>
                <section className="wish-stack" aria-label="兴趣概况">
                  <div className="wish-interest-heading">
                    <PageHeading decoration="patty">兴趣概况</PageHeading>
                    <p>{wish.interestCount} 人感兴趣</p>
                  </div>
                  <Button
                    className="wish-sidebar-action"
                    type={interestCommand.uncertain || !wish.interested ? 'primary' : 'default'}
                    block
                    aria-pressed={wish.interested}
                    loading={interestCommand.busy}
                    disabled={locked || discussionLocked || wish.isAuthor || resource.loading}
                    onClick={() => void interest()}
                  >
                    {interestCommand.uncertain
                      ? '重试兴趣操作'
                      : wish.isAuthor
                        ? '我的心愿'
                        : wish.interested
                          ? '取消兴趣'
                          : '我也想'}
                  </Button>
                  {interestCommand.uncertain ? <p role="status">暂未确认兴趣操作结果，请重试。</p> : null}
                  {(interestResource.data?.items ?? wish.interests).length ? (
                    <ul className="wish-interest-people" aria-label="感兴趣的人">
                      {(interestResource.data?.items ?? wish.interests).map((person) => (
                        <li key={person.id}>
                          <Link href={'/members/' + person.id}>{person.displayName || '成员'}</Link>
                          <span className="wish-interest-server">
                            <DailyToolbarIcon kind="server" />
                            <span>
                              {[person.gameRegion, person.gameServer].filter(Boolean).join(' · ') ||
                                '尚未填写区服'}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <ListPagination
                    page={interestResource.data?.page ?? wish.interestPage}
                    totalPages={Math.max(
                      1,
                      Math.ceil((interestResource.data?.total ?? wish.interestCount) / 10)
                    )}
                    loading={interestResource.loading || interestCommand.busy}
                    onPageChange={setInterestPage}
                    label="感兴趣的人分页"
                  />
                </section>
              </WishPaper>
              <section className="wish-associated-activity" aria-label="关联活动">
                <PageHeading decoration="tomato">关联活动</PageHeading>
                {wish.activity ? (
                  <>
                    {wish.activity.cancelledAt ? <p className="wish-associated-status">活动已取消</p> : null}
                    <HomeActivityCard activity={wish.activity} motion={false} />
                  </>
                ) : (
                  <WishPaper>
                    <div className="wish-stack">
                      {wish.isAuthor && session?.user?.membership === 'MEMBER' ? (
                        <Button
                          type="primary"
                          className="wish-sidebar-action"
                          block
                          href={'/wishes/' + id + '/activity'}
                        >
                          创建关联活动
                        </Button>
                      ) : (
                        <p>暂无关联活动。</p>
                      )}
                    </div>
                  </WishPaper>
                )}
              </section>
            </aside>
          </div>
        </>
      )}
      {canModerate ? (
        <ContentModerationDialog
          key={moderationIdentity}
          scope="wishes"
          id={id}
          revision={moderationTarget?.revision ?? 0}
          open={moderationTarget?.id === id && moderationTarget?.owner === session?.user?.id}
          onClose={() => setModerationTarget(null)}
          blocked={
            deleteCommand.busy ||
            deleteCommand.uncertain ||
            discussionLocked ||
            interestCommand.busy ||
            interestCommand.uncertain
          }
          onLockedChange={setModerationLocked}
          onRemoved={() => router.push('/wishes')}
          onStale={() => {
            setModerationTarget(null);
            setVersion((value) => value + 1);
          }}
        />
      ) : null}
      <Modal
        title="完成心愿"
        open={deleteOpen}
        onCancel={() => {
          if (!locked) setDeleteOpen(false);
        }}
        closable={!locked}
        mask={{ closable: !locked }}
        keyboard={!locked}
        footer={
          <div className="wish-actions wish-delete-actions">
            <Button disabled={locked} onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button danger type="primary" loading={deleteCommand.busy} onClick={() => void complete()}>
              {deleteCommand.uncertain ? '重试本次完成' : '完成心愿'}
            </Button>
          </div>
        }
      >
        <p>
          完成后将删除这条心愿及其全部留言。
          {wish?.activity ? '已关联的活动会保留，并解除与这条心愿的关联。' : ''}确定完成？
        </p>
        {deleteCommand.uncertain ? <p role="status">暂未确认完成结果，请重试本次完成。</p> : null}
      </Modal>
    </main>
  );
}
