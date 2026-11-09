import type { ReactNode } from 'react';
import DiscussionComments from '../discussion-comments';
export default function AlbumComments({
  albumId,
  photoId,
  commentId,
  changed,
  compact,
  onLockedChange,
  composerActions
}: {
  albumId: string;
  photoId?: string;
  commentId?: string;
  changed?(): void | Promise<void>;
  compact?: boolean;
  onLockedChange?(locked: boolean): void;
  composerActions?: ReactNode;
}) {
  return (
    <DiscussionComments
      key={albumId + ':' + (photoId ?? 'album')}
      scope="album"
      id={albumId}
      photoId={photoId}
      commentId={commentId}
      composerActions={composerActions}
      onChange={changed}
      compact={compact ?? Boolean(photoId)}
      onLockedChange={onLockedChange}
    />
  );
}
