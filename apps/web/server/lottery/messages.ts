import { Prisma } from '@artzoo/db';
import type { MessageItem } from '@artzoo/domain';
export function lotteryMessageSource(accountId: string, includeDeleted = false) {
  return Prisma.sql`SELECT 'lottery:'||n."messageId" AS id,n."messageId" AS "sourceId",'lottery' AS source,n.kind,
 n."createdAt",n."readAt",n."deletedAt",NULL::text AS "activityId",NULL::text AS "activityTitle",NULL::text AS "participantName",
 n.payload || jsonb_build_object('lotteryId',n."lotteryId",'moderated',l."moderatedAt" IS NOT NULL) AS payload,NULL::text[] AS notices,NULL::integer AS "pointsBefore",NULL::integer AS "pointsAfter"
 FROM "LotteryNotification" n JOIN "Lottery" l ON l.id=n."lotteryId" WHERE n."recipientId"=${accountId} AND n.channel='IN_APP' AND n."simulatedAt" IS NOT NULL AND n."messageId" IS NOT NULL
 AND n.kind IN ('LOTTERY_ENROLLED','LOTTERY_CANCELLED','LOTTERY_WON') AND (${includeDeleted} OR n."deletedAt" IS NULL)`;
}
export function lotteryMessageSummary(row: {
  id: string;
  kind: string;
  payload: unknown;
  createdAt: Date;
  readAt: Date | null;
}): MessageItem {
  const payload =
      row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : {},
    clean = (v: unknown, fallback = '') =>
      typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 1000) : fallback;
  const id = clean(payload.lotteryId),
    title = clean(payload.title, '抽奖'),
    prize = clean(payload.prize, '奖品');
  const headings: Record<string, string> = {
    LOTTERY_ENROLLED: '已自动加入抽奖',
    LOTTERY_CANCELLED: '抽奖已取消',
    LOTTERY_WON: '抽奖中奖通知'
  };
  const bodies: Record<string, string> = {
    LOTTERY_ENROLLED: `你已自动加入「${title}」。`,
    LOTTERY_CANCELLED: `「${title}」已取消。`,
    LOTTERY_WON: `你在「${title}」中获得了「${prize}」。`
  };
  return {
    id: row.id,
    title: headings[row.kind] ?? '抽奖消息',
    body: bodies[row.kind] ?? title,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
    link:
      !payload.moderated && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        ? { href: '/lotteries/' + id, label: '查看抽奖' }
        : null
  };
}
export async function updateLotteryMessage(
  tx: Prisma.TransactionClient,
  id: string,
  accountId: string,
  kind: 'read' | 'delete',
  at: Date
) {
  const field = kind === 'read' ? Prisma.sql`"readAt"` : Prisma.sql`"deletedAt"`;
  await tx.$executeRaw`UPDATE "LotteryNotification" SET ${field}=${at} WHERE "messageId"=${id} AND "recipientId"=${accountId}
 AND channel='IN_APP' AND "simulatedAt" IS NOT NULL AND kind IN ('LOTTERY_ENROLLED','LOTTERY_CANCELLED','LOTTERY_WON') AND ${field} IS NULL AND "deletedAt" IS NULL`;
}
