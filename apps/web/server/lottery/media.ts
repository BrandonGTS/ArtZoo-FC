import { createPhotoStorage } from '@artzoo/media/cos-routed-storage';
import { join, resolve } from 'node:path';
import { AccountError, activityId } from '@artzoo/domain';
import { lotteryMediaFencedTx, type Prisma } from '@artzoo/db';
import { LocalPhotoStorage } from '../media/photo-storage';

export function lotteryStorage(ownerId: string) {
  activityId(ownerId);
  const base = resolve(/* turbopackIgnore: true */ process.cwd(), '.local', 'lottery-media');
  const original =
    process.env.ARTZOO_LOTTERY_ORIGINAL_DIR ??
    (process.env.NODE_ENV === 'production'
      ? '/app/storage/original/lotteries'
      : join(/* turbopackIgnore: true */ base, 'original'));
  const derived =
    process.env.ARTZOO_LOTTERY_DERIVED_DIR ??
    (process.env.NODE_ENV === 'production'
      ? '/app/storage/derived/lotteries'
      : join(/* turbopackIgnore: true */ base, 'derived'));
  const legacy = new LocalPhotoStorage(
    join(/* turbopackIgnore: true */ original, ownerId),
    join(/* turbopackIgnore: true */ derived, ownerId)
  );
  return createPhotoStorage({ scope: 'lottery', accountId: ownerId, legacy });
}
export function lotteryImageParts(url: string) {
  const match = /^\/api\/lotteries\/media\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/i.exec(url);
  if (!match) throw new AccountError('VALIDATION_ERROR', '奖品图片地址无效', 400);
  return { ownerId: activityId(match[1]), id: activityId(match[2]) };
}
export async function assertLotteryImages(
  prizes: { imageUrl?: string }[],
  actorId: string,
  tx: Prisma.TransactionClient
) {
  for (const prize of prizes)
    if (prize.imageUrl) {
      const { ownerId, id } = lotteryImageParts(prize.imageUrl);
      if (ownerId !== actorId) throw new AccountError('FORBIDDEN', '请上传自己的奖品图片', 403);
      if (await lotteryMediaFencedTx(tx, actorId, [id]))
        throw new AccountError('VALIDATION_ERROR', '奖品图片不可用，请重新上传', 400);
      try {
        await lotteryStorage(ownerId).read(id, 'thumbnail');
      } catch {
        throw new AccountError('VALIDATION_ERROR', '奖品图片不可用，请重新上传', 400);
      }
    }
}
