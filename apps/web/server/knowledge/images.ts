import type {
  BoundNamespace,
  BoundWriteProof,
  MediaWriteProof,
  MediaWriteNamespace,
  inspectKnowledgeJournal
} from '@artzoo/media/stock-retirement';
import type {
  Prisma,
  MediaBudgetAttempt,
  MediaBoundAllocationTicket,
  createMediaBudgetAdapter
} from '@artzoo/db';
import { randomUUID, createHash } from 'node:crypto';
import { AccountError } from '@artzoo/domain';
import { AccountService, lock } from '../auth/service';
import { id, denied, fail, missing, type Body } from './contract';
import { visibleCommentIds } from '../daily/comment-tree';
import { documentImages, readKnowledgeDocument, type BodyFormat } from '../../content/knowledge-document';
import { KnowledgeImageUploadReceipts, quoteKnowledgeUploadJournal } from './image-upload-receipts';
export const KNOWLEDGE_IMAGE_RULES = { maxBytes: 30 * 1024 * 1024, maxSelection: 10 } as const;
export type KnowledgeImageVariant = 'original' | 'preview' | 'thumbnail';
export interface KnowledgePhotoOutput {
  original: Buffer;
  preview: Buffer;
  thumbnail: Buffer;
  mime: string;
  width: number;
  height: number;
  frames: number;
}
/** The album's existing processor and storage implement these ports unchanged. No decoder/storage fork. */
export interface KnowledgePhotoPorts {
  writePhotoNamespaces?(
    scope: 'knowledge'
  ): Promise<{ original: MediaWriteNamespace; derived: MediaWriteNamespace }>;
  boundPhotoNamespaces?(scope: 'knowledge'): Promise<{
    original: import('@artzoo/media/stock-retirement').MediaRetirementNamespace;
    derived: import('@artzoo/media/stock-retirement').MediaRetirementNamespace;
  }>;
  process(input: Buffer, name: string): Promise<KnowledgePhotoOutput>;
  put(id: string, output: KnowledgePhotoOutput): Promise<void>;
  read(id: string, variant: KnowledgeImageVariant): Promise<Buffer>;
  discardUncommitted(id: string): Promise<void>;
}
export class KnowledgeImageService {
  constructor(
    readonly auth: AccountService,
    readonly photos: KnowledgePhotoPorts,
    readonly receipts = new KnowledgeImageUploadReceipts(),
    readonly budget: ReturnType<typeof createMediaBudgetAdapter> | null = null
  ) {}
  private async writer(tx: Prisma.TransactionClient, token?: string | null) {
    const actor = await this.auth.requireAccount(tx, token);
    await lock(tx, `phone:${actor.account.phone}`);
    await tx.$queryRaw`SELECT id FROM "Account" WHERE id=${actor.accountId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT id FROM "AccountSession" WHERE id=${actor.id} FOR UPDATE`;
    const fresh = await this.auth.requireAccount(tx, token);
    if (fresh.accountId !== actor.accountId) denied();
    return fresh;
  }
  async upload(body: Body, input: Buffer, name: string, token?: string | null) {
    const batchId = id(body.batchId),
      batchIndex = body.batchIndex;
    if (
      !Number.isInteger(batchIndex) ||
      Number(batchIndex) < 0 ||
      Number(batchIndex) >= KNOWLEDGE_IMAGE_RULES.maxSelection
    )
      fail('每次选取最多10张图片');
    if (!input.length || input.length > KNOWLEDGE_IMAGE_RULES.maxBytes) fail('每张图片最多30MiB');
    const originalName = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 255);
    if (!originalName) fail('图片名称无效');
    const digest = createHash('sha256').update(input).digest('hex');
    const checkFresh = async (
      tx: Prisma.TransactionClient,
      actor: Awaited<ReturnType<KnowledgeImageService['writer']>>
    ) => {
      const fresh = await this.auth.requireAccount(tx, token);
      if (fresh.id !== actor.id || fresh.accountId !== actor.accountId || fresh.expiresAt <= this.auth.now())
        throw new AccountError('UNAUTHENTICATED', '请先登录', 401);
    };
    const response = (
      image: { id: string; width: number; height: number; frames: number },
      replayed: boolean
    ) => ({
      id: image.id,
      replayed,
      url: `/api/knowledge-images/${image.id}?variant=preview`,
      width: image.width,
      height: image.height,
      frames: image.frames
    });
    // The fast path performs no decode or disk write. The later transaction still
    // repeats this check under the same account/session locks to cover races.
    const inspect = async (tx: Prisma.TransactionClient) => {
      const actor = await this.writer(tx, token),
        key = { uploaderId: actor.accountId, batchId, batchIndex: Number(batchIndex) };
      const existing = await tx.knowledgeImage.findUnique({ where: { uploaderId_batchId_batchIndex: key } });
      await checkFresh(tx, actor);
      if (
        existing &&
        (await (await import('@artzoo/db')).knowledgeMediaFencedTx(tx, actor.accountId, [existing.id]))
      )
        throw new AccountError('CONFLICT', '图片已不可用于新内容', 409);
      if (existing && existing.digest !== digest)
        throw new AccountError('CONFLICT', '同一上传标识的图片内容已变化', 409);
      return { key, existing };
    };
    let preflight = await this.auth.transaction(inspect);
    if (preflight.existing) {
      // A changed filename still goes through the shared format validation.
      if (preflight.existing.originalName !== originalName) {
        await this.photos.process(input, originalName);
        preflight = await this.auth.transaction(inspect);
      }
      if (preflight.existing) return response(preflight.existing, true);
    }
    let quotaAttempt: MediaBudgetAttempt | null = null;
    let beginAttempted = false;
    let budgetImageId: string | undefined;
    let namespace: BoundNamespace | undefined,
      boundAllocation: MediaBoundAllocationTicket | undefined,
      journalWrite: BoundWriteProof | undefined;
    let photoNamespaces: { original: MediaWriteNamespace; derived: MediaWriteNamespace } | undefined;
    const photoWrites: MediaWriteProof[] = [];
    let journalPlan: Awaited<ReturnType<typeof inspectKnowledgeJournal>> | undefined;
    let boundReceiptClose: (() => Promise<void>) | undefined;
    try {
      if (this.budget) {
        budgetImageId = randomUUID();
        const prepared = await this.budget.prepare({
          scope: 'knowledge',
          operationKey: `${preflight.key.uploaderId}:${batchId}:${Number(batchIndex)}`,
          fingerprint: digest,
          accountId: preflight.key.uploaderId,
          rawBytes: BigInt(input.length),
          objectIdentity: `knowledge:${budgetImageId}`
        });
        if (prepared.kind === 'owner') quotaAttempt = prepared.attempt;
        else if (prepared.kind === 'existing') {
          preflight = await this.auth.transaction(inspect);
          if (preflight.existing) {
            if (preflight.existing.originalName !== originalName) {
              await this.photos.process(input, originalName);
              preflight = await this.auth.transaction(inspect);
            }
            if (preflight.existing) return response(preflight.existing, true);
          }
          throw (await import('../media/budget-errors')).mediaUploadPendingError();
        }
      }
      const output = await this.photos.process(input, originalName),
        imageId = budgetImageId ?? randomUUID();
      // Persist an exact-object receipt before creating any media. Prepared receipts
      // are pending by default, including a crash or an interrupted state append.
      const record = {
        schemaVersion: 1 as const,
        imageId,
        digest,
        variants: (['original', 'preview', 'thumbnail'] as const).map((variant) => ({
          variant,
          bytes: output[variant].length
        }))
      };
      const quote = quotaAttempt ? quoteKnowledgeUploadJournal(record) : undefined;
      if (quotaAttempt && quote) {
        if (typeof this.receipts.boundNamespace === 'function')
          namespace = await this.receipts.boundNamespace();
        const mediaBytes =
          BigInt(output.original.length) + BigInt(output.preview.length) + BigInt(output.thumbnail.length);
        if (namespace) {
          if (this.photos.writePhotoNamespaces)
            photoNamespaces = await this.photos.writePhotoNamespaces('knowledge');
          else if (this.photos.boundPhotoNamespaces)
            photoNamespaces = await this.photos.boundPhotoNamespaces('knowledge');
        }
        if (namespace)
          boundAllocation = await quotaAttempt.allocateBoundComponents({
            kind: 'knowledge',
            mediaBytes,
            journalBytes: BigInt(quote.maxBytes),
            preparedSha256: quote.preparedSha256,
            ...(photoNamespaces
              ? {
                  photo: {
                    originalBytes: BigInt(output.original.length),
                    previewBytes: BigInt(output.preview.length),
                    thumbnailBytes: BigInt(output.thumbnail.length),
                    contentHashes: {
                      original: createHash('sha256').update(output.original).digest('hex'),
                      preview: createHash('sha256').update(output.preview).digest('hex'),
                      thumbnail: createHash('sha256').update(output.thumbnail).digest('hex')
                    }
                  }
                }
              : {})
          });
        else await quotaAttempt.allocate(mediaBytes, BigInt(quote.maxBytes));
        beginAttempted = true;
        await quotaAttempt.begin();
      }
      const receipt = quote ? await this.receipts.create(record, quote) : await this.receipts.create(record);
      if (namespace && boundAllocation && quote) {
        boundReceiptClose = () => receipt.close();
        journalWrite = await namespace.capture(
          imageId,
          'knowledge-journal',
          quote.preparedSha256,
          BigInt(quote.maxBytes)
        );
      }
      const note = async (state: Parameters<typeof receipt.note>[0]) => {
        try {
          await receipt.note(state);
        } catch {
          console.warn('Knowledge upload receipt update failed', { imageId, state });
        }
      };
      const retain = async () => {
        await note('pending');
        await receipt.close().catch(() => undefined);
        console.warn('Knowledge upload retained for exact receipt reconciliation', { imageId });
      };
      const retire = async (state: 'committed' | 'discarded') => {
        if (state === 'committed' && journalPlan) {
          try {
            // An unacknowledged final journal write cannot authorize tracked retirement.
            await receipt.note(state);
            await receipt.close();
            await journalPlan.finish(this.auth.db, this.auth.now);
          } catch {
            await receipt.close().catch(() => undefined);
            console.warn('Knowledge upload receipt retirement deferred');
          }
          return;
        }
        await note(state);
        try {
          await receipt.remove();
        } catch {
          await receipt.close().catch(() => undefined);
          console.warn('Knowledge upload receipt remains pending', { imageId, state });
        }
      };
      let stored = false,
        transactionInvoked = false,
        callbackFailed = false,
        callbackError: unknown;
      let result: { id: string; replayed: boolean; width: number; height: number; frames: number };
      try {
        await this.photos.put(imageId, output);
        stored = true;
        if (photoNamespaces)
          for (const variant of ['original', 'preview', 'thumbnail'] as const)
            photoWrites.push(
              await photoNamespaces[variant === 'original' ? 'original' : 'derived'].capture(
                imageId,
                ('photo-' + variant) as 'photo-original' | 'photo-preview' | 'photo-thumbnail',
                createHash('sha256').update(output[variant]).digest('hex'),
                BigInt(output[variant].length)
              )
            );
        await note('files-written');
        if (namespace && boundAllocation && quote) {
          const { inspectKnowledgeJournal } = await import('@artzoo/media/stock-retirement');
          journalPlan = await inspectKnowledgeJournal(
            namespace,
            imageId,
            quote.preparedSha256,
            BigInt(quote.maxBytes)
          );
        }
        transactionInvoked = true;
        result = await this.auth.transaction(async (tx) => {
          try {
            const actor = await this.writer(tx, token);
            if (actor.accountId !== preflight.key.uploaderId) denied();
            const existing = await tx.knowledgeImage.findUnique({
              where: { uploaderId_batchId_batchIndex: preflight.key }
            });
            if (
              existing &&
              (await (await import('@artzoo/db')).knowledgeMediaFencedTx(tx, actor.accountId, [existing.id]))
            )
              throw new AccountError('CONFLICT', '图片已不可用于新内容', 409);
            if (existing && existing.digest !== digest)
              throw new AccountError('CONFLICT', '同一上传标识的图片内容已变化', 409);
            const image =
              existing ??
              (await tx.knowledgeImage.create({
                data: {
                  id: imageId,
                  ...preflight.key,
                  digest,
                  originalName,
                  mime: output.mime,
                  // digest remains the request identity shared by legacy replay and receipts.
                  bytes: output.original.length,
                  width: output.width,
                  height: output.height,
                  frames: output.frames
                }
              }));
            await checkFresh(tx, actor);
            if (quotaAttempt && !existing) {
              await quotaAttempt.commit(tx);
              if (boundAllocation && journalWrite) {
                const { bindKnowledgeJournalWrite, bindKnowledgePhotoWrite } =
                  await import('@artzoo/media/stock-retirement');
                if (photoNamespaces)
                  await bindKnowledgePhotoWrite(
                    tx,
                    boundAllocation,
                    preflight.key.uploaderId,
                    imageId,
                    photoWrites,
                    journalWrite
                  );
                else
                  await bindKnowledgeJournalWrite(
                    tx,
                    boundAllocation,
                    preflight.key.uploaderId,
                    imageId,
                    journalWrite
                  );
              }
              if (journalPlan) await journalPlan.prepare(tx, preflight.key.uploaderId, this.auth.now());
              // Re-read revocation/account policy after budget-lock waiting; no new row/advisory locks.
              await checkFresh(tx, actor);
            }
            return {
              id: image.id,
              replayed: !!existing,
              width: image.width,
              height: image.height,
              frames: image.frames
            };
          } catch (error) {
            callbackFailed = true;
            callbackError = error;
            throw error;
          }
        });
      } catch (error) {
        // Prisma never requests COMMIT for a callback that threw. Only that exact
        // rejection (or failure before starting the transaction) proves rollback.
        // A timeout/transport/COMMIT rejection is deliberately not inferred from a SELECT.
        if (stored && (!transactionInvoked || (callbackFailed && error === callbackError))) {
          await note('rollback-confirmed');
          try {
            await this.photos.discardUncommitted(imageId);
            await retire('discarded');
          } catch {
            await retain();
          }
        } else await retain();
        throw error;
      }
      if (result.replayed) {
        await note('replayed');
        try {
          await this.photos.discardUncommitted(imageId);
        } catch (error) {
          await retain();
          throw error;
        }
        await retire('discarded');
      } else await retire('committed');
      if (quotaAttempt && result.replayed) await quotaAttempt.unknown().catch(() => undefined);
      return response(result, result.replayed);
    } catch (error) {
      if (!this.budget) throw error;
      if (quotaAttempt) {
        // Once begin was attempted even a lost acknowledgement is uncertain. Never infer absence from a SELECT.
        try {
          if (beginAttempted) await quotaAttempt.unknown();
          else await quotaAttempt.failBeforePersistence();
        } catch {
          /* A committed receipt or unavailable DB remains conservative; never replace the original failure. */
        }
      }
      throw (await import('../media/budget-errors')).mediaBudgetError(error);
    } finally {
      if (journalPlan) await journalPlan.close();
      if (boundReceiptClose) await boundReceiptClose().catch(() => undefined);
    }
  }
  async read(imageId: string, variant: KnowledgeImageVariant, token?: string | null) {
    imageId = id(imageId);
    if (!['original', 'preview', 'thumbnail'].includes(variant)) fail('图片版本无效');
    const authorize = (expected?: { id: string; accountId: string }) =>
      this.auth.transaction(async (tx) => {
        const actor = await this.auth.requireAccount(tx, token);
        if (expected && (actor.id !== expected.id || actor.accountId !== expected.accountId))
          throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
        const image = await tx.knowledgeImage.findUnique({
          where: { id: imageId },
          include: { article: true, comment: true }
        });
        if (!image) return missing();
        if (await (await import('@artzoo/db')).knowledgeMediaFencedTx(tx, image.uploaderId, [image.id]))
          return missing();
        let historical = false;
        if (!image.articleId) {
          if (image.uploaderId !== actor.accountId) denied();
        } else {
          const a = image.article;
          if (!a || a.removedAt) return missing();
          if (image.commentId) {
            if (!image.comment || image.comment.removedAt) return missing();
            const rows = await tx.knowledgeComment.findMany({
              where: { articleId: a.id },
              select: { id: true, parentId: true, removedAt: true }
            });
            if (!visibleCommentIds(rows).has(image.commentId)) return missing();
          }
          const current =
            !!image.commentId ||
            documentImages(readKnowledgeDocument(a.body, a.bodyFormat as BodyFormat)).includes(image.id);
          historical = !current;
        }
        const fresh = await this.auth.requireAccount(tx, token);
        if (fresh.id !== actor.id || fresh.accountId !== actor.accountId)
          throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
        if (
          historical &&
          image.article?.authorId !== fresh.accountId &&
          !['ADMIN', 'SUPER_ADMIN'].includes(fresh.account.adminRole)
        )
          denied();
        return { actor, mime: variant === 'original' ? image.mime : 'image/webp', name: image.originalName };
      });
    const initial = await authorize();
    let bytes: Buffer;
    try {
      bytes = await this.photos.read(imageId, variant);
    } catch {
      return missing();
    }
    // Use a new Read Committed transaction after storage, not the old snapshot.
    const current = await authorize(initial.actor);
    return { mime: current.mime, name: current.name, bytes };
  }
}
