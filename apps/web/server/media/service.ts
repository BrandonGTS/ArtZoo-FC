import type {
  MediaWriteNamespace,
  MediaWriteProof,
  inspectSupersededAvatar
} from '@artzoo/media/stock-retirement';
import { createHash, randomUUID } from 'node:crypto';
import type { MediaBoundAllocationTicket, MediaBudgetAttempt } from '@artzoo/db';
import { AccountError, AVATAR_RULES, mediaBudgetPolicy, isMemberId, type AvatarCrop } from '@artzoo/domain';
import { AccountService, lock } from '../auth/service';
import { memberProfile, memberSelect } from '../members/service';
import { invalidAvatar, processAvatar } from './processor';
import { mediaBudgetError, mediaUploadPendingError } from './budget-errors';
import { type AvatarStorage, type AvatarVariant } from './storage';
import { avatarStorage } from './runtime-storage';

export class AvatarService {
  constructor(
    readonly auth: AccountService,
    readonly storage: AvatarStorage = avatarStorage()
  ) {}
  async authorizeUpload(token?: string | null): Promise<string> {
    const session = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`avatar:${session.accountId}`, 10, 900);
    return session.accountId;
  }
  async upload(
    token: string | undefined,
    accountId: string,
    input: Buffer,
    crop: AvatarCrop,
    revision: number
  ) {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= 2_147_483_647)
      throw new AccountError('CONFLICT', '资料版本已变更，请刷新后再试', 409);
    const policy =
      (process.env.ARTZOO_MEDIA_BUDGET_ENABLED ?? '0') === '0' ? null : mediaBudgetPolicy(process.env);
    let attempt: MediaBudgetAttempt | undefined;
    let namespace: MediaWriteNamespace | undefined, boundAllocation: MediaBoundAllocationTicket | undefined;
    let retirement: Awaited<ReturnType<typeof inspectSupersededAvatar>> = null;
    const writeProofs: MediaWriteProof[] = [];
    const retainUnknown = async () => {
      try {
        await attempt?.unknown();
      } catch {
        // A failed acknowledgement cannot justify releasing possibly written bytes.
        console.warn('Avatar budget outcome remains uncertain');
      }
    };
    try {
      let output: Awaited<ReturnType<typeof processAvatar>>, id: string;
      if (policy?.enabled) {
        const { createMediaBudgetAdapter } = await import('@artzoo/db');
        // Short authorization-only transaction; no budget lock is held while acquiring business locks.
        const priorId = await this.auth.transaction(async (tx) => {
          const before = await this.auth.requireAccount(tx, token);
          if (before.accountId !== accountId) throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
          await lock(tx, `phone:${before.account.phone}`);
          await lock(tx, `member-profile:${accountId}`);
          const session = await this.auth.requireAccount(tx, token);
          if (session.accountId !== accountId) throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
          const current = await tx.memberProfile.findUnique({ where: { accountId } });
          if ((current?.revision ?? 0) !== revision)
            throw new AccountError('CONFLICT', '资料已在其他页面更新，请刷新后再试', 409);
          const fresh = await this.auth.requireAccount(tx, token);
          if (fresh.id !== before.id || fresh.accountId !== accountId)
            throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
          return current?.avatarId;
        });
        let localNamespace: import('@artzoo/media/stock-retirement').MediaRetirementNamespace | undefined;
        if (this.storage.writeNamespace) namespace = await this.storage.writeNamespace();
        else if (this.storage.boundNamespace) {
          localNamespace = await this.storage.boundNamespace();
          namespace = localNamespace;
        }
        // Local retirement authority is deliberately separate from COS write proofs.
        if (typeof this.storage.boundNamespace === 'function') {
          if (priorId) {
            try {
              const { inspectSupersededAvatar } = await import('@artzoo/media/stock-retirement');
              retirement = await inspectSupersededAvatar(
                this.auth.db,
                localNamespace ?? (await this.storage.boundNamespace()),
                accountId,
                priorId
              );
            } catch {
              console.warn('Avatar retired proof unavailable');
            }
          }
        }
        if (!input.length || input.length > AVATAR_RULES.maxBytes) invalidAvatar('图片大小需在 10 MB 以内');
        id = randomUUID();
        try {
          const prepared = await createMediaBudgetAdapter(this.auth.db, policy, this.auth.now).prepare({
            scope: 'avatar',
            operationKey: randomUUID(),
            fingerprint: createHash('sha256')
              .update(input)
              .update(JSON.stringify([accountId, revision, crop]))
              .digest('hex'),
            accountId,
            rawBytes: BigInt(input.length),
            objectIdentity: `avatar:${id}`
          });
          if (prepared.kind !== 'owner') throw mediaUploadPendingError();
          attempt = prepared.attempt;
        } catch (error) {
          throw mediaBudgetError(error);
        }
        try {
          output = await processAvatar(input, crop);
          if (namespace)
            boundAllocation = await attempt!.allocateBoundComponents({
              kind: 'avatar',
              fullBytes: BigInt(output.full.length),
              smallBytes: BigInt(output.small.length),
              contentHashes: {
                full: createHash('sha256').update(output.full).digest('hex'),
                small: createHash('sha256').update(output.small).digest('hex')
              }
            });
          else await attempt!.allocate(BigInt(output.full.length) + BigInt(output.small.length));
        } catch (error) {
          try {
            await attempt!.failBeforePersistence();
          } catch {
            console.warn('Avatar prewrite budget cleanup deferred');
          }
          throw mediaBudgetError(error);
        }
        // Even a rejected begin acknowledgement may have committed. Never release after this call starts.
        try {
          await attempt!.begin();
        } catch (error) {
          await retainUnknown();
          throw mediaBudgetError(error);
        }
      } else {
        output = await processAvatar(input, crop);
        id = randomUUID();
      }
      // No originals touch disk. Durable unique begin precedes both variants when budgets are enabled.
      try {
        await this.storage.put(id, output);
        if (namespace && boundAllocation) {
          writeProofs.push(
            await namespace.capture(
              id,
              'avatar-full',
              createHash('sha256').update(output.full).digest('hex'),
              BigInt(output.full.length)
            )
          );
          writeProofs.push(
            await namespace.capture(
              id,
              'avatar-small',
              createHash('sha256').update(output.small).digest('hex'),
              BigInt(output.small.length)
            )
          );
        }
      } catch (error) {
        if (attempt) await retainUnknown();
        throw mediaBudgetError(error);
      }
      let result;
      try {
        result = await this.auth.transaction(async (tx) => {
          const before = await this.auth.requireAccount(tx, token);
          if (before.accountId !== accountId) throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
          await lock(tx, `phone:${before.account.phone}`);
          await lock(tx, `member-profile:${accountId}`);
          const session = await this.auth.requireAccount(tx, token);
          if (session.accountId !== accountId) throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
          const current = await tx.memberProfile.findUnique({ where: { accountId } });
          if ((current?.revision ?? 0) !== revision)
            throw new AccountError('CONFLICT', '资料已在其他页面更新，请刷新后再试', 409);
          await tx.avatarAsset.create({
            data: {
              id,
              accountId,
              width: output.width,
              height: output.height,
              bytes: output.full.length,
              smallBytes: output.small.length
            }
          });
          await tx.memberProfile.upsert({
            where: { accountId },
            create: { accountId, avatarId: id, revision: 1 },
            update: { avatarId: id, revision: { increment: 1 } }
          });
          // The old DB record and reference switch share the transaction; files are removed only after commit.
          const removed = current?.avatarId
            ? retirement
              ? await retirement.removeRecord(tx, id)
              : await tx.avatarAsset.deleteMany({ where: { id: current.avatarId, accountId, profile: null } })
            : null;
          const account = await tx.account.findUniqueOrThrow({
            where: { id: accountId },
            select: memberSelect
          });
          // Asset/profile writes (including old-asset removal) can wait after authorization.
          // A fresh check here keeps an expired or revoked upload inside the rollback path.
          const finalSession = await this.auth.requireAccount(tx, token);
          if (finalSession.id !== before.id || finalSession.accountId !== accountId) {
            throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
          }
          // Tail settlement acquires budget locks only after all original business locks/fresh checks.
          if (attempt) {
            await attempt.commit(tx);
            if (boundAllocation) {
              const { bindAvatarWrite } = await import('@artzoo/media/stock-retirement');
              await bindAvatarWrite(tx, boundAllocation, accountId, id, writeProofs);
            }
            if (retirement && removed?.count === 1) await retirement.prepare(tx, this.auth.now());
            // Quota waiting can outlive a logout or account deactivation. READ COMMITTED
            // rechecks through the original ordinary SELECT path without another business lock.
            const settledSession = await this.auth.requireAccount(tx, token);
            if (
              settledSession.id !== before.id ||
              settledSession.accountId !== accountId ||
              this.auth.now() >= settledSession.expiresAt
            )
              throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
          }
          return {
            profile: memberProfile(account),
            oldId: removed?.count === 1 ? current?.avatarId : undefined
          };
        });
      } catch (error) {
        if (attempt) await retainUnknown();
        else {
          // Preserve the original OFF cleanup. With budget ON, even a temporarily absent
          // row cannot prove rollback: COMMIT may still become visible after this error.
          try {
            const asset = await this.auth.db.avatarAsset.findUnique({ where: { id }, select: { id: true } });
            if (!asset) await this.storage.delete(id);
          } catch {
            console.warn('Avatar rollback cleanup deferred');
          }
        }
        throw mediaBudgetError(error);
      }
      if (result.oldId) {
        try {
          if (retirement) await retirement.finish(this.auth.now);
          else await this.storage.delete(result.oldId);
        } catch {
          console.warn('Avatar superseded file cleanup deferred');
        }
      }
      return result.profile;
    } finally {
      if (retirement) await retirement.close();
    }
  }
  async read(token: string | undefined, id: string, variant: AvatarVariant): Promise<Buffer> {
    const authorize = (expected?: { id: string; accountId: string }) =>
      this.auth.transaction(async (tx) => {
        const actor = await this.auth.requireAccount(tx, token);
        if (expected && (actor.id !== expected.id || actor.accountId !== expected.accountId)) {
          throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
        }
        if (!isMemberId(id)) throw new AccountError('NOT_FOUND', '头像不存在', 404);
        const asset = await tx.avatarAsset.findUnique({
          where: { id },
          select: { id: true, accountId: true, profile: { select: { accountId: true } } }
        });
        if (!asset || asset.profile?.accountId !== asset.accountId)
          throw new AccountError('NOT_FOUND', '头像不存在', 404);
        const fresh = await this.auth.requireAccount(tx, token);
        if (fresh.id !== actor.id || fresh.accountId !== actor.accountId)
          throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
        return { actor, assetId: asset.id };
      });
    const initial = await authorize();
    let bytes: Buffer;
    try {
      bytes = await this.storage.read(initial.assetId, variant);
    } catch {
      throw new AccountError('NOT_FOUND', '头像暂不可用', 404);
    }
    // A replacement or session revocation during file I/O must hide these bytes.
    await authorize(initial.actor);
    return bytes;
  }
}
