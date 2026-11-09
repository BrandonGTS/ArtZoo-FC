import { withUploadSlot } from '../media/upload-gate';
import { resolveRequestSource } from '../auth/request-source';
import { createHash, randomUUID } from 'node:crypto';
import { mediaBudgetError, mediaUploadPendingError } from '../media/budget-errors';
import { processPhoto, withPhotoSlot } from '../media/photo-processor';
import { readPhotoBody, validatePhotoRequest } from '../daily/http';
import { failure, responseHeaders, sessionToken, success } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { AccountError, activityId, mediaBudgetPolicy } from '@artzoo/domain';
import type { PhotoVariant } from '../media/photo-storage';
import { lotteryStorage } from './media';
import { lotteryMediaFencedTx } from '@artzoo/db';

export async function uploadLotteryImage(request: Request) {
  try {
    validatePhotoRequest(request);
    const token = await sessionToken(),
      auth = getAccountService(),
      actor = await auth.requireAccount(auth.db, token);
    if (actor.account.membership !== 'MEMBER' && actor.account.adminRole === 'NONE')
      throw new AccountError('FORBIDDEN', '仅正式成员和管理员可以上传奖品图片', 403);
    await auth.checkWriteSource(resolveRequestSource(request), token);
    await auth.limitWriteParsing(resolveRequestSource(request), actor.accountId);
    return await withUploadSlot(async () => {
      const input = await readPhotoBody(request);
      await auth.limitWriteSource(resolveRequestSource(request), token);
      await auth.rate('lottery-upload:' + actor.accountId, 100, 900);
      const budgetEnabled = process.env.ARTZOO_MEDIA_BUDGET_ENABLED;
      const policy =
        budgetEnabled === undefined || budgetEnabled === '0' ? null : mediaBudgetPolicy(process.env);
      if (policy?.enabled) {
        const { createMediaBudgetAdapter } = await import('@artzoo/db');
        const current = await auth.requireAccount(auth.db, token);
        if (current.id !== actor.id || current.accountId !== actor.accountId)
          throw new AccountError('FORBIDDEN', '请重新登录', 403);
        // This endpoint has never had a client replay key: every upload remains a new asset.
        const id = randomUUID();
        const prepared = await createMediaBudgetAdapter(auth.db, policy, auth.now).prepare({
          scope: 'lottery-image',
          operationKey: randomUUID(),
          fingerprint: createHash('sha256')
            .update(input.input)
            .update(JSON.stringify([actor.accountId, input.name]))
            .digest('hex'),
          accountId: actor.accountId,
          rawBytes: BigInt(input.input.length),
          objectIdentity: `lottery:${actor.accountId}:${id}`
        });
        if (prepared.kind !== 'owner') throw mediaUploadPendingError();
        const attempt = prepared.attempt;
        let output: Awaited<ReturnType<typeof processPhoto>>;
        let photoNamespaces:
          | Awaited<
              ReturnType<NonNullable<import('../media/photo-storage').PhotoStorage['writePhotoNamespaces']>>
            >
          | undefined;
        let photoAllocation: import('@artzoo/db').MediaBoundAllocationTicket | undefined;
        const photoProofs: import('@artzoo/media/stock-retirement').MediaWriteProof[] = [];
        let media: import('../media/photo-storage').PhotoStorage | undefined;
        let storageFailure: unknown;
        let storageFailed = false;
        try {
          output = await withPhotoSlot(() => processPhoto(input.input, input.name));
          try {
            media = lotteryStorage(actor.accountId);
          } catch (error) {
            // Preserve the original post-begin factory failure/UNKNOWN outcome.
            storageFailed = true;
            storageFailure = error;
          }
          if (media?.writePhotoNamespaces || media?.boundPhotoNamespaces) {
            photoNamespaces = await (media.writePhotoNamespaces ?? media.boundPhotoNamespaces)!.call(
              media,
              'lottery-image'
            );
            photoAllocation = await attempt.allocateBoundComponents({
              kind: 'photo',
              scope: 'lottery-image',
              originalBytes: BigInt(output.original.length),
              previewBytes: BigInt(output.preview.length),
              thumbnailBytes: BigInt(output.thumbnail.length),
              contentHashes: {
                original: createHash('sha256').update(output.original).digest('hex'),
                preview: createHash('sha256').update(output.preview).digest('hex'),
                thumbnail: createHash('sha256').update(output.thumbnail).digest('hex')
              }
            });
          } else {
            await attempt.allocate(
              BigInt(output.original.length) + BigInt(output.preview.length) + BigInt(output.thumbnail.length)
            );
          }
        } catch (error) {
          try {
            await attempt.failBeforePersistence();
          } catch {
            console.warn('Lottery image prewrite budget cleanup deferred');
          }
          throw error;
        }
        try {
          // Resolving this unique claim means the durable begin transaction has committed.
          await attempt.begin();
          if (storageFailed) throw storageFailure;
          await media!.put(id, output);
          if (photoNamespaces && photoAllocation) {
            for (const variant of ['original', 'preview', 'thumbnail'] as const) {
              const namespace = variant === 'original' ? photoNamespaces.original : photoNamespaces.derived;
              photoProofs.push(
                await namespace.capture(
                  id,
                  ('photo-' + variant) as 'photo-original' | 'photo-preview' | 'photo-thumbnail',
                  createHash('sha256').update(output[variant]).digest('hex'),
                  BigInt(output[variant].length)
                )
              );
            }
          }
          await auth.transaction(async (tx) => {
            const before = await auth.requireAccount(tx, token);
            if (before.id !== actor.id || before.accountId !== actor.accountId)
              throw new AccountError('FORBIDDEN', '请重新登录', 403);
            // No independent media business row exists here: this committed receipt records the asset.
            await attempt.commit(tx);
            if (photoAllocation)
              await (
                await import('@artzoo/media/stock-retirement')
              ).bindLotteryPhotoWrite(tx, photoAllocation, actor.accountId, id, photoProofs);
            // Plain READ COMMITTED auth reads after a quota-lock wait; no new business locks.
            const fresh = await auth.requireAccount(tx, token);
            if (fresh.id !== actor.id || fresh.accountId !== actor.accountId)
              throw new AccountError('FORBIDDEN', '请重新登录', 403);
            if (auth.now() >= fresh.expiresAt) throw new AccountError('UNAUTHENTICATED', '请先登录', 401);
          });
          return success({ imageUrl: `/api/lotteries/media/${actor.accountId}/${id}` }, 201);
        } catch (error) {
          try {
            await attempt.unknown();
          } catch {
            console.warn('Lottery image budget outcome remains uncertain');
          }
          // COMMIT acknowledgement may be lost. Never discard a potentially committed asset.
          throw error;
        }
      }
      const output = await withPhotoSlot(() => processPhoto(input.input, input.name));
      // Namespaced media keys bind unpublished bytes to the uploading account.
      const id = randomUUID(),
        media = lotteryStorage(actor.accountId);
      await media.put(id, output);
      try {
        const fresh = await auth.requireAccount(auth.db, token);
        if (fresh.id !== actor.id || fresh.accountId !== actor.accountId)
          throw new AccountError('FORBIDDEN', '请重新登录', 403);
        return success({ imageUrl: `/api/lotteries/media/${actor.accountId}/${id}` }, 201);
      } catch (error) {
        await media.discardUncommitted(id);
        throw error;
      }
    });
  } catch (error) {
    return failure(mediaBudgetError(error), 'lottery/media-http');
  }
}
export async function readLotteryImage(request: Request, ownerValue: string, idValue: string) {
  try {
    const ownerId = activityId(ownerValue),
      id = activityId(idValue),
      url = new URL(request.url);
    const variant = url.searchParams.get('variant') ?? 'thumbnail';
    if (!['original', 'preview', 'thumbnail'].includes(variant))
      throw new AccountError('VALIDATION_ERROR', '图片版本无效', 400);
    const auth = getAccountService(),
      token = await sessionToken(),
      imageUrl = `/api/lotteries/media/${ownerId}/${id}`;
    const bytes = await auth.transaction(async (tx) => {
      const actor = await auth.requireAccount(tx, token);
      await tx.$queryRaw`/*lottery-orphan:read-lock*/ SELECT pg_advisory_xact_lock_shared(hashtextextended(${'lottery:write'},0))::text`;
      const [row] = await tx.$queryRaw<{ visible: boolean; attached: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM "Lottery" WHERE "moderatedAt" IS NULL
          AND "prizes" @> ${JSON.stringify([{ imageUrl }])}::jsonb) AS visible,
          EXISTS(SELECT 1 FROM "Lottery" WHERE "prizes" @> ${JSON.stringify([{ imageUrl }])}::jsonb) AS attached`;
      // Unpublished uploads remain owner-only. Governance never deletes stored images.
      if (!row?.visible && (actor.accountId !== ownerId || row?.attached))
        throw new AccountError('NOT_FOUND', '图片不存在', 404);
      if (await lotteryMediaFencedTx(tx, ownerId, [id]))
        throw new AccountError('NOT_FOUND', '图片不存在', 404);
      let result: Buffer;
      try {
        result = await lotteryStorage(ownerId).read(id, variant as PhotoVariant);
      } catch {
        throw new AccountError('NOT_FOUND', '图片不存在', 404);
      }
      const fresh = await auth.requireAccount(tx, token);
      if (fresh.id !== actor.id || fresh.accountId !== actor.accountId)
        throw new AccountError('FORBIDDEN', '请重新登录', 403);
      return result;
    });
    return new Response(new Uint8Array(bytes), {
      headers: {
        ...responseHeaders,
        'Content-Type': variant === 'original' ? 'application/octet-stream' : 'image/webp',
        'Content-Disposition':
          variant === 'original' ? 'attachment; filename="lottery-prize-image"' : 'inline',
        'Cross-Origin-Resource-Policy': 'same-origin'
      }
    });
  } catch (error) {
    return failure(error, 'lottery/media-http');
  }
}
