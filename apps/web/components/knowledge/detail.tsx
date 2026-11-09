'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useUserRouter } from '../user-operation-provider';
import { Button, Input, Modal, Tag } from 'antd';
import OperationMenu from '../operation-menu';
import { PageHeading } from '../home-content';
import { MemberAvatar } from '../members/member-ui';
import { ActivityPaper } from '../activities/activity-ui';
import { accountRequest, errorDetail } from '../account/api';
import { useAuthSession } from '../auth-session';
import { useFeedbackMessage } from '../use-feedback-message';
import type { Article, Version } from '../../server/knowledge/contract';
import { ArticleBody, Failure, date } from './shared';
import DailyComments from '../daily/daily-comments';
import DailyToolbarIcon from '../daily/daily-toolbar-icon';
import DailyActionIcon from '../daily/daily-action-icon';
import { useDailyCommand } from '../daily/use-command';
import type { DiscussionTransport } from '../daily/discussion-transport';
import { ListPagination } from '../collection-controls';
import { KnowledgeCategoryTag, KnowledgeTimeIcon, KnowledgeActionIcon } from './ui';
import '../daily/daily.css';
import '../discussion-comments.css';
import './knowledge.css';
type History = { items: Version[]; total: number; page: number };
export default function KnowledgeDetail({ id }: { id: string }) {
  const { session } = useAuthSession(),
    actor = session?.user;
  return actor ? (
    <OwnedKnowledgeDetail key={[actor.id, actor.membership, actor.adminRole, id].join(':')} id={id} />
  ) : null;
}
function OwnedKnowledgeDetail({ id }: { id: string }) {
  const router = useUserRouter(),
    params = useSearchParams(),
    { notify, contextHolder } = useFeedbackMessage(),
    writeLock = useRef(false),
    notified = useRef(false),
    mounted = useRef(false),
    reading = useRef(false);
  const [article, setArticle] = useState<Article | null>(null),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    [discussionLocked, setDiscussionLocked] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false),
    [history, setHistory] = useState<History | null>(null),
    [historyPage, setHistoryPage] = useState(1),
    [selected, setSelected] = useState<Version | null>(null),
    [historyError, setHistoryError] = useState<string | null>(null),
    [historyBusy, setHistoryBusy] = useState(false),
    [restoreReason, setRestoreReason] = useState('');
  const [removing, setRemoving] = useState(false),
    [moderateRemoval, setModerateRemoval] = useState(false),
    [reason, setReason] = useState('');
  const [commentPage, setCommentPage] = useState(1),
    [appliedCommentPage, setAppliedCommentPage] = useState(1),
    [commentLoading, setCommentLoading] = useState(true),
    [commentPages, setCommentPages] = useState(1),
    [focus, setFocus] = useState(true);
  const interaction = useDailyCommand(),
    locked = pending || discussionLocked || interaction.busy || interaction.uncertain;
  const focusComment = params.get('commentId'),
    focusCommentId = focusComment && /^[0-9a-f-]{36}$/i.test(focusComment) ? focusComment : undefined;
  const transport = useMemo<DiscussionTransport>(() => {
    const query = new URLSearchParams({ page: String(commentPage) });
    if (focus && focusCommentId) query.set('commentId', focusCommentId);
    return {
      listUrl: '/api/knowledge/' + id + '/comments?' + query,
      createUrl: '/api/knowledge/' + id + '/comments',
      uploadUrl: '/api/knowledge-images',
      removeUrl: (key) => '/api/knowledge/' + id + '/comments/' + key + '/remove',
      moderateUrl: (key) => '/api/knowledge/' + id + '/comments/' + key + '/remove'
    };
  }, [id, commentPage, focus, focusCommentId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    const a = await accountRequest<Article>('/api/knowledge/' + id, { userInitiated: true });
    if (mounted.current) setArticle(a);
    return a;
  }, [id]);
  useEffect(() => {
    const abort = new AbortController();
    accountRequest<Article>('/api/knowledge/' + id, { signal: abort.signal })
      .then(setArticle)
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorDetail(e).message);
      });
    return () => abort.abort();
  }, [id]);
  useEffect(() => {
    if (!article || reading.current) return;
    reading.current = true;
    void accountRequest<{ reads: number }>('/api/knowledge/' + id + '/read', {
      method: 'POST',
      body: {},
      userInitiated: false
    })
      .then((result) => {
        if (mounted.current)
          setArticle((current) => (current ? { ...current, reads: result.reads } : current));
      })
      .catch(() => {
        reading.current = false;
      });
  }, [article, id]);
  useEffect(() => {
    if (params.get('saved') === '1' && !notified.current) {
      notified.current = true;
      notify('success', '分享已保存');
      router.replace('/knowledge/' + id);
    }
  }, [params, id, router, notify]);
  useEffect(() => {
    if (!historyOpen) return;
    const abort = new AbortController();
    accountRequest<History>('/api/knowledge/' + id + '/history?page=' + historyPage, {
      signal: abort.signal,
      userInitiated: true
    })
      .then((h) => {
        setHistory(h);
        setSelected(h.items[0] ?? null);
        setHistoryError(null);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setHistoryError(errorDetail(e).message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setHistoryBusy(false);
      });
    return () => abort.abort();
  }, [historyOpen, historyPage, id]);
  async function restore() {
    if (!selected || !article || writeLock.current) return;
    writeLock.current = true;
    setPending(true);
    try {
      await accountRequest('/api/knowledge/' + id + '/restore', {
        method: 'POST',
        body: {
          versionId: selected.id,
          expectedRevision: article.revision,
          ...(article.isAdmin ? { reason: restoreReason } : {})
        }
      });
      if (!mounted.current) return;
      await load();
      if (!mounted.current) return;
      setHistoryOpen(false);
      notify('success', '已恢复此版本');
    } catch (e) {
      if (mounted.current) notify('error', errorDetail(e).message);
    } finally {
      if (mounted.current) setPending(false);
      writeLock.current = false;
    }
  }
  async function remove() {
    if (!article || writeLock.current) return;
    writeLock.current = true;
    setPending(true);
    try {
      await accountRequest('/api/knowledge/' + id + '/remove', {
        method: 'POST',
        body: {
          expectedRevision: article.revision,
          intent: moderateRemoval ? 'MODERATE' : 'SELF',
          ...(moderateRemoval ? { reason } : {})
        }
      });
      if (mounted.current) router.push('/knowledge');
    } catch (e) {
      if (mounted.current) notify('error', errorDetail(e).message);
    } finally {
      writeLock.current = false;
      if (mounted.current) setPending(false);
    }
  }
  async function interact(kind: 'like' | 'collect') {
    if (!article || interaction.busy || pending || discussionLocked) return;
    try {
      const result = interaction.uncertain
        ? await interaction.retry()
        : await interaction.send(
            '/api/knowledge/' + id + '/' + kind,
            kind === 'like' ? { liked: !article.liked } : { collected: !article.collected }
          );
      if (result) await load();
    } catch (e) {
      notify('error', errorDetail(e).message);
    }
  }
  async function share() {
    try {
      await navigator.clipboard.writeText(new URL('/knowledge/' + id, window.location.origin).href);
      notify('success', '分享链接已复制');
    } catch {
      notify('error', '复制失败，请从地址栏复制链接');
    }
  }
  const onPageInfo = useCallback((page: number, pages: number) => {
    setCommentPage(page);
    setAppliedCommentPage(page);
    setCommentPages(pages);
  }, []);
  const location = article
    ? [article.author.gameRegion, article.author.gameServer].filter(Boolean).join(' · ')
    : '';
  return (
    <main className="home-content knowledge-content" id="main-content">
      {contextHolder}
      <div className="knowledge-heading">
        <PageHeading level={1} decoration="burger">
          内容详情
        </PageHeading>
        <Link className="knowledge-link" href="/knowledge">
          返回内容分享
        </Link>
      </div>
      <Failure message={error} />
      {!article && !error ? <p role="status">正在读取分享…</p> : null}
      {article ? (
        <>
          <ActivityPaper className="knowledge-detail-paper">
            <article className="knowledge-detail-article">
              <div className="knowledge-detail-titlebar">
                <div className="knowledge-title-row">
                  <KnowledgeCategoryTag label={article.category.label} />
                  <h2>{article.title}</h2>
                </div>
                {article.canEdit || article.canHistory || article.canDelete || article.isAdmin ? (
                  <OperationMenu
                    label="分享管理操作"
                    disabled={locked}
                    items={[
                      ...(article.canEdit ? [{ key: 'edit', label: '编辑分享' }] : []),
                      ...(article.canHistory ? [{ key: 'history', label: '历史管理' }] : []),
                      ...(article.canDelete ? [{ key: 'delete', label: '删除分享', danger: true }] : []),
                      ...(article.isAdmin ? [{ key: 'moderate', label: '违规删除', danger: true }] : [])
                    ]}
                    onAction={(key) => {
                      if (key === 'edit') router.push('/knowledge/' + id + '/edit');
                      if (key === 'history') {
                        setHistoryBusy(true);
                        setRestoreReason('');
                        setHistoryOpen(true);
                      }
                      if (key === 'delete' || key === 'moderate') {
                        setModerateRemoval(key === 'moderate');
                        setReason('');
                        setRemoving(true);
                      }
                    }}
                  />
                ) : null}
              </div>
              <div className="knowledge-detail-person">
                <Link href={'/members/' + article.author.id}>
                  <MemberAvatar member={article.author} size={60} />
                </Link>
                <div className="knowledge-person-copy">
                  <div className="daily-home-author-line">
                    <Link href={'/members/' + article.author.id}>{article.author.displayName || '成员'}</Link>
                    {location ? (
                      <span className="daily-meta daily-home-location">
                        <DailyToolbarIcon kind="server" />
                        {location}
                      </span>
                    ) : null}
                  </div>
                  <time dateTime={article.createdAt}>
                    <KnowledgeTimeIcon />
                    {date(article.createdAt)}
                  </time>
                </div>
              </div>
              <div className="knowledge-detail-body">
                <ArticleBody
                  body={article.body}
                  bodyFormat={article.bodyFormat}
                  imageDimensions={article.imageDimensions}
                />
              </div>
              <footer className="knowledge-detail-footer">
                <div className="knowledge-statistics">
                  <span>阅读 {article.reads}</span>
                  <span>收藏 {article.collections}</span>
                  <span>评论 {article.comments}</span>
                  <span>赞 {article.likes}</span>
                </div>
                <div className="knowledge-detail-tools">
                  <Button
                    type="text"
                    aria-label="分享：复制链接"
                    icon={<KnowledgeActionIcon kind="share" />}
                    onClick={() => void share()}
                  />
                  <Button
                    type="text"
                    aria-label={article.collected ? '取消收藏' : '收藏'}
                    aria-pressed={article.collected}
                    disabled={locked && !interaction.uncertain}
                    icon={<KnowledgeActionIcon kind="collect" />}
                    onClick={() => void interact('collect')}
                  />
                  <Button
                    type="text"
                    aria-label={article.liked ? '取消点赞' : '点赞'}
                    aria-pressed={article.liked}
                    disabled={locked && !interaction.uncertain}
                    icon={<DailyActionIcon kind="like" active={article.liked} />}
                    onClick={() => void interact('like')}
                  />
                </div>
              </footer>
              {interaction.uncertain ? (
                <p role="alert" className="knowledge-error">
                  暂未确认互动结果。
                  <Button type="link" onClick={() => void interact('like')}>
                    重试本次操作
                  </Button>
                </p>
              ) : null}
            </article>
          </ActivityPaper>
          <ActivityPaper className="knowledge-discussion-paper">
            <PageHeading decoration="cheese">评论与回复</PageHeading>
            <div className="discussion-comments">
              <DailyComments
                postId={id}
                transport={transport}
                variant="home"
                composerMode="bottom"
                onPageInfo={onPageInfo}
                onLoadingChange={setCommentLoading}
                focusCommentId={focus ? focusCommentId : undefined}
                onLockedChange={setDiscussionLocked}
                onChange={async () => {
                  await load();
                }}
              />
              {commentPages > 1 ? (
                <ListPagination
                  page={appliedCommentPage}
                  totalPages={commentPages}
                  loading={commentLoading || discussionLocked}
                  onPageChange={(page) => {
                    setCommentLoading(true);
                    setFocus(false);
                    setCommentPage(page);
                  }}
                  label="内容评论分页"
                />
              ) : null}
            </div>
          </ActivityPaper>
          <Modal
            title="恢复历史"
            open={historyOpen}
            centered
            width={1000}
            className="knowledge-history-modal"
            classNames={{ container: 'knowledge-history-container' }}
            styles={{ footer: { borderTop: '1px solid var(--artzoo-line)', paddingTop: 16, marginTop: 20 } }}
            onCancel={() => {
              if (!pending) setHistoryOpen(false);
            }}
            mask={{ closable: !pending }}
            footer={
              <div className="knowledge-actions">
                <Button disabled={pending} onClick={() => setHistoryOpen(false)}>
                  取消
                </Button>
                <Button
                  type="primary"
                  loading={pending}
                  disabled={
                    !selected ||
                    (selected.body === article.body && selected.bodyFormat === article.bodyFormat)
                  }
                  onClick={restore}
                >
                  恢复此版本
                </Button>
              </div>
            }
          >
            <p className="knowledge-history-title">{article.title}</p>
            <Failure message={historyError} />
            {article.isAdmin ? (
              <label className="knowledge-restore-reason">
                恢复原因
                <Input.TextArea
                  autoComplete="off"
                  aria-label="恢复原因"
                  value={restoreReason}
                  disabled={pending}
                  onChange={(e) => setRestoreReason(e.target.value)}
                />
              </label>
            ) : null}
            {historyBusy ? <p role="status">正在读取历史…</p> : null}
            <div className="knowledge-history-layout">
              <div className="knowledge-history-list" role="group" aria-label="历史版本">
                <h3>历史版本</h3>
                {history?.items.map((v) => (
                  <Button
                    type="text"
                    key={v.id}
                    className={
                      'knowledge-version' + (selected?.id === v.id ? ' knowledge-version-selected' : '')
                    }
                    aria-pressed={selected?.id === v.id}
                    onClick={() => setSelected(v)}
                  >
                    <span className="knowledge-version-label">
                      v{v.number}
                      {history?.page === 1 && v.id === history.items[0]?.id ? (
                        <Tag variant="outlined">当前版本</Tag>
                      ) : null}
                    </span>
                    <span>
                      {v.editor.displayName || '成员'} · {date(v.createdAt)}
                    </span>
                  </Button>
                ))}
                {history ? (
                  <ListPagination
                    page={history.page}
                    totalPages={Math.ceil(history.total / 20)}
                    loading={historyBusy || pending}
                    onPageChange={(p) => {
                      setHistoryBusy(true);
                      setHistoryPage(p);
                    }}
                    label="历史版本分页"
                  />
                ) : null}
              </div>
              <div className="knowledge-history-preview">
                {selected ? (
                  <>
                    <h3>v{selected.number}</h3>
                    <p className="knowledge-author">
                      {selected.editor.displayName || '成员'} · {date(selected.createdAt)}
                    </p>
                    <ArticleBody
                      body={selected.body}
                      bodyFormat={selected.bodyFormat}
                      imageDimensions={selected.imageDimensions}
                    />
                  </>
                ) : null}
              </div>
            </div>
          </Modal>

          <Modal
            title={moderateRemoval ? '违规删除分享' : '删除分享'}
            open={removing}
            centered
            onCancel={() => {
              if (!pending) setRemoving(false);
            }}
            onOk={remove}
            okText="删除分享"
            cancelText="取消"
            confirmLoading={pending}
            okButtonProps={{ danger: true, disabled: pending || (moderateRemoval && !reason.trim()) }}
            cancelButtonProps={{ disabled: pending }}
            mask={{ closable: !pending }}
            closable={!pending}
          >
            <p>确认删除这篇分享？删除后正文和评论将不再展示。</p>
            {moderateRemoval ? (
              <Input.TextArea
                autoComplete="off"
                aria-label="处理原因"
                placeholder="处理原因"
                disabled={pending}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            ) : null}
          </Modal>
        </>
      ) : null}
    </main>
  );
}
