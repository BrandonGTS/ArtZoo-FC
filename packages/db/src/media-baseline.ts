import type { Prisma } from './generated/prisma/client.js';

/** Maintenance only. Caller holds this transaction through disk checks and baseline initialization. */
export async function lockEmptyMediaBaselineTarget(tx: Prisma.TransactionClient, database: string) {
  const [target] = await tx.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (target?.name !== database) throw Error('MEDIA_BASELINE_TARGET_MISMATCH');
  // Includes budget-disabled writers, embedded lottery media and database-resident quick icons.
  // NOWAIT rejects active writes and competing initializers instead of waiting behind production work.
  await tx.$executeRaw`LOCK TABLE "MediaBudgetState", "MediaDailyBudget", "MediaUploadReceipt",
    "MediaStoredComponent", "MediaRetirementIntent", "MediaStorageCredit", "AvatarAsset",
    "AlbumPhoto", "AlbumCommentMedia", "DailyMedia", "WishMedia", "KnowledgeImage",
    "OfficialEventImage", "Lottery", "ResourceLink" IN SHARE ROW EXCLUSIVE MODE NOWAIT`;
  const state = await tx.mediaBudgetState.findUnique({ where: { id: 'global' } });
  return state;
}

export async function assertEmptyMediaBaselineTarget(tx: Prisma.TransactionClient) {
  // Even terminal/zero-byte receipts and zero daily rows are evidence of previous use.
  const rows = await Promise.all([
    tx.mediaBudgetState.findFirst({ where: { id: { not: 'global' } }, select: { id: true } }),
    tx.mediaDailyBudget.findFirst({ select: { accountId: true } }),
    tx.mediaUploadReceipt.findFirst({ select: { scope: true } }),
    tx.mediaStoredComponent.findFirst({ select: { id: true } }),
    tx.mediaRetirementIntent.findFirst({ select: { id: true } }),
    tx.mediaStorageCredit.findFirst({ select: { componentId: true } }),
    tx.avatarAsset.findFirst({ select: { id: true } }),
    tx.albumPhoto.findFirst({ select: { id: true } }),
    tx.albumCommentMedia.findFirst({ select: { id: true } }),
    tx.dailyMedia.findFirst({ select: { id: true } }),
    tx.wishMedia.findFirst({ select: { id: true } }),
    tx.knowledgeImage.findFirst({ select: { id: true } }),
    tx.officialEventImage.findFirst({ select: { id: true } }),
    tx.lottery.findFirst({ select: { id: true } }),
    tx.resourceLink.findFirst({ where: { iconBytes: { not: null } }, select: { id: true } })
  ]);
  if (rows.some(Boolean)) throw Error('MEDIA_BASELINE_DATABASE_NOT_EMPTY');
}
