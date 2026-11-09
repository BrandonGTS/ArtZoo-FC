import type { Prisma } from '@artzoo/db';
import { denied } from './contract';
/** Called within the article writer transaction. A pending upload belongs only to its uploader. */
export async function bindKnowledgeImages(
  tx: Prisma.TransactionClient,
  images: string[],
  articleId: string,
  actorId: string,
  options: { currentImages: string[]; canUseHistory: boolean } = { currentImages: [], canUseHistory: false }
) {
  if (!images.length) return;
  const rows = await tx.knowledgeImage.findMany({ where: { id: { in: images } } });
  if (
    rows.length !== images.length ||
    rows.some(
      (row) =>
        row.commentId ||
        (row.articleId
          ? row.articleId !== articleId || (!options.canUseHistory && !options.currentImages.includes(row.id))
          : row.uploaderId !== actorId)
    )
  )
    denied();
  for (const row of rows)
    if (await (await import('@artzoo/db')).knowledgeMediaFencedTx(tx, row.uploaderId, [row.id])) denied();
  await tx.knowledgeImage.updateMany({
    where: { id: { in: images }, articleId: null, uploaderId: actorId },
    data: { articleId }
  });
}
