'use client';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import DailyComments from './daily/daily-comments';
import { ListPagination } from './collection-controls';
import type { DiscussionTransport } from './daily/discussion-transport';
import './daily/daily.css';
import './discussion-comments.css';

export default function DiscussionComments({
  scope,
  id,
  photoId,
  commentId,
  onChange,
  compact = false,
  onLockedChange,
  composerActions
}: {
  scope: 'wish' | 'album';
  id: string;
  photoId?: string;
  commentId?: string;
  onChange?(): Promise<void> | void;
  compact?: boolean;
  onLockedChange?(locked: boolean): void;
  composerActions?: ReactNode;
}) {
  const [page, setPage] = useState(1),
    [pages, setPages] = useState(1),
    [focused, setFocused] = useState(Boolean(commentId));
  const [commentsLoading, setCommentsLoading] = useState(true);
  const transport = useMemo<DiscussionTransport>(() => {
    if (scope === 'wish') {
      const params = new URLSearchParams({ rootPage: String(page) });
      if (focused && commentId) params.set('commentId', commentId);
      return {
        listUrl: `/api/wishes/${id}/comments?${params}`,
        createUrl: `/api/wishes/${id}/comments`,
        uploadUrl: '/api/wishes/upload'
      };
    }
    const params = new URLSearchParams({ all: '1' });
    if (photoId) params.set('photoId', photoId);
    return {
      listUrl: `/api/albums/${id}/comments?${params}`,
      createUrl: `/api/albums/${id}/comments`,
      uploadUrl: `/api/albums/${id}/comment-upload`,
      scopeBody: { photoId: photoId ?? null },
      removeMethod: 'PATCH',
      removeUrl: (value) => `/api/album-comments/${value}`,
      moderateUrl: (value) => `/api/album-comments/${value}`
    };
  }, [scope, id, photoId, page, focused, commentId]);
  const pageInfo = useCallback((current: number, count: number) => {
    setPage(current);
    setPages(count);
  }, []);
  return (
    <div className={'discussion-comments' + (compact ? ' discussion-comments-compact' : '')}>
      <DailyComments
        postId={id}
        variant="home"
        transport={transport}
        composerMode={compact ? 'folding-bottom' : 'bottom'}
        deferComposerUntilOpen={!compact}
        composerActions={composerActions}
        onPageInfo={pageInfo}
        onLoadingChange={setCommentsLoading}
        focusCommentId={focused ? commentId : undefined}
        onChange={async () => {
          await onChange?.();
        }}
        onLockedChange={onLockedChange}
      />
      {scope === 'wish' && pages > 1 ? (
        <ListPagination
          page={page}
          totalPages={pages}
          loading={commentsLoading}
          onPageChange={(value) => {
            setCommentsLoading(true);
            setFocused(false);
            setPage(value);
          }}
          label="心愿留言分页"
        />
      ) : null}
    </div>
  );
}
