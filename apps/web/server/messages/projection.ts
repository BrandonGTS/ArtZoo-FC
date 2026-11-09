import { stickerLabelText } from '../../components/stickers/sticker-codec';
import { Prisma } from '@artzoo/db';
import type { MessageActor, MessageCategory, MessageItem, MessageSource } from '@artzoo/domain';
import { memberSelect, memberSummary } from '../members/service';
import { visibleCommentIds } from '../daily/comment-tree';
import {
  documentText,
  documentImages,
  readKnowledgeDocument,
  type BodyFormat
} from '../../content/knowledge-document';
import type { RawMessage } from './service';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const id = (value: unknown): string | null =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
const text = (value: unknown, length = 160): string =>
  typeof value === 'string'
    ? value
        .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, length)
    : '';
const sourceText = (value: unknown): string =>
  text(typeof value === 'string' ? stickerLabelText(value) : value);
export function messageCategory(row: Pick<RawMessage, 'source' | 'kind'>): MessageCategory {
  if (['LIKE', 'COLLECTION'].includes(row.kind)) return 'likes';
  if (
    row.kind === 'COMMENT' ||
    ['album', 'daily', 'knowledge'].includes(row.source) ||
    row.kind === 'WISH_INTERACTION'
  )
    return 'comments';
  if (
    [
      'WISH_INTEREST',
      'REGISTRATION_CREATED',
      'REGISTRATION_WITHDRAWN',
      'SERIES_READY',
      'TEAM_APPLICATION'
    ].includes(row.kind)
  )
    return 'recruitment';
  if (
    row.source === 'team' ||
    row.kind === 'WISH_CONVERTED' ||
    [
      'REGISTRATION_CONFIRMED',
      'ACTIVITY_RESCHEDULED',
      'ACTIVITY_CANCELLED',
      'SERIES_FORMED',
      'ACTIVITY_COMPLETED'
    ].includes(row.kind)
  )
    return 'participation';
  return 'system';
}
export const categoryExpression = Prisma.sql`CASE WHEN kind IN ('LIKE','COLLECTION') THEN 'likes'
 WHEN kind='COMMENT' OR source IN ('album','daily','knowledge') OR kind='WISH_INTERACTION' THEN 'comments'
 WHEN kind IN ('WISH_INTEREST','REGISTRATION_CREATED','REGISTRATION_WITHDRAWN','SERIES_READY','TEAM_APPLICATION') THEN 'recruitment'
 WHEN source='team' OR kind IN ('WISH_CONVERTED','REGISTRATION_CONFIRMED','ACTIVITY_RESCHEDULED','ACTIVITY_CANCELLED','SERIES_FORMED','ACTIVITY_COMPLETED') THEN 'participation'
 ELSE 'system' END`;
function sourceType(row: RawMessage): MessageSource['type'] {
  if (row.source === 'interaction') {
    const type = object(row.payload).sourceType;
    return ['activity', 'daily', 'album', 'knowledge', 'wish'].includes(String(type))
      ? (type as MessageSource['type'])
      : 'system';
  }
  return row.source === 'event'
    ? 'activity'
    : row.source === 'score'
      ? row.activityId
        ? 'activity'
        : 'system'
      : row.source;
}
async function source(tx: Prisma.TransactionClient, row: RawMessage): Promise<MessageSource> {
  const payload = object(row.payload),
    type = sourceType(row),
    commentId = id(payload.commentId);
  const missing: MessageSource = {
    type,
    available: false,
    title: null,
    summary: null,
    thumbnailUrl: null,
    href: null
  };
  const available = (
    title: string | null,
    summary: string | null,
    href: string,
    thumbnailUrl: string | null = null
  ): MessageSource => ({ type, available: true, title, summary, href, thumbnailUrl });
  // These are the same login-only read scopes as their detail APIs. Only existing,
  // nonremoved source fields leave this boundary; notification snapshots are not trusted previews.
  if (type === 'activity') {
    const key = id(payload.sourceId) ?? row.activityId;
    if (!key) return missing;
    const item = await tx.activity.findUnique({
      where: { id: key },
      select: { id: true, title: true, description: true }
    });
    return item ? available(text(item.title), text(item.description), `/activities/${item.id}`) : missing;
  }
  if (type === 'team') {
    const key = typeof payload.teamLink === 'string' ? id(payload.teamLink.split('/')[2]) : null;
    if (!key) return missing;
    const item = await tx.fixedTeam.findUnique({
      where: { id: key },
      select: { name: true, description: true }
    });
    return item ? available(text(item.name), text(item.description), `/teams/${key}`) : missing;
  }
  if (type === 'daily') {
    const key = id(payload.sourceId) ?? id(payload.postId);
    if (!key) return missing;
    const item = await tx.dailyPost.findUnique({
      where: { id: key },
      select: {
        body: true,
        removedAt: true,
        comments: { select: { id: true, parentId: true, removedAt: true, body: true } },
        media: {
          where: { removedAt: null, commentId: commentId ?? null },
          orderBy: { position: 'asc' },
          take: 1,
          select: { id: true }
        }
      }
    });
    if (!item || item.removedAt || (commentId && !visibleCommentIds(item.comments).has(commentId)))
      return missing;
    return available(
      null,
      sourceText(item.comments.find((c) => c.id === commentId)?.body ?? item.body),
      `/daily/${key}${commentId ? '?commentId=' + commentId + '#comment-' + commentId : ''}`,
      item.media[0] ? `/api/daily/media/${item.media[0].id}?variant=thumbnail` : null
    );
  }
  if (type === 'album') {
    const likedPhoto =
      row.source === 'interaction' && row.kind === 'LIKE' && id(payload.sourceId)
        ? await tx.albumPhoto.findUnique({
            where: { id: id(payload.sourceId)! },
            select: { id: true, albumId: true, removedAt: true }
          })
        : null;
    if (row.source === 'interaction' && row.kind === 'LIKE' && (!likedPhoto || likedPhoto.removedAt))
      return missing;
    const photoId = likedPhoto?.id ?? id(payload.photoId),
      key = likedPhoto?.albumId ?? id(payload.sourceId) ?? id(payload.albumId);
    if (!key) return missing;
    const item = await tx.album.findUnique({
      where: { id: key },
      select: {
        name: true,
        description: true,
        removedAt: true,
        comments: { where: { photoId }, select: { id: true, parentId: true, removedAt: true, body: true } },
        commentMedia: {
          where: { commentId: commentId ?? '', removedAt: null },
          orderBy: { position: 'asc' },
          take: 1,
          select: { id: true }
        }
      }
    });
    if (!item || item.removedAt || (commentId && !visibleCommentIds(item.comments).has(commentId)))
      return missing;
    const photo = photoId
      ? await tx.albumPhoto.findFirst({
          where: { id: photoId, albumId: key, removedAt: null },
          select: { id: true, description: true }
        })
      : null;
    if (photoId && !photo) return missing;
    const query = new URLSearchParams(photoId ? { photoId } : { comments: '1' });
    if (commentId) query.set('commentId', commentId);
    return available(
      text(item.name),
      sourceText(
        item.comments.find((c) => c.id === commentId)?.body ?? photo?.description ?? item.description
      ),
      `/albums/${key}?${query}${commentId ? '#comment-' + commentId : ''}`,
      photo
        ? `/api/album-photos/${photo.id}/media?variant=thumbnail`
        : item.commentMedia?.[0]
          ? `/api/albums/${key}/comment-media/${item.commentMedia[0].id}?variant=thumbnail`
          : null
    );
  }
  if (type === 'knowledge') {
    const key = id(payload.sourceId) ?? id(payload.articleId);
    if (!key) return missing;
    const item = await tx.knowledgeArticle.findUnique({
      where: { id: key },
      select: {
        title: true,
        body: true,
        bodyFormat: true,
        removedAt: true,
        images: { select: { id: true } },
        comments: { select: { id: true, parentId: true, removedAt: true, body: true, createdAt: true } }
      }
    });
    if (!item || item.removedAt || (commentId && !visibleCommentIds(item.comments).has(commentId)))
      return missing;
    const comments = item.comments
      .filter((c) => !c.removedAt)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const commentPage = commentId ? Math.floor(comments.findIndex((c) => c.id === commentId) / 10) + 1 : 1;
    const document = readKnowledgeDocument(item.body, item.bodyFormat as BodyFormat),
      image = documentImages(document).find((value) => item.images?.some((image) => image.id === value));
    return available(
      text(item.title),
      sourceText(comments.find((c) => c.id === commentId)?.body ?? documentText(document)),
      `/knowledge/${key}${commentId ? '?commentId=' + commentId + '&commentPage=' + Math.max(1, commentPage) + '#comment-' + commentId : ''}`,
      image ? `/api/knowledge-images/${image}?variant=thumbnail` : null
    );
  }
  if (type === 'wish') {
    const key = id(payload.sourceId) ?? id(payload.wishId);
    if (!key) return missing;
    const item = await tx.wish.findUnique({
      where: { id: key },
      select: {
        title: true,
        body: true,
        deletedAt: true,
        media: {
          where: { removedAt: null, commentId: commentId ?? null },
          orderBy: { position: 'asc' },
          take: 1,
          select: { id: true }
        },
        comments: { where: { id: commentId ?? '' }, select: { body: true } }
      }
    });
    if (!item || item.deletedAt || (commentId && !item.comments.length)) return missing;
    return available(
      text(item.title),
      sourceText(item.comments[0]?.body ?? item.body),
      `/wishes/${key}${commentId ? '?commentId=' + commentId + '#comment-' + commentId : ''}`,
      item.media?.[0] ? `/api/wishes/media/${item.media[0].id}?variant=thumbnail` : null
    );
  }
  if (type === 'lottery') {
    const key = id(payload.lotteryId);
    if (!key) return missing;
    const item = await tx.lottery.findUnique({ where: { id: key }, select: { title: true } });
    return item ? available(text(item.title), null, `/lotteries/${key}`) : missing;
  }
  return { ...missing, available: true };
}
export async function projectMessages(
  tx: Prisma.TransactionClient,
  rows: RawMessage[],
  summary: (row: RawMessage) => MessageItem
): Promise<MessageItem[]> {
  const actorIds = [
    ...new Set(
      rows.flatMap((row) => {
        const actorId = id(object(row.payload).actorId);
        return actorId ? [actorId] : [];
      })
    )
  ];
  const people = actorIds.length
    ? await tx.account.findMany({ where: { id: { in: actorIds } }, select: memberSelect })
    : [];
  const actors = new Map(
    people.map((person) => {
      const member = memberSummary(person);
      return [
        person.id,
        {
          id: person.id,
          name: text(person.displayName) || '成员',
          server: text(person.gameServer) || null,
          avatarUrl: member.avatar?.smallUrl ?? null
        } satisfies MessageActor
      ];
    })
  );
  return Promise.all(
    rows.map(async (row) => {
      const item = summary(row),
        context = await source(tx, row),
        actorId = id(object(row.payload).actorId);
      const actor = actorId ? actors.get(actorId) : null;
      return {
        ...item,
        category: messageCategory(row),
        receivedAt: row.createdAt.toISOString(),
        actor: actor ?? { id: null, name: '系统', server: null, avatarUrl: null },
        source: context,
        ...(!context.available
          ? { title: '相关内容不可访问', body: '原内容已删除或当前不可访问。', link: null }
          : context.href
            ? { link: { href: context.href, label: '查看原内容' } }
            : {})
      };
    })
  );
}
