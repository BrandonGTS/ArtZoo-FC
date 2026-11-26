'use client';

import { toBeijingParts } from '@artzoo/domain';
import { ConfigProvider } from 'antd';
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode
} from 'react';
import { CollectionSearch, ListPagination } from '../../../components/collection-controls';
import DailyActionIcon from '../../../components/daily/daily-action-icon';
import DailyToolbarIcon from '../../../components/daily/daily-toolbar-icon';
import OperationMenu from '../../../components/operation-menu';
import { artzooTheme } from '../../../components/providers';
import { stickerLabelText } from '../../../components/stickers/sticker-codec';
import StickerText from '../../../components/stickers/sticker-text';
import PaperModal from '../../../components/ui/paper-modal';
import { useFeedbackMessage } from '../../../components/use-feedback-message';
import homeStyles from '../home/home-preview.module.css';
import PreviewHeader from '../preview-header';
import DailyPreviewComposer from './daily-preview-composer';
import DailyPreviewEditor, { type DailyPreviewSubmission } from './daily-preview-editor';
import styles from './daily-preview.module.css';

type PreviewReply = {
  id: string;
  author: string;
  createdAt: string;
  body: string;
  photos?: number;
  parentId?: string;
  liked?: boolean;
};
type PreviewPost = {
  id: string;
  author: string;
  createdAt: string;
  title?: string;
  body?: string;
  photos?: number;
  replies: readonly PreviewReply[];
  likes: number;
  liked?: boolean;
};

type DeleteTarget = { postId: string; replyId?: string };

const previewMenuItems = [
  { key: 'delete', label: '删除', danger: true, className: styles.dangerMenuAction },
  { key: 'moderate', label: '违规删除', danger: true, className: styles.dangerMenuAction }
];

const POSTS_PER_PAGE = 5;
const graphemeSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : undefined;

const samplePosts: readonly PreviewPost[] = [
  {
    id: 'sample-sunset',
    author: '松枝',
    createdAt: '2026-11-21T18:40:00+08:00',
    body: '海都的晚霞，今天也赶上了。',
    photos: 2,
    replies: [
      { id: 'sunset-1', author: '浅湾', createdAt: '2026-11-21T18:43:00+08:00', body: '今天的云特别好看。' },
      {
        id: 'sunset-2',
        author: '栗子',
        createdAt: '2026-11-21T18:51:00+08:00',
        body: '下次我也去码头等晚霞！'
      }
    ],
    likes: 36
  },
  {
    id: 'sample-walk',
    author: '浅湾',
    createdAt: '2026-11-21T17:20:00+08:00',
    title: '海都散步拍摄手记',
    body: '从码头走到上层甲板，记下三个适合看日落的地方。',
    photos: 1,
    replies: [
      {
        id: 'walk-1',
        author: '澄叶',
        createdAt: '2026-11-21T17:35:00+08:00',
        body: '记下了，下次从码头走一遍。'
      }
    ],
    likes: 24
  },
  {
    id: 'sample-treasure',
    author: '澄叶',
    createdAt: '2026-11-21T16:05:00+08:00',
    body: '今晚有人一起挖宝吗？',
    replies: [
      { id: 'treasure-1', author: '松枝', createdAt: '2026-11-21T16:12:00+08:00', body: '我来，晚一点上线。' }
    ],
    likes: 21
  },
  {
    id: 'sample-lamp',
    author: '栗子',
    createdAt: '2026-11-21T14:30:00+08:00',
    title: '给部队房换了一盏灯',
    body: '试了几种灯光，最后把窗边留给了那盏暖色小灯。',
    photos: 1,
    replies: [
      { id: 'lamp-1', author: '浅湾', createdAt: '2026-11-21T14:44:00+08:00', body: '暖色小灯和窗边很搭。' }
    ],
    likes: 18
  },
  {
    id: 'sample-market',
    author: '浅湾',
    createdAt: '2026-11-21T12:15:00+08:00',
    body: '中午去了一趟格里达尼亚，顺手拍了市集旁的小路。',
    photos: 1,
    replies: [],
    likes: 9
  },
  {
    id: 'sample-fishing',
    author: '澄叶',
    createdAt: '2026-11-21T10:50:00+08:00',
    body: '在湾边钓到一条新鱼，终于补齐了这一页图鉴。',
    replies: [],
    likes: 6
  }
];

function formatPostTime(createdAt: string) {
  const { month, day, hour, minute } = toBeijingParts(createdAt);
  const clock = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
  return `${month}月${day}日 ${clock}`;
}

function PostByline({ author, createdAt }: Pick<PreviewPost, 'author' | 'createdAt'>) {
  return (
    <header className={styles.byline}>
      <div className={styles.person}>
        <span className={styles.authorName}>{author}</span>
        <span className={styles.location}>
          <DailyToolbarIcon kind="server" />
          莫古力·神拳痕
        </span>
      </div>
      <time dateTime={createdAt}>{formatPostTime(createdAt)}</time>
    </header>
  );
}

function postText({ title, body }: PreviewPost) {
  return [title, body].filter(Boolean).join('\n');
}

function excerptStartNearMatch(text: string, { start, end }: { start: number; end: number }) {
  const openingBudget = 16;
  if (end <= openingBudget && text.slice(0, start).split('\n').length <= 2) return 0;

  // Keep the hit near the first line at narrow widths and give long hits more room.
  const contextLimit = Math.max(0, Math.min(6, openingBudget - (end - start)));
  if (!contextLimit || !start) return start;

  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const context = text.slice(lineStart, start);
  const characters = graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(context), ({ segment }) => segment)
    : Array.from(context);
  return start - characters.slice(-contextLimit).join('').length;
}

function PostContent({
  post,
  detail = false,
  searchPattern,
  actions
}: {
  post: PreviewPost;
  detail?: boolean;
  searchPattern?: RegExp;
  actions?: ReactNode;
}) {
  const previewRef = useRef<HTMLParagraphElement>(null);
  const [truncated, setTruncated] = useState(false);
  const { author, createdAt } = post;
  const text = postText(post);
  const readableText = searchPattern ? stickerLabelText(text) : '';
  const highlights =
    searchPattern &&
    Array.from(readableText.matchAll(searchPattern), (match) => ({
      start: match.index,
      end: match.index + match[0].length
    }));
  const firstMatch = highlights?.[0];
  const excerptStart = !detail && firstMatch ? excerptStartNearMatch(readableText, firstMatch) : 0;

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;

    const measure = () => setTruncated(preview.scrollHeight > preview.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(preview);
    document.fonts.addEventListener('loadingdone', measure);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [text, excerptStart]);

  const content = <StickerText text={text} highlights={highlights} excerptStart={excerptStart} />;

  return (
    <div className={styles.copy}>
      <span className={styles.avatar} aria-hidden="true" />
      <PostByline author={author} createdAt={createdAt} />
      {text &&
        (detail ? (
          <p className={styles.detailText}>{content}</p>
        ) : (
          <div className={styles.postExcerpt}>
            <p ref={previewRef} className={styles.postBody}>
              {content}
            </p>
            {(truncated || excerptStart > 0) && (
              <span className={styles.fullPostHint} aria-hidden="true">
                查看全文
              </span>
            )}
          </div>
        ))}
      {actions}
    </div>
  );
}

function PostPhotos({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className={styles.photos} role="img" aria-label={count + ' 张图片占位'}>
      {Array.from({ length: count }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}

type ReplyPanel = {
  id: string;
  open: boolean;
  toggle(): void;
};

type PostInteractions = {
  post: PreviewPost;
  onLike(): void;
  onReply(submission: DailyPreviewSubmission, parentId?: string): void;
  onReplyLike(replyId: string): void;
  onRequestDelete(replyId?: string): void;
  menuDisabled: boolean;
};

function useReplyPanel(initiallyOpen = false): ReplyPanel {
  const id = useId();
  const [open, setOpen] = useState(initiallyOpen);
  return { id, open, toggle: () => setOpen((current) => !current) };
}

function LikeButton({
  count,
  liked,
  label = '点赞',
  onLike
}: {
  count: number;
  liked: boolean;
  label?: string;
  onLike(): void;
}) {
  const countId = useId();

  return (
    <button
      type="button"
      className={styles.cardAction}
      aria-label={label}
      aria-pressed={liked}
      aria-describedby={countId}
      onClick={onLike}
    >
      <DailyActionIcon kind="like" active={liked} />
      <span id={countId}>{count}</span>
    </button>
  );
}

function PostActions({ post, panel, onLike }: { post: PreviewPost; panel: ReplyPanel; onLike(): void }) {
  const liked = post.liked ?? false;

  return (
    <footer className={styles.counts}>
      <button
        type="button"
        className={styles.cardAction}
        aria-label={'回复 ' + post.replies.length}
        aria-expanded={panel.open}
        aria-controls={panel.id}
        onClick={panel.toggle}
      >
        <DailyActionIcon kind="reply" active={panel.open} />
        {post.replies.length}
      </button>
      <LikeButton count={post.likes + Number(liked)} liked={liked} onLike={onLike} />
    </footer>
  );
}

function ReplyItem({
  reply,
  replyTo,
  depth,
  replyCount,
  active,
  onReply,
  onLike,
  onRequestDelete,
  menuDisabled
}: {
  reply: PreviewReply;
  replyTo?: string;
  depth: number;
  replyCount: number;
  active: boolean;
  onReply(submission: DailyPreviewSubmission): void;
  onLike(): void;
  onRequestDelete(): void;
  menuDisabled: boolean;
}) {
  const [editor, setEditor] = useState<'open' | 'collapsed' | null>(null);
  const editorId = useId();
  const replyButton = useRef<HTMLButtonElement>(null);
  const { author, createdAt, body, photos = 0, liked = false } = reply;
  const open = editor === 'open';

  function closeEditor() {
    setEditor(null);
    replyButton.current?.focus();
  }

  return (
    <li
      className={styles.replyItem}
      style={{ '--reply-depth': depth } as CSSProperties}
      data-reply-id={reply.id}
    >
      <span className={styles.avatar} aria-hidden="true" />
      <div className={styles.replyCopy}>
        <div className={styles.replyMenu}>
          <PreviewManagementMenu
            label={author + '的回复管理操作'}
            onRequestDelete={onRequestDelete}
            menuDisabled={menuDisabled}
          />
        </div>
        <PostByline author={author} createdAt={createdAt} />
        {(body || replyTo) && (
          <p>
            {replyTo && <span className={styles.replyTarget}>回复 {replyTo}：</span>}
            <StickerText text={body} />
          </p>
        )}
        <PostPhotos count={photos} />
        <div className={styles.replyActions}>
          <button
            ref={replyButton}
            type="button"
            className={styles.cardAction}
            aria-label={'回复 ' + author + '，' + replyCount + ' 条回复'}
            aria-expanded={open}
            aria-controls={editorId}
            onClick={() => setEditor(open ? 'collapsed' : 'open')}
          >
            <DailyActionIcon kind="reply" active={open} />
            {replyCount}
          </button>
          <LikeButton
            label={'给 ' + author + ' 的回复点赞'}
            count={Number(liked)}
            liked={liked}
            onLike={onLike}
          />
        </div>
      </div>
      <div
        className={styles.replyInlineEditor}
        id={editorId}
        role="group"
        aria-label={'回复 ' + author}
        hidden={!open}
      >
        {editor !== null && (
          <>
            <p className={styles.replyTarget}>回复 {author}</p>
            <DailyPreviewEditor
              variant="reply"
              active={active && open}
              onCancel={closeEditor}
              onPublish={(submission) => {
                onReply(submission);
                closeEditor();
              }}
            />
          </>
        )}
      </div>
    </li>
  );
}

function PostReplies({
  replies,
  panel,
  onReply,
  onReplyLike,
  onRequestDelete,
  menuDisabled
}: Pick<PostInteractions, 'onReply' | 'onReplyLike' | 'onRequestDelete' | 'menuDisabled'> & {
  replies: readonly PreviewReply[];
  panel: ReplyPanel;
}) {
  const [announcement, setAnnouncement] = useState('');
  const replyById = new Map<string, { author: string; depth: number }>();
  const replyCounts = new Map<string, number>();

  for (const { id, author, parentId } of replies) {
    const parent = parentId ? replyById.get(parentId) : undefined;
    replyById.set(id, { author, depth: parent ? parent.depth + 1 : 0 });
    if (parentId) replyCounts.set(parentId, (replyCounts.get(parentId) ?? 0) + 1);
  }

  function publishReply(submission: DailyPreviewSubmission, parentId?: string) {
    onReply(submission, parentId);
    setAnnouncement('回复已发布，共 ' + (replies.length + 1) + ' 条回复。');
  }

  return (
    <section
      className={styles.replySection}
      id={panel.id}
      aria-label="回复区"
      tabIndex={-1}
      hidden={!panel.open}
    >
      <DailyPreviewComposer variant="reply" active={panel.open} onPublish={publishReply} />
      <span className={styles.visuallyHidden} role="status">
        {announcement}
      </span>
      {replies.length > 0 && (
        <ul className={styles.replyList} aria-label="回复列表">
          {replies.map((reply) => (
            <ReplyItem
              key={reply.id}
              reply={reply}
              replyTo={reply.parentId ? replyById.get(reply.parentId)?.author : undefined}
              depth={replyById.get(reply.id)?.depth ?? 0}
              replyCount={replyCounts.get(reply.id) ?? 0}
              active={panel.open}
              onReply={(submission) => publishReply(submission, reply.id)}
              onLike={() => onReplyLike(reply.id)}
              onRequestDelete={() => onRequestDelete(reply.id)}
              menuDisabled={menuDisabled}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PreviewManagementMenu({
  label,
  onRequestDelete,
  menuDisabled
}: {
  label: string;
  onRequestDelete(): void;
  menuDisabled: boolean;
}) {
  return (
    <ConfigProvider
      theme={artzooTheme}
      button={{ autoInsertSpace: false }}
      getPopupContainer={(trigger) => trigger?.closest<HTMLElement>('.ant-modal-container') ?? document.body}
    >
      <OperationMenu
        label={label}
        items={previewMenuItems}
        compositeKeyboard
        onAction={() => onRequestDelete()}
        disabled={menuDisabled}
      />
    </ConfigProvider>
  );
}

function DailyPreviewCard({
  post,
  searchPattern,
  onOpen,
  onLike,
  onReply,
  onReplyLike,
  onRequestDelete,
  menuDisabled
}: PostInteractions & { onOpen(): void; searchPattern?: RegExp }) {
  const panel = useReplyPanel();

  return (
    <article className={styles.card}>
      <button
        className={styles.openPost}
        type="button"
        aria-label={'查看 ' + post.author + ' ' + formatPostTime(post.createdAt) + ' 的分享详情'}
        aria-haspopup="dialog"
        onClick={onOpen}
      />
      <div className={styles.cardMenu}>
        <PreviewManagementMenu
          label={post.author + '的分享管理操作'}
          onRequestDelete={onRequestDelete}
          menuDisabled={menuDisabled}
        />
      </div>
      <PostContent
        post={post}
        searchPattern={searchPattern}
        actions={<PostActions post={post} panel={panel} onLike={onLike} />}
      />
      <PostPhotos count={Math.min(post.photos ?? 0, 2)} />
      <PostReplies
        replies={post.replies}
        panel={panel}
        onReply={onReply}
        onReplyLike={onReplyLike}
        onRequestDelete={onRequestDelete}
        menuDisabled={menuDisabled}
      />
    </article>
  );
}

function cycleDetailFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;

  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const dialog = event.currentTarget.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog || target.closest('[role="dialog"]') !== dialog) return;

  const controls = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex], [contenteditable]'
    )
  ).filter((control) => {
    const canTab =
      control.tabIndex >= 0 ||
      (control.hasAttribute('contenteditable') &&
        !control.hasAttribute('tabindex') &&
        control.isContentEditable);
    return (
      canTab &&
      !control.matches(':disabled') &&
      !control.closest('[inert], [hidden], [aria-hidden="true"]') &&
      control.getClientRects().length > 0 &&
      getComputedStyle(control).visibility === 'visible'
    );
  });
  const first = controls[0];
  const last = controls.at(-1);
  const boundary = event.shiftKey ? first : last;
  const next = event.shiftKey ? last : first;

  if (!next || (target !== boundary && !(event.shiftKey && target === dialog))) return;

  event.preventDefault();
  event.stopPropagation();
  next.focus();
}

function DailyPreviewDetail({
  post,
  searchPattern,
  open,
  onClose,
  onLike,
  onReply,
  onReplyLike,
  onRequestDelete,
  menuDisabled
}: PostInteractions & { open: boolean; onClose(): void; searchPattern?: RegExp }) {
  const panel = useReplyPanel(true);

  return (
    <PaperModal
      title="分享详情"
      width={840}
      open={open}
      onCancel={onClose}
      footer={null}
      keyboard={!menuDisabled}
      focusable={{ trap: !menuDisabled }}
      wrapProps={{
        inert: menuDisabled,
        onKeyDownCapture: open && !menuDisabled ? cycleDetailFocus : undefined
      }}
      destroyOnHidden
      className={homeStyles.previewDialog + ' ' + styles.detailDialog}
      classNames={{
        container: styles.detailFrame,
        header: styles.visuallyHidden,
        body: styles.detailBody
      }}
      styles={{
        container: {
          background: 'var(--cream)',
          paddingBlockStart: '2.5rem',
          paddingInlineStart: 'clamp(0.875rem, 1.5vw, 1.25rem)',
          paddingInlineEnd: '0.75rem'
        },
        close: {
          insetBlockStart: 'var(--detail-control-top)',
          insetInlineEnd: 'var(--detail-control-end)',
          inlineSize: 'var(--detail-control-size)'
        }
      }}
    >
      <div className={styles.detailMenu}>
        <PreviewManagementMenu
          label={post.author + '的分享管理操作'}
          onRequestDelete={onRequestDelete}
          menuDisabled={menuDisabled}
        />
      </div>
      <div
        className={`${styles.postDetail} ${homeStyles.previewScrollbar}`}
        tabIndex={0}
        role="region"
        aria-label="完整分享内容"
      >
        <PostContent post={post} detail searchPattern={searchPattern} />
        <PostPhotos count={post.photos ?? 0} />
        <PostActions post={post} panel={panel} onLike={onLike} />
        <PostReplies
          replies={post.replies}
          panel={panel}
          onReply={onReply}
          onReplyLike={onReplyLike}
          onRequestDelete={onRequestDelete}
          menuDisabled={menuDisabled}
        />
      </div>
    </PaperModal>
  );
}

export default function DailyPreviewFeed() {
  const { notify, contextHolder } = useFeedbackMessage();
  const [posts, setPosts] = useState(samplePosts);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [keyword, setKeyword] = useState('');
  const [publishedCount, setPublishedCount] = useState(0);
  const [detailPostId, setDetailPostId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const postSequence = useRef(0);
  const replySequence = useRef(0);
  const postsListRef = useRef<HTMLUListElement>(null);
  const deleteReturnFocus = useRef<HTMLElement | null>(null);
  const searchPattern = keyword
    ? new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
    : undefined;
  const matchingPosts = searchPattern
    ? posts.filter((post) => stickerLabelText(postText(post)).search(searchPattern) !== -1)
    : posts;
  const totalPages = Math.max(1, Math.ceil(matchingPosts.length / POSTS_PER_PAGE));
  const pageOffset = (page - 1) * POSTS_PER_PAGE;
  const visiblePosts = matchingPosts.slice(pageOffset, pageOffset + POSTS_PER_PAGE);
  const detailPost = posts.find((post) => post.id === detailPostId);

  function search(value: string) {
    setKeyword(value.trim());
    setPage(1);
  }

  function clearSearch() {
    setQuery('');
    search('');
  }

  function publish({ body, photos }: DailyPreviewSubmission) {
    const createdAt = new Date().toISOString();
    const sequence = ++postSequence.current;
    setPosts((current) => [
      { id: 'local-' + sequence, author: '我', createdAt, body, photos, replies: [], likes: 0 },
      ...current
    ]);
    clearSearch();
    setPublishedCount(sequence);
  }

  function requestDelete(postId: string, replyId?: string) {
    const focused = document.activeElement;
    deleteReturnFocus.current = focused instanceof HTMLElement ? focused : null;
    setDeleteTarget({ postId, replyId });
    setDeleteOpen(true);
  }

  function removeReply(postId: string, replyId: string) {
    const post = posts.find((current) => current.id === postId);
    if (!post) return;

    const removed = new Set([replyId]);
    for (const reply of post.replies) {
      if (reply.parentId && removed.has(reply.parentId)) removed.add(reply.id);
    }

    const row = deleteReturnFocus.current?.closest('[data-reply-id]');
    let next = row?.nextElementSibling;
    while (next instanceof HTMLElement && removed.has(next.dataset.replyId ?? '')) {
      next = next.nextElementSibling;
    }
    const neighbor = next ?? row?.previousElementSibling;
    deleteReturnFocus.current =
      neighbor?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]') ??
      row?.closest<HTMLElement>('[aria-label="回复区"]') ??
      null;

    updatePost(postId, (current) => ({
      ...current,
      replies: current.replies.filter((reply) => !removed.has(reply.id))
    }));
    notify('success', '已从预览移除回复');
  }

  function removePost(postId: string) {
    const index = visiblePosts.findIndex((post) => post.id === postId);
    const item = postsListRef.current?.children[index];
    const neighbor = item?.nextElementSibling ?? item?.previousElementSibling;
    deleteReturnFocus.current =
      neighbor?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]') ?? null;
    if (detailPostId === postId) {
      setDetailOpen(false);
      setDetailPostId(null);
    }

    setPosts((current) => current.filter((post) => post.id !== postId));
    const remainingPages = Math.max(1, Math.ceil((matchingPosts.length - 1) / POSTS_PER_PAGE));
    setPage((current) => Math.min(current, remainingPages));
    notify('success', '已从预览移除这条分享');
  }

  function confirmDelete() {
    if (!deleteOpen || !deleteTarget) return;

    const { postId, replyId } = deleteTarget;
    if (replyId) removeReply(postId, replyId);
    else removePost(postId);
    setDeleteOpen(false);
  }

  function restoreDeleteFocus() {
    const target = deleteReturnFocus.current;
    deleteReturnFocus.current = null;
    if (target?.isConnected) target.focus();
    else postsListRef.current?.closest<HTMLElement>('[data-preview-page="daily"]')?.focus();
  }

  function updatePost(id: string, update: (post: PreviewPost) => PreviewPost) {
    setPosts((current) => current.map((post) => (post.id === id ? update(post) : post)));
  }

  function toggleLike(id: string) {
    updatePost(id, (post) => ({ ...post, liked: !post.liked }));
  }

  function toggleReplyLike(postId: string, replyId: string) {
    updatePost(postId, (post) => ({
      ...post,
      replies: post.replies.map((reply) => (reply.id === replyId ? { ...reply, liked: !reply.liked } : reply))
    }));
  }

  function addReply(id: string, { body, photos }: DailyPreviewSubmission, parentId?: string) {
    const reply: PreviewReply = {
      id: 'local-' + ++replySequence.current,
      author: '我',
      createdAt: new Date().toISOString(),
      body,
      photos,
      parentId
    };
    updatePost(id, (post) => {
      const insertion = parentId ? post.replies.findIndex((reply) => reply.id === parentId) + 1 : 0;
      return {
        ...post,
        replies: [...post.replies.slice(0, insertion), reply, ...post.replies.slice(insertion)]
      };
    });
  }

  return (
    <>
      {contextHolder}
      <PreviewHeader announcement="本周六 20:00 公会团本开荒，记得提前上线集合。">
        <div className={homeStyles.hero + ' ' + styles.hero}>
          <h1 className={homeStyles.title + ' ' + styles.title} lang="en">
            Guild <em>Journal</em>
          </h1>
          <p className={homeStyles.subtitle + ' ' + styles.subtitle}>公会日常</p>
          <search
            className={styles.shareSearch}
            aria-label="日常分享"
            onKeyDownCapture={(event) => {
              // Safari can deliver the confirming Enter after compositionend.
              if (event.key === 'Enter' && event.nativeEvent.keyCode === 229) event.stopPropagation();
            }}
          >
            <ConfigProvider theme={artzooTheme}>
              <CollectionSearch
                className={styles.searchField}
                query={query}
                onQueryChange={setQuery}
                onSearch={search}
                onClear={clearSearch}
                searchLabel="搜索分享"
                placeholder="搜索分享"
              />
            </ConfigProvider>
          </search>
        </div>
      </PreviewHeader>
      <DailyPreviewComposer onPublish={publish} />
      <span className={styles.visuallyHidden} role="status">
        {publishedCount > 0 ? `已发布到列表顶部，本次共发布 ${publishedCount} 条分享。` : ''}
      </span>
      <ul ref={postsListRef} className={styles.posts} aria-label="分享列表">
        {visiblePosts.map((post) => (
          <li key={post.id}>
            <DailyPreviewCard
              post={post}
              searchPattern={searchPattern}
              onOpen={() => {
                setDetailPostId(post.id);
                setDetailOpen(true);
              }}
              onLike={() => toggleLike(post.id)}
              onReply={(submission, parentId) => addReply(post.id, submission, parentId)}
              onReplyLike={(replyId) => toggleReplyLike(post.id, replyId)}
              onRequestDelete={(replyId) => requestDelete(post.id, replyId)}
              menuDisabled={deleteOpen}
            />
          </li>
        ))}
      </ul>
      {matchingPosts.length === 0 && (
        <p className={styles.emptyPosts}>{keyword ? '没有找到匹配的分享' : '暂无分享'}</p>
      )}
      <span className={styles.visuallyHidden} role="status">
        {keyword ? `找到 ${matchingPosts.length} 条分享。` : ''}
      </span>
      <ListPagination
        numbered
        label="日常分享分页"
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        getScrollContainer={(navigation) => navigation.closest<HTMLElement>('[data-preview-page="daily"]')}
      />
      <ConfigProvider theme={artzooTheme} button={{ autoInsertSpace: false }}>
        <PaperModal
          title={deleteTarget?.replyId ? '删除回复' : '删除分享'}
          width={440}
          zIndex={1100}
          open={deleteOpen}
          onCancel={() => setDeleteOpen(false)}
          onOk={confirmDelete}
          afterClose={restoreDeleteFocus}
          focusable={{ focusTriggerAfterClose: false }}
          cancelText="取消"
          cancelButtonProps={{ autoFocus: true }}
          okText="删除"
          okButtonProps={{ danger: true, className: styles.confirmDeleteButton }}
          destroyOnHidden
          className={homeStyles.previewDialog}
          styles={{ container: { background: 'var(--cream)' } }}
        >
          <p>
            {deleteTarget?.replyId
              ? '这条回复及其跟帖将从当前预览中移除。'
              : '这条分享及其回复将从当前预览中移除。'}
          </p>
        </PaperModal>
      </ConfigProvider>
      {detailPost && (
        <DailyPreviewDetail
          key={detailPost.id}
          post={detailPost}
          searchPattern={searchPattern}
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
          onLike={() => toggleLike(detailPost.id)}
          onReply={(submission, parentId) => addReply(detailPost.id, submission, parentId)}
          onReplyLike={(replyId) => toggleReplyLike(detailPost.id, replyId)}
          onRequestDelete={(replyId) => requestDelete(detailPost.id, replyId)}
          menuDisabled={deleteOpen}
        />
      )}
    </>
  );
}
