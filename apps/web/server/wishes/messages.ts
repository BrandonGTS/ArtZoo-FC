import { Prisma } from '@artzoo/db';
import type { MessageItem } from '@artzoo/domain';
export function wishMessageSource(accountId: string, includeDeleted = false) {
  return Prisma.sql`SELECT 'wish:'||n.id AS id,n.id AS "sourceId",'wish' AS source,n.kind,
 n."createdAt",n."readAt",n."deletedAt",n."activityId",a.title AS "activityTitle",person."displayName" AS "participantName",
 jsonb_build_object('wishId',w.id,'wishTitle',w.title,'wishDeleted',(w."deletedAt" IS NOT NULL OR w."moderatedAt" IS NOT NULL),'activityCancelled',a."cancelledAt" IS NOT NULL,'commentId',n."commentId",'isReply',parent."authorId"=n."recipientId") AS payload,
 NULL::text[] AS notices,NULL::integer AS "pointsBefore",NULL::integer AS "pointsAfter"
 FROM "WishNotification" n JOIN "Wish" w ON w.id=n."wishId" LEFT JOIN "Activity" a ON a.id=n."activityId"
 LEFT JOIN "WishComment" c ON c.id=n."commentId" LEFT JOIN "Account" person ON person.id=c."authorId" LEFT JOIN "WishComment" parent ON parent.id=c."parentId"
 WHERE n."recipientId"=${accountId} AND (${includeDeleted} OR n."deletedAt" IS NULL)`;
}
export function wishMessageSummary(row: {
  id: string;
  kind: string;
  payload: unknown;
  participantName: string | null;
  activityId: string | null;
  activityTitle: string | null;
  createdAt: Date;
  readAt: Date | null;
}): MessageItem {
  const payload =
      row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : {},
    clean = (v: unknown) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 1000) : '');
  const base = {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null
  };
  if (payload.wishDeleted)
    return { ...base, title: '相关心愿已删除', body: '这条消息对应的心愿已删除。', link: null };
  if (row.kind === 'WISH_INTERACTION') {
    const id = clean(payload.wishId),
      commentId = clean(payload.commentId),
      valid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
    return {
      ...base,
      title: payload.isReply ? '收到心愿回复' : '心愿有新留言',
      body:
        (clean(row.participantName) || '成员') +
        '在「' +
        clean(payload.wishTitle) +
        '」中' +
        (payload.isReply ? '回复了你。' : '留下了新留言。'),
      link:
        valid(id) && valid(commentId)
          ? { href: '/wishes/' + id + '?commentId=' + commentId, label: '查看留言' }
          : null
    };
  }
  if (payload.activityCancelled)
    return {
      ...base,
      title: '相关活动已取消',
      body: '「' + (row.activityTitle ?? '活动') + '」已取消，心愿关联记录仍保留。',
      link: row.activityId ? { href: '/activities/' + row.activityId, label: '查看相关活动' } : null
    };
  return {
    ...base,
    title: '感兴趣的心愿已有相关活动',
    body: '「' + (row.activityTitle ?? '活动') + '」已发布，请自行报名。兴趣不等于报名，也不预留席位。',
    link: row.activityId ? { href: '/activities/' + row.activityId, label: '查看相关活动' } : null
  };
}
export async function updateWishMessage(
  tx: Prisma.TransactionClient,
  id: string,
  accountId: string,
  kind: 'read' | 'delete',
  at: Date
) {
  if (kind === 'read')
    await tx.$executeRaw`UPDATE "WishNotification" SET "readAt"=${at} WHERE id=${id} AND "recipientId"=${accountId} AND "readAt" IS NULL AND "deletedAt" IS NULL`;
  else
    await tx.$executeRaw`UPDATE "WishNotification" SET "deletedAt"=${at} WHERE id=${id} AND "recipientId"=${accountId} AND "deletedAt" IS NULL`;
}
