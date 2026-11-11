import { Prisma } from '@artzoo/db';
import { categoryExpression, projectMessages } from './projection';
import type { MessageCategoryUnread, MessageUnread } from '@artzoo/domain';
import { lotteryMessageSource, lotteryMessageSummary, updateLotteryMessage } from '../lottery/messages';
import { wishMessageSource, wishMessageSummary, updateWishMessage } from '../wishes/messages';
import {
  AccountError,
  invalid,
  messageId,
  messageQuery,
  type MessageItem,
  type MessagePage,
  type MessageRead,
  type MessageDelete,
  type MessagePreview
} from '@artzoo/domain';
import { ActivityService } from '../activities/service';
export interface RawMessage {
  id: string;
  sourceId: string;
  source: 'event' | 'score' | 'team' | 'album' | 'knowledge' | 'daily' | 'wish' | 'lottery' | 'interaction';
  kind: string;
  createdAt: Date;
  readAt: Date | null;
  deletedAt: Date | null;
  activityId: string | null;
  activityTitle: string | null;
  participantName: string | null;
  payload: unknown;
  notices: string[] | null;
  pointsBefore: number | null;
  pointsAfter: number | null;
}
const supported = [
  'REGISTRATION_CONFIRMED',
  'SERIES_READY',
  'SERIES_FORMED',
  'REGISTRATION_CREATED',
  'REGISTRATION_WITHDRAWN',
  'ACTIVITY_RESCHEDULED',
  'ACTIVITY_CANCELLED',
  'ACTIVITY_PENALTY',
  'ACTIVITY_SCORE_CORRECTED',
  'ATTENDANCE_APPEAL_RESULT',
  'PENALTY_APPEAL_RESULT',
  'ACTIVITY_COMPLETED'
];
function sources(accountId: string, includeDeleted = false) {
  return Prisma.sql`SELECT lm.id,lm."sourceId",lm.source,lm.kind,n."simulatedAt" AS "createdAt",lm."readAt",lm."deletedAt",lm."activityId",lm."activityTitle",lm."participantName",lm.payload,lm.notices,lm."pointsBefore",lm."pointsAfter" FROM (${lotteryMessageSource(accountId, includeDeleted)}) lm JOIN "LotteryNotification" n ON n."messageId"=lm."sourceId" UNION ALL SELECT wm.id,wm."sourceId",wm.source,wm.kind,wm."createdAt",wm."readAt",wm."deletedAt",wm."activityId",wm."activityTitle",wm."participantName",wm.payload || jsonb_build_object('actorId',COALESCE(c."authorId",conv."actorId")) AS payload,wm.notices,wm."pointsBefore",wm."pointsAfter" FROM (${wishMessageSource(accountId, includeDeleted)}) wm LEFT JOIN "WishComment" c ON c.id=wm.payload->>'commentId' LEFT JOIN "WishConversion" conv ON conv."wishId"=wm.payload->>'wishId' UNION ALL SELECT 'event:' || e.id AS id, e.id AS "sourceId", 'event' AS source, e.kind::text AS kind,
 (SELECT d."deliveredAt" FROM "ActivityMockDelivery" d WHERE d."eventId"=e.id) AS "createdAt", e."messageReadAt" AS "readAt", e."messageDeletedAt" AS "deletedAt", e."activityId", a.title AS "activityTitle", p."displayName" AS "participantName",
 COALESCE(e.payload,'{}'::jsonb) || jsonb_build_object('actorId',CASE
 WHEN e.kind::text IN ('REGISTRATION_CREATED','REGISTRATION_WITHDRAWN') THEN reg."accountId"
 WHEN e.kind::text='ATTENDANCE_APPEAL_RESULT' THEN (SELECT ap."decidedById" FROM "ActivityAttendanceAppeal" ap WHERE ap.id=e.payload->>'appealId')
 WHEN e.kind::text='PENALTY_APPEAL_RESULT' THEN (SELECT ap."decidedById" FROM "ActivityPenaltyAppeal" ap WHERE ap.id=e.payload->>'appealId')
 ELSE e.payload->>'actorId' END) AS payload, NULL::text[] AS notices, NULL::integer AS "pointsBefore", NULL::integer AS "pointsAfter"
 FROM "ActivityOutbox" e JOIN "Activity" a ON a.id=e."activityId"
 LEFT JOIN "ActivityRegistration" reg ON reg.id=e."registrationId" LEFT JOIN "Account" p ON p.id=reg."accountId"
 WHERE e."recipientId"=${accountId} AND (${includeDeleted} OR e."messageDeletedAt" IS NULL) AND e.channel='IN_APP' AND e.kind::text IN (${Prisma.join(supported)})
 AND EXISTS (SELECT 1 FROM "ActivityMockDelivery" d WHERE d."eventId"=e.id)
 UNION ALL
 SELECT 'team:' || n.id, n.id, 'team', n.kind, n."simulatedAt" AS "createdAt", n."messageReadAt", n."messageDeletedAt", NULL::text, NULL::text, NULL::text,
 n.payload, NULL::text[], NULL::integer, NULL::integer
 FROM "TeamNotification" n
 WHERE n."recipientId"=${accountId} AND (${includeDeleted} OR n."messageDeletedAt" IS NULL) AND n.channel='IN_APP' AND n."simulatedAt" IS NOT NULL
 UNION ALL
 SELECT 'album:' || n.id, n.id, 'album', n.kind, n."createdAt", n."readAt", n."messageDeletedAt", NULL::text, NULL::text, p."displayName",
 jsonb_build_object('albumId',n."albumId",'photoId',n."photoId",'albumName',a.name,'actorId',c."authorId",'commentId',n."commentId"), NULL::text[], NULL::integer, NULL::integer
 FROM "AlbumNotification" n JOIN "Album" a ON a.id=n."albumId"
 JOIN "AlbumComment" c ON c.id=n."commentId" JOIN "Account" p ON p.id=c."authorId"
 WHERE n."recipientId"=${accountId} AND (${includeDeleted} OR n."messageDeletedAt" IS NULL) AND n.kind='ALBUM_INTERACTION'
 UNION ALL
 SELECT 'knowledge:' || n.id,n.id,'knowledge','KNOWLEDGE_INTERACTION',n."createdAt",n."messageReadAt",n."messageDeletedAt",NULL::text,NULL::text,p."displayName",
 jsonb_build_object('articleId',a.id,'articleTitle',a.title,'articleRemoved',a."removedAt" IS NOT NULL,'commentRemoved',c."removedAt" IS NOT NULL,'actorId',c."authorId",'commentId',n."commentId"),NULL::text[],NULL::integer,NULL::integer
 FROM "KnowledgeNotification" n JOIN "KnowledgeComment" c ON c.id=n."commentId" JOIN "KnowledgeArticle" a ON a.id=c."articleId" JOIN "Account" p ON p.id=c."authorId"
 WHERE n."recipientId"=${accountId} AND (${includeDeleted} OR n."messageDeletedAt" IS NULL)
 UNION ALL
 SELECT 'daily:' || n.id,n.id,'daily',n.kind,n."createdAt",n."readAt",n."deletedAt",NULL::text,NULL::text,person."displayName",
 jsonb_build_object('postId',p.id,'postRemoved',p."removedAt" IS NOT NULL,'commentRemoved',c."removedAt" IS NOT NULL,'actorId',COALESCE(c."authorId",p."authorId"),'commentId',n."commentId"),NULL::text[],NULL::integer,NULL::integer
 FROM "DailyNotification" n JOIN "DailyPost" p ON p.id=n."postId" LEFT JOIN "DailyComment" c ON c.id=n."commentId" JOIN "Account" person ON person.id=COALESCE(c."authorId",p."authorId")
 WHERE n."recipientId"=${accountId} AND (${includeDeleted} OR n."deletedAt" IS NULL)
 UNION ALL
 SELECT 'interaction:' || n.id,n.id,'interaction',n.kind,n."createdAt",n."readAt",n."deletedAt",CASE WHEN n."sourceType"='activity' THEN n."sourceId" ELSE NULL END,NULL::text,person."displayName",
 jsonb_build_object('sourceType',n."sourceType",'sourceId',n."sourceId",'commentId',n."commentId",'actorId',n."actorId",
 'photoId',CASE WHEN n."sourceType"='album' THEN (SELECT c."photoId" FROM "AlbumComment" c WHERE c.id=n."commentId") ELSE NULL END),NULL::text[],NULL::integer,NULL::integer
 FROM "MessageNotification" n LEFT JOIN "Account" person ON person.id=n."actorId"
 WHERE n."recipientId"=${accountId} AND (${includeDeleted} OR n."deletedAt" IS NULL)
 UNION ALL
 SELECT 'score:'  || s.id, s.id, 'score', 'SCORE_NOTICE', s."createdAt", s."messageReadAt", s."messageDeletedAt", a.id, a.title, NULL::text,
 NULL::jsonb, s.notices, s."pointsBefore", s."pointsAfter" FROM "ActivityScoreChange" s
 LEFT JOIN "ActivityPenalty" p ON p.id=s."penaltyId" LEFT JOIN "ActivityCompletion" c ON c.id=s."completionId"
 LEFT JOIN "Activity" a ON a.id=COALESCE(p."activityId",c."activityId")
 WHERE s."accountId"=${accountId} AND (${includeDeleted} OR s."messageDeletedAt" IS NULL) AND s.notices && ARRAY['POINTS_CHANGED','RESTRICTION_STARTED','RESTRICTION_ENDED']::text[]`;
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const clean = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 1000) : fallback;
const number = (value: unknown) => (Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : '—');
export function messageSummary(row: RawMessage): MessageItem {
  if (row.source === 'wish') return wishMessageSummary(row);
  if (row.source === 'lottery') return lotteryMessageSummary(row);
  if (row.source === 'interaction') {
    const labels: Record<string, string> = {
      COMMENT: '回复了你的内容',
      LIKE: '赞了你的内容',
      COLLECTION: '收藏了你的内容',
      WISH_INTEREST: '对你的心愿感兴趣',
      REGISTRATION_CREATED: '报名了你发起的活动'
    };
    const action = labels[row.kind] ?? '有与你相关的更新';
    return {
      id: row.id,
      title: action,
      body: action + '。',
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
      link: null
    };
  }
  const payload = record(row.payload),
    title = clean(payload.activityTitle, row.activityTitle ?? '活动');
  let heading = '',
    body = title;
  let link = row.activityId ? { href: `/activities/${row.activityId}`, label: '查看活动' } : null;
  if (row.source === 'knowledge' || row.source === 'daily') {
    const knowledge = row.source === 'knowledge',
      value = knowledge ? payload.articleId : payload.postId;
    const target =
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
        ? value
        : null;
    const removed = knowledge ? payload.articleRemoved === true : payload.postRemoved === true,
      name = clean(row.participantName, '成员');
    return {
      id: row.id,
      title: knowledge ? '收到内容分享互动' : row.kind === 'MENTION' ? '有人在动态中提及你' : '收到动态评论',
      body: removed
        ? '相关内容已删除。'
        : payload.commentRemoved === true
          ? '相关评论已删除。'
          : knowledge
            ? `${name}在「${clean(payload.articleTitle, '内容分享')}」中与你互动。`
            : row.kind === 'MENTION'
              ? `${name}在动态中提及了你。`
              : `${name}评论或回复了与你相关的动态。`,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
      link:
        target && !removed
          ? {
              href: `/${knowledge ? 'knowledge' : 'daily'}/${target}`,
              label: knowledge ? '查看文章' : '查看动态'
            }
          : null
    };
  }
  if (row.source === 'album') {
    const albumId =
      typeof payload.albumId === 'string' && /^[0-9a-f-]{36}$/i.test(payload.albumId)
        ? payload.albumId
        : null;
    const photoId =
      typeof payload.photoId === 'string' && /^[0-9a-f-]{36}$/i.test(payload.photoId)
        ? payload.photoId
        : null;
    return {
      id: row.id,
      title: '收到相册互动',
      body: `${clean(row.participantName, '成员')}在「${clean(payload.albumName, '相册')}」中与你互动。`,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
      link: albumId
        ? {
            href: `/albums/${albumId}${photoId ? '?photoId=' + photoId : '?comments=1'}`,
            label: photoId ? '查看照片' : '查看相册'
          }
        : null
    };
  }
  if (row.source === 'team') {
    const teamName = clean(payload.teamName, '固定队');
    const labels: Record<string, string> = {
      TEAM_MEMBER_LEFT: '固定队成员已离队',
      TEAM_MEMBER_REMOVED: '你已被移出固定队',
      TEAM_DISSOLVED: '固定队已解散',
      TEAM_SESSION_LEAVE: '固定队本场已记录请假',
      TEAM_SESSION_SUBSTITUTE: '固定队本场已安排临补',
      TEAM_JOINED: '你已加入固定队',
      TEAM_APPLICATION: '收到固定队入队申请',
      TEAM_ACCEPTED: '入队申请已接受',
      TEAM_REJECTED: '入队申请已拒绝',
      TEAM_SEAT_FILLED: '席位已由其他成员加入',
      TEAM_RECRUITMENT_ENDED: '入队申请已结束',
      TEAM_SCHEDULE_PROPOSED: '固定队有待确认排期',
      TEAM_SCHEDULE_CHANGED: '固定队排期已变更',
      TEAM_FEEDBACK: '固定队成员更新了反馈',
      TEAM_SCHEDULE_CONFIRMED: '固定队排期已确认',
      TEAM_SCHEDULE_CANCELLED: '固定队本场排期已取消'
    };
    const href =
      typeof payload.teamLink === 'string' && /^\/teams\/[0-9a-f-]{36}$/i.test(payload.teamLink)
        ? payload.teamLink
        : null;
    const formatTime = (value: unknown) =>
      typeof value === 'string' && Number.isFinite(Date.parse(value))
        ? new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
          }).format(new Date(value))
        : null;
    const starts = formatTime(payload.startsAt),
      ends = formatTime(payload.endsAt),
      period = starts && ends ? `${starts}–${ends}` : '本场';
    const participant = clean(payload.participantName, '队员'),
      position =
        typeof payload.position === 'number'
          ? (['MT', 'ST', 'H1', 'H2', 'D1', 'D2', 'D3', 'D4'][payload.position] ?? '席位')
          : '席位';
    const bodies: Record<string, string> = {
      TEAM_RECRUITMENT_ENDED: '的招募已结束，本次入队申请已结束。',
      TEAM_SEAT_FILLED: '的申请席位已由其他成员加入，本次申请已结束。',
      TEAM_MEMBER_LEFT: `的${participant}已离队，${position}席位待补位。`,
      TEAM_MEMBER_REMOVED: '已将你移出队伍，历史参与记录保留。',
      TEAM_DISSOLVED: '已解散，未开始的排期已取消。',
      TEAM_SESSION_LEAVE: `${period}的${position}队员${participant}已记录请假。`,
      TEAM_SESSION_SUBSTITUTE: `${period}的${position}席位已安排${participant}临时补位。`,
      TEAM_SCHEDULE_PROPOSED: `拟定了${period}的排期，请反馈能否参加。`,
      TEAM_SCHEDULE_CHANGED: `的场次已调整为${period}，请重新反馈。`,
      TEAM_SCHEDULE_CONFIRMED: `已确认${period}的排期。`,
      TEAM_SCHEDULE_CANCELLED: `${period}的排期已取消。`
    };
    return {
      id: row.id,
      title: labels[row.kind] ?? '固定队消息',
      body: `「${teamName}」${bodies[row.kind] ?? '有与你相关的更新。'}`,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
      link: href ? { href, label: '查看队伍' } : null
    };
  }
  switch (row.kind) {
    case 'REGISTRATION_CONFIRMED':
      heading = '报名成功';
      body = '你已报名「' + title + '」。';
      break;
    case 'SERIES_READY':
      heading = '长期活动满员，等待成团确认';
      body = '「' + title + '」已满员，请在首期开场前确认成团。';
      break;
    case 'SERIES_FORMED':
      heading = '长期活动已成团';
      body = '「' + title + '」已成团，请按各期安排参加。';
      break;
    case 'REGISTRATION_CREATED':
      heading = '有人报名了你发起的活动';
      body = `${clean(row.participantName, '成员')}报名了「${title}」。`;
      break;
    case 'REGISTRATION_WITHDRAWN':
      heading = '有人退出了你发起的活动';
      body = `${clean(row.participantName, '成员')}退出了「${title}」。`;
      break;
    case 'ACTIVITY_RESCHEDULED':
      heading = payload.seriesId ? '长期活动本期已改期' : '你报名的活动已改期';
      body = payload.seriesId
        ? `「${title}」第${number(payload.periodNumber)}期的时间已调整，其他期次保持原计划。`
        : `「${title}」的时间已调整，请查看最新安排。`;
      break;
    case 'ACTIVITY_CANCELLED':
      if (payload.reason === 'SERIES_AGREED_CANCEL') {
        heading = '长期活动本期已取消';
        body = `「${title}」第${number(payload.periodNumber)}期已协商取消，后续期次按原计划举行。`;
      } else {
        heading = '你报名的活动已取消';
        body = `「${title}」已取消。`;
      }
      break;
    case 'ACTIVITY_PENALTY':
      heading = '活动处罚已记录';
      body = `「${title}」${payload.reason === 'NO_SHOW' ? '未到场' : payload.reason === 'LATE_CANCELLATION' ? '临近取消' : '临近退出'}记${number(payload.points)}点，当前${number(payload.totalPoints)}点。`;
      break;
    case 'ACTIVITY_SCORE_CORRECTED':
      heading = '活动记录与点数已更正';
      body = `「${title}」的记录已更正，当前${number(payload.points)}点。`;
      break;
    case 'ACTIVITY_COMPLETED':
      heading = '活动正常完成';
      body = `「${title}」已完成，当前${number(payload.points)}点。`;
      break;
    case 'ATTENDANCE_APPEAL_RESULT':
      heading = '你的到场申诉已处理';
      body = `「${title}」的申诉${payload.result === 'APPROVE' ? '已通过' : '已驳回'}。`;
      if (link) link.label = '查看申诉';
      break;
    case 'PENALTY_APPEAL_RESULT':
      heading = '你的处罚申诉已处理';
      body = `「${title}」的申诉${payload.result === 'APPROVE' ? '已通过' : '已驳回'}，当前${number(payload.points)}点。`;
      link = { href: '/me/activity-penalties', label: '查看申诉' };
      break;
    case 'SCORE_NOTICE': {
      const notices = row.notices ?? [];
      heading = notices.includes('RESTRICTION_ENDED')
        ? '活动限制已解除'
        : notices.includes('RESTRICTION_STARTED')
          ? '活动参与已受限制'
          : '活动点数已变化';
      body = `当前${number(row.pointsAfter)}点。${notices.includes('RESTRICTION_ENDED') ? '可按条件报名和发起活动。' : notices.includes('RESTRICTION_STARTED') ? '暂不能新报名或发起活动，已有报名与已发起活动保留。' : ''}`;
      break;
    }
    default:
      throw new Error('Unsupported inbox message');
  }
  return {
    id: row.id,
    title: heading,
    body,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
    link
  };
}
const missing = () => new AccountError('NOT_FOUND', '消息不存在', 404);
export class MessageService extends ActivityService {
  private async finishWrite(
    tx: Prisma.TransactionClient,
    token: string | null | undefined,
    actor: Awaited<ReturnType<MessageService['auth']['requireAccount']>>
  ) {
    const fresh = await this.auth.requireAccount(tx, token);
    if (
      fresh.id !== actor.id ||
      fresh.accountId !== actor.accountId ||
      fresh.account.membership !== actor.account.membership ||
      fresh.account.adminRole !== actor.account.adminRole ||
      fresh.expiresAt <= this.auth.now()
    )
      throw new AccountError('UNAUTHENTICATED', '请先登录', 401);
  }
  private async counts(
    tx: Prisma.TransactionClient,
    accountId: string
  ): Promise<MessageUnread & { categoryUnread: MessageCategoryUnread }> {
    const rows = await tx.$queryRaw<
      Array<{ category: keyof MessageCategoryUnread; unread: bigint }>
    >`SELECT ${categoryExpression} AS category,count(*) FILTER (WHERE "readAt" IS NULL) AS unread FROM (${sources(accountId)}) messages GROUP BY 1`;
    const categoryUnread: MessageCategoryUnread = {
      comments: 0,
      likes: 0,
      recruitment: 0,
      participation: 0,
      system: 0
    };
    for (const row of rows) categoryUnread[row.category] = Number(row.unread);
    return {
      unreadCount: Object.values(categoryUnread).reduce((a, b) => a + b, 0),
      systemUnreadCount: categoryUnread.system,
      categoryUnread
    };
  }
  async unread(token?: string | null) {
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.auth.requireAccount(tx, token);
        return this.counts(tx, actor.accountId);
      },
      { isolationLevel: 'RepeatableRead' }
    );
  }
  async inbox(url: URL, token?: string | null): Promise<MessagePage> {
    const { scope, category, page: requested } = messageQuery(url);
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.auth.requireAccount(tx, token),
          counts = await this.counts(tx, actor.accountId);
        const [count] = await tx.$queryRaw<
          Array<{ total: bigint }>
        >`SELECT count(*) AS total FROM (${sources(actor.accountId)}) messages WHERE ${categoryExpression}=${category} AND (${scope}='all' OR "readAt" IS NULL)`;
        const total = Number(count!.total),
          pageSize = 10,
          totalPages = Math.ceil(total / pageSize),
          page = Math.min(requested, Math.max(1, totalPages));
        const rows = await tx.$queryRaw<
          RawMessage[]
        >`SELECT * FROM (${sources(actor.accountId)}) messages WHERE ${categoryExpression}=${category} AND (${scope}='all' OR "readAt" IS NULL) ORDER BY "createdAt" DESC,id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
        const items = await projectMessages(tx, rows, messageSummary);
        return {
          items,
          scope,
          category,
          page,
          pageSize,
          total,
          totalPages,
          ...counts,
          serverNow: this.auth.now().toISOString()
        };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
  }
  async preview(token?: string | null): Promise<MessagePreview> {
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.auth.requireAccount(tx, token);
        const rows = await tx.$queryRaw<
          RawMessage[]
        >`SELECT * FROM (${sources(actor.accountId)}) messages WHERE "readAt" IS NULL ORDER BY "createdAt" DESC,id DESC LIMIT 5`;
        return {
          items: await projectMessages(tx, rows, messageSummary),
          ...(await this.counts(tx, actor.accountId))
        };
      },
      { isolationLevel: 'RepeatableRead' }
    );
  }
  async remove(key: string, body: Record<string, unknown>, token?: string | null): Promise<MessageDelete> {
    const input = messageId(key);
    if (Object.keys(body).length) invalid('message', '请求包含不允许的字段');
    const canonical = input.source + ':' + input.id,
      actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`message-delete:${actor.accountId}`, 120, 900);
    return this.auth.transaction(async (tx) => {
      await this.actorLocked(tx, token, actor);
      const [row] = await tx.$queryRaw<
        RawMessage[]
      >`SELECT * FROM (${sources(actor.accountId, true)}) messages WHERE id=${canonical}`;
      if (!row) throw missing();
      const deletedAt = row.deletedAt ?? this.auth.now();
      if (!row.deletedAt) {
        if (input.source === 'interaction')
          await tx.messageNotification.updateMany({
            where: { id: input.id, recipientId: actor.accountId, deletedAt: null },
            data: { deletedAt }
          });
        else if (input.source === 'event')
          await tx.activityOutbox.updateMany({
            where: { id: input.id, recipientId: actor.accountId, messageDeletedAt: null },
            data: { messageDeletedAt: deletedAt }
          });
        else if (input.source === 'team')
          await tx.teamNotification.updateMany({
            where: { id: input.id, recipientId: actor.accountId, messageDeletedAt: null },
            data: { messageDeletedAt: deletedAt }
          });
        else if (input.source === 'album')
          await tx.albumNotification.updateMany({
            where: { id: input.id, recipientId: actor.accountId, messageDeletedAt: null },
            data: { messageDeletedAt: deletedAt }
          });
        else if (input.source === 'knowledge')
          await tx.knowledgeNotification.updateMany({
            where: { id: input.id, recipientId: actor.accountId, messageDeletedAt: null },
            data: { messageDeletedAt: deletedAt }
          });
        else if (input.source === 'daily')
          await tx.dailyNotification.updateMany({
            where: { id: input.id, recipientId: actor.accountId, deletedAt: null },
            data: { deletedAt }
          });
        else if (input.source === 'wish')
          await updateWishMessage(tx, input.id, actor.accountId, 'delete', deletedAt);
        else if (input.source === 'lottery')
          await updateLotteryMessage(tx, input.id, actor.accountId, 'delete', deletedAt);
        else
          await tx.activityScoreChange.updateMany({
            where: { id: input.id, accountId: actor.accountId, messageDeletedAt: null },
            data: { messageDeletedAt: deletedAt }
          });
      }
      const counts = await this.counts(tx, actor.accountId);
      await this.finishWrite(tx, token, actor);
      return { id: canonical, deletedAt: deletedAt.toISOString(), ...counts };
    });
  }
  async markRead(key: string, body: Record<string, unknown>, token?: string | null): Promise<MessageRead> {
    const input = messageId(key);
    if (Object.keys(body).length) invalid('message', '请求包含不允许的字段');
    const canonical = input.source + ':' + input.id,
      actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`message-read:${actor.accountId}`, 120, 900);
    return this.auth.transaction(async (tx) => {
      await this.actorLocked(tx, token, actor);
      const [row] = await tx.$queryRaw<
        RawMessage[]
      >`SELECT * FROM (${sources(actor.accountId)}) messages WHERE id=${canonical}`;
      if (!row) throw missing();
      const readAt = row.readAt ?? this.auth.now();
      if (!row.readAt) {
        if (input.source === 'interaction')
          await tx.messageNotification.updateMany({
            where: { id: input.id, recipientId: actor.accountId, readAt: null, deletedAt: null },
            data: { readAt }
          });
        else if (input.source === 'event')
          await tx.activityOutbox.updateMany({
            where: { id: input.id, recipientId: actor.accountId, messageReadAt: null },
            data: { messageReadAt: readAt }
          });
        else if (input.source === 'team')
          await tx.teamNotification.updateMany({
            where: { id: input.id, recipientId: actor.accountId, messageReadAt: null },
            data: { messageReadAt: readAt }
          });
        else if (input.source === 'album')
          await tx.albumNotification.updateMany({
            where: { id: input.id, recipientId: actor.accountId, readAt: null },
            data: { readAt }
          });
        else if (input.source === 'knowledge')
          await tx.knowledgeNotification.updateMany({
            where: { id: input.id, recipientId: actor.accountId, messageReadAt: null },
            data: { messageReadAt: readAt }
          });
        else if (input.source === 'daily')
          await tx.dailyNotification.updateMany({
            where: { id: input.id, recipientId: actor.accountId, readAt: null },
            data: { readAt }
          });
        else if (input.source === 'wish')
          await updateWishMessage(tx, input.id, actor.accountId, 'read', readAt);
        else if (input.source === 'lottery')
          await updateLotteryMessage(tx, input.id, actor.accountId, 'read', readAt);
        else
          await tx.activityScoreChange.updateMany({
            where: { id: input.id, accountId: actor.accountId, messageReadAt: null },
            data: { messageReadAt: readAt }
          });
      }
      const counts = await this.counts(tx, actor.accountId);
      await this.finishWrite(tx, token, actor);
      return { id: canonical, readAt: readAt.toISOString(), ...counts };
    });
  }
}
