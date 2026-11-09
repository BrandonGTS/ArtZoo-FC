import { randomUUID } from 'node:crypto';
import type { Prisma, MediaBudgetAttempt, createMediaBudgetAdapter } from '@artzoo/db';
import {
  AccountError,
  isMemberId,
  type ActivityShareMedia,
  type PublicActivityShare,
  type AdminActivityShare
} from '@artzoo/domain';
import { AccountService, lock } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import { processPhoto, withPhotoSlot } from '../media/photo-processor';
import { PHOTO_RULES } from '../media/photo-contract';
import type { PhotoStorage, PhotoVariant } from '../media/photo-storage';
import { activityShareStorage } from './storage';
type Tx = Prisma.TransactionClient;
type Actor = Awaited<ReturnType<AccountService['requireAccount']>>;
type Body = Record<string, unknown>;
const selectPerson = { id: true, displayName: true } as const;
const include = {
  activity: { select: { id: true, title: true } },
  creator: { select: selectPerson },
  media: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }
} satisfies Prisma.ActivityShareInclude;
type Row = Prisma.ActivityShareGetPayload<{ include: typeof include }>;
function invalid(message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400);
}
function missing(): never {
  throw new AccountError('NOT_FOUND', '活动分享不存在或不可见', 404);
}
function conflict(message = '内容已更新，请刷新后重试'): never {
  throw new AccountError('CONFLICT', message, 409);
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !isMemberId(value)) invalid('标识无效');
  return value;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) invalid('请填写有效内容');
  return value.trim();
}
function key(value: unknown): string {
  if (typeof value !== 'string' || !/^[-_a-zA-Z0-9]{16,128}$/.test(value)) invalid('提交标识无效');
  return value;
}
function fields(body: Body, allowed: string[]) {
  if (Object.keys(body).some((k) => !allowed.includes(k))) invalid('提交字段无效');
}
function page(value: string | null) {
  if (value !== null && !/^[1-9]\d{0,5}$/.test(value)) invalid('分页无效');
  return value === null ? 1 : Number(value);
}
function mediaView(m: { id: string; width: number; height: number; frames: number }): ActivityShareMedia {
  return {
    id: m.id,
    width: m.width,
    height: m.height,
    frames: m.frames,
    previewUrl: `/api/activity-share-media/${m.id}?variant=preview`,
    thumbnailUrl: `/api/activity-share-media/${m.id}?variant=thumbnail`
  };
}
function permittedMedia() {
  return Boolean(process.env.ARTZOO_ALBUM_UPLOAD_NOTICE?.trim());
}
function publicView(row: Row): PublicActivityShare {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    media: row.mediaIds
      .map((k) => row.media.find((m) => m.id === k))
      .filter((m): m is Row['media'][number] => Boolean(m))
      .map(mediaView),
    featuredAt: row.featuredAt?.toISOString() ?? null
  };
}
function publicAllowed(row: Row) {
  return Boolean(row.featuredAt) && (row.mediaIds.length === 0 || permittedMedia());
}
function publishable(title: string, body: string, mediaIds: string[]) {
  if (!title || !body) invalid('请填写分享标题和公开回顾');
  if (mediaIds.length && !permittedMedia()) conflict('请先配置已确认的图片上传告知后再公开配图');
}
export class ActivityShareService {
  constructor(
    readonly auth: AccountService,
    readonly storage: PhotoStorage = activityShareStorage(),
    readonly budget: ReturnType<typeof createMediaBudgetAdapter> | null = null
  ) {}
  private async fresh(tx: Tx, token: string | null | undefined, expected: Actor, admin = true) {
    const actor = await this.auth.requireAccount(tx, token, admin);
    if (
      actor.expiresAt <= this.auth.now() ||
      actor.id !== expected.id ||
      actor.accountId !== expected.accountId ||
      actor.account.membership !== expected.account.membership ||
      actor.account.adminRole !== expected.account.adminRole
    )
      throw new AccountError('UNAUTHENTICATED', '登录状态已变化，请重新登录', 401);
    return actor;
  }
  private async actorLocked(tx: Tx, token: string | null | undefined, actor: Actor) {
    await lock(tx, 'phone:' + actor.account.phone);
    await tx.$queryRaw`SELECT id FROM "Account" WHERE id=${actor.accountId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT id FROM "AccountSession" WHERE id=${actor.id} FOR UPDATE`;
    return this.fresh(tx, token, actor);
  }
  private async row(tx: Tx, k: string) {
    const row = await tx.activityShare.findUnique({ where: { id: k }, include });
    if (!row) missing();
    return row;
  }
  private async lockedRow(tx: Tx, k: string) {
    await lock(tx, 'activity-share:' + k);
    await tx.$queryRaw`SELECT id FROM "ActivityShare" WHERE id=${k} FOR UPDATE`;
    return this.row(tx, k);
  }
  private async detail(tx: Tx, row: Row, historyPage = 1): Promise<AdminActivityShare> {
    const [audits, historyTotal] = await Promise.all([
      tx.activityShareAudit.findMany({
        where: { shareId: row.id },
        select: { id: true, action: true, reason: true, actor: { select: selectPerson }, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (historyPage - 1) * 20,
        take: 20
      }),
      tx.activityShareAudit.count({ where: { shareId: row.id } })
    ]);
    return {
      ...publicView(row),
      activity: row.activity,
      creator: row.creator,
      revision: row.revision,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      allMedia: row.media.map(mediaView),
      audits: audits.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
      historyPage,
      historyTotal
    };
  }
  private async command(tx: Tx, actor: Actor, idempotencyKey: string, fingerprint: string) {
    const old = await tx.activityShareCommand.findUnique({
      where: { actorId_idempotencyKey: { actorId: actor.accountId, idempotencyKey } }
    });
    if (old && old.requestFingerprint !== fingerprint) conflict('同次提交内容已变化，请使用原内容重试');
    return old;
  }
  private async record(
    tx: Tx,
    row: Row,
    actor: Actor,
    action: string,
    reason: string,
    before: Prisma.InputJsonValue,
    idempotencyKey: string,
    fingerprint: string
  ) {
    const now = this.auth.now();
    await tx.activityShareAudit.create({
      data: {
        shareId: row.id,
        actorId: actor.accountId,
        action,
        reason,
        before,
        after: publicView(row) as unknown as Prisma.InputJsonValue,
        createdAt: now
      }
    });
    await tx.activityShareCommand.create({
      data: {
        shareId: row.id,
        actorId: actor.accountId,
        idempotencyKey,
        requestFingerprint: fingerprint,
        action,
        createdAt: now
      }
    });
  }
  async create(body: Body, token?: string | null) {
    fields(body, ['activityId', 'title', 'body', 'idempotencyKey']);
    const activityId = id(body.activityId),
      title = text(body.title, 100, true),
      content = text(body.body, 2000, true),
      idempotencyKey = key(body.idempotencyKey),
      fingerprint = tokenDigest(JSON.stringify({ action: 'CREATE', activityId, title, body: content }));
    const actor = await this.auth.requireAccount(this.auth.db, token, true);
    await this.auth.rate('share-write:' + actor.accountId, 120, 900);
    return this.auth.transaction(async (tx) => {
      await this.actorLocked(tx, token, actor);
      const old = await this.command(tx, actor, idempotencyKey, fingerprint);
      let row: Row;
      if (old) row = await this.row(tx, old.shareId);
      else {
        if (!(await tx.activity.findUnique({ where: { id: activityId }, select: { id: true } }))) missing();
        row = await tx.activityShare.create({
          data: {
            activityId,
            creatorId: actor.accountId,
            title,
            body: content,
            mediaIds: [],
            createdAt: this.auth.now(),
            updatedAt: this.auth.now()
          },
          include
        });
        await this.record(tx, row, actor, 'CREATE', '新建活动分享', {}, idempotencyKey, fingerprint);
      }
      const share = await this.detail(tx, row);
      await this.fresh(tx, token, actor);
      return { share, replayed: Boolean(old) };
    });
  }
  async mutate(k: string, body: Body, token?: string | null) {
    id(k);
    const action = String(body.action);
    if (!['SAVE', 'FEATURE', 'UNFEATURE'].includes(action)) invalid('操作无效');
    const save = action === 'SAVE';
    fields(body, [
      'action',
      'expectedRevision',
      'idempotencyKey',
      'reason',
      ...(save ? ['title', 'body', 'mediaIds'] : [])
    ]);
    if (
      !Number.isSafeInteger(body.expectedRevision) ||
      Number(body.expectedRevision) < 0 ||
      Number(body.expectedRevision) >= 2147483647
    )
      invalid('内容版本无效');
    const expectedRevision = Number(body.expectedRevision),
      idempotencyKey = key(body.idempotencyKey),
      reason = text(body.reason, 500);
    let next: { title: string; body: string; mediaIds: string[] } | null = null;
    if (save) {
      if (
        !Array.isArray(body.mediaIds) ||
        body.mediaIds.length > 100 ||
        new Set(body.mediaIds).size !== body.mediaIds.length
      )
        invalid('配图选择无效');
      next = {
        title: text(body.title, 100, true),
        body: text(body.body, 2000, true),
        mediaIds: body.mediaIds.map(id)
      };
    }
    const fingerprint = tokenDigest(JSON.stringify({ id: k, action, expectedRevision, reason, ...next }));
    const actor = await this.auth.requireAccount(this.auth.db, token, true);
    await this.auth.rate('share-write:' + actor.accountId, 120, 900);
    return this.auth.transaction(async (tx) => {
      await this.actorLocked(tx, token, actor);
      const row = await this.lockedRow(tx, k);
      await this.fresh(tx, token, actor);
      const old = await this.command(tx, actor, idempotencyKey, fingerprint);
      if (!old) {
        if (row.revision !== expectedRevision) conflict();
        if ((action === 'FEATURE' && row.featuredAt) || (action === 'UNFEATURE' && !row.featuredAt))
          conflict('当前精选状态已变化');
        if (next && next.mediaIds.some((k) => !row.media.some((m) => m.id === k)))
          invalid('配图不属于这篇活动分享');
        if (action === 'FEATURE' || (next && row.featuredAt))
          publishable(next?.title ?? row.title, next?.body ?? row.body, next?.mediaIds ?? row.mediaIds);
        const before = publicView(row) as unknown as Prisma.InputJsonValue;
        const changed = await tx.activityShare.update({
          where: { id: k },
          data: {
            ...next,
            revision: { increment: 1 },
            updatedAt: this.auth.now(),
            ...(action === 'FEATURE'
              ? { featuredAt: this.auth.now() }
              : action === 'UNFEATURE'
                ? { featuredAt: null }
                : {})
          },
          include
        });
        await this.record(tx, changed, actor, action, reason, before, idempotencyKey, fingerprint);
      }
      const share = await this.detail(tx, await this.row(tx, k));
      await this.fresh(tx, token, actor);
      return { share, replayed: Boolean(old) };
    });
  }
  async get(k: string, url: URL, token?: string | null) {
    id(k);
    const manage = url.searchParams.get('manage') === '1',
      historyPage = page(url.searchParams.get('historyPage'));
    return this.auth.transaction(async (tx) => {
      const actor = token != null || manage ? await this.auth.requireAccount(tx, token, manage) : null;
      const row = await this.row(tx, k);
      if (!manage && !publicAllowed(row)) missing();
      const result = manage ? await this.detail(tx, row, historyPage) : publicView(row);
      if (actor) await this.fresh(tx, token, actor, manage);
      return result;
    });
  }
  async list(url: URL, token?: string | null) {
    const manage = url.searchParams.get('manage') === '1',
      current = page(url.searchParams.get('page')),
      query = text(url.searchParams.get('query') ?? '', 100, true);
    return this.auth.transaction(async (tx) => {
      const actor = token != null || manage ? await this.auth.requireAccount(tx, token, manage) : null;
      const where: Prisma.ActivityShareWhereInput = {
        featuredAt: { not: null },
        ...(!manage && !permittedMedia() ? { mediaIds: { isEmpty: true } } : {}),
        ...(query
          ? {
              OR: [
                { title: { contains: query, mode: 'insensitive' } },
                ...(manage
                  ? [{ creator: { displayName: { contains: query, mode: 'insensitive' as const } } }]
                  : [])
              ]
            }
          : {})
      };
      const [rows, total] = await Promise.all([
        tx.activityShare.findMany({
          where,
          include,
          orderBy: [{ featuredAt: 'desc' }, { id: 'desc' }],
          skip: (current - 1) * 12,
          take: 12
        }),
        tx.activityShare.count({ where })
      ]);
      const items = manage
        ? await Promise.all(rows.map((row) => this.detail(tx, row)))
        : rows.map(publicView);
      if (actor) await this.fresh(tx, token, actor, manage);
      return { items, total, page: current, hasMore: current * 12 < total };
    });
  }
  async forActivity(k: string, url: URL, token?: string | null) {
    id(k);
    const current = page(url.searchParams.get('page'));
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token, true);
      if (!(await tx.activity.findUnique({ where: { id: k }, select: { id: true } }))) missing();
      const rows = await tx.activityShare.findMany({
        where: { activityId: k },
        select: { id: true, title: true, featuredAt: true, revision: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (current - 1) * 12,
        take: 13
      });
      await this.fresh(tx, token, actor);
      return {
        items: rows.slice(0, 12).map((r) => ({ ...r, featuredAt: r.featuredAt?.toISOString() ?? null })),
        hasMore: rows.length > 12,
        page: current
      };
    });
  }
  async upload(k: string, fields: Body, input: Buffer, name: string, token?: string | null) {
    id(k);
    const batchId = id(fields.batchId),
      batchIndex = fields.batchIndex;
    if (!Number.isInteger(batchIndex) || Number(batchIndex) < 0 || Number(batchIndex) >= 10)
      invalid('每批最多10张图片');
    if (!input.length || input.length > PHOTO_RULES.maxBytes) invalid('每张图片最多30MiB');
    const actor = await this.auth.requireAccount(this.auth.db, token, true);
    await this.auth.rate('share-upload:' + actor.accountId, 100, 900);
    const fingerprint = tokenDigest(
      Buffer.concat([Buffer.from(k + '\0' + name + '\0'), input]).toString('base64')
    );
    const inspect = async (tx: Tx) => {
      await this.actorLocked(tx, token, actor);
      await this.lockedRow(tx, k);
      await this.fresh(tx, token, actor);
      const old = await tx.activityShareMedia.findUnique({
        where: {
          ownerId_batchId_batchIndex: { ownerId: actor.accountId, batchId, batchIndex: Number(batchIndex) }
        }
      });
      if (old && (old.shareId !== k || old.fingerprint !== fingerprint)) conflict('同次上传内容已变化');
      await this.fresh(tx, token, actor);
      return old;
    };
    const replay = await this.auth.transaction(async (tx) => {
      const old = await inspect(tx);
      return old ? { media: mediaView(old), replayed: true } : null;
    });
    if (replay) return replay;
    let quotaAttempt: MediaBudgetAttempt | null = null;
    let beginAttempted = false;
    let budgetMediaId: string | undefined;
    try {
      if (this.budget) {
        budgetMediaId = randomUUID();
        const prepared = await this.budget.prepare({
          scope: 'activity-share',
          // Original business uniqueness crosses shares; the fingerprint already binds the exact share/name/raw.
          operationKey: `${actor.accountId}:${batchId}:${Number(batchIndex)}`,
          fingerprint,
          accountId: actor.accountId,
          rawBytes: BigInt(input.length),
          objectIdentity: `activity-share:${budgetMediaId}`
        });
        if (prepared.kind === 'owner') quotaAttempt = prepared.attempt;
        else if (prepared.kind === 'existing') {
          const existing = await this.auth.transaction(async (tx) => {
            const old = await inspect(tx);
            return old ? { media: mediaView(old), replayed: true } : null;
          });
          if (existing) return existing;
          throw (await import('../media/budget-errors')).mediaUploadPendingError();
        }
      }
      const output = await withPhotoSlot(() => processPhoto(input, name)),
        mediaId = budgetMediaId ?? randomUUID();
      if (quotaAttempt) {
        await quotaAttempt.allocate(
          BigInt(output.original.length) + BigInt(output.preview.length) + BigInt(output.thumbnail.length)
        );
        beginAttempted = true;
        await quotaAttempt.begin();
      }
      await this.storage.put(mediaId, output);
      try {
        const result = await this.auth.transaction(async (tx) => {
          const old = await inspect(tx);
          const media =
            old ??
            (await tx.activityShareMedia.create({
              data: {
                id: mediaId,
                shareId: k,
                ownerId: actor.accountId,
                batchId,
                batchIndex: Number(batchIndex),
                fingerprint,
                mime: output.mime,
                width: output.width,
                height: output.height,
                frames: output.frames,
                createdAt: this.auth.now()
              }
            }));
          await this.fresh(tx, token, actor);
          if (quotaAttempt && !old) {
            await quotaAttempt.commit(tx);
            // Existing actor/share locks are held. Only re-read original role/session policy after quota waiting.
            await this.fresh(tx, token, actor);
          }
          return { media: mediaView(media), replayed: Boolean(old) };
        });
        if (result.replayed) {
          await this.storage.discardUncommitted(mediaId);
          if (quotaAttempt) await quotaAttempt.unknown().catch(() => undefined);
        }
        return result;
      } catch (error) {
        if (!this.budget) {
          const exists = await this.auth.db.activityShareMedia
            .findUnique({ where: { id: mediaId }, select: { id: true } })
            .catch(() => undefined);
          if (exists === null) await this.storage.discardUncommitted(mediaId).catch(() => undefined);
        }
        throw error;
      }
    } catch (error) {
      if (!this.budget) throw error;
      if (quotaAttempt) {
        try {
          if (beginAttempted) await quotaAttempt.unknown();
          else await quotaAttempt.failBeforePersistence();
        } catch {
          // Preserve the original failure and conservative begun/committed accounting.
        }
      }
      throw (await import('../media/budget-errors')).mediaBudgetError(error);
    }
  }
  private async authorizeMedia(k: string, variant: PhotoVariant, token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const actor =
        token != null || variant === 'original'
          ? await this.auth.requireAccount(tx, token, variant === 'original')
          : null;
      const m = await tx.activityShareMedia.findUnique({
        where: { id: k },
        select: { shareId: true, mime: true }
      });
      if (!m) missing();
      await lock(tx, 'activity-share:' + m.shareId);
      const row = await this.row(tx, m.shareId);
      if (!actor || actor.account.adminRole === 'NONE') {
        if (variant === 'original' || !row.mediaIds.includes(k) || !publicAllowed(row)) missing();
      }
      if (actor) await this.fresh(tx, token, actor, variant === 'original');
      return { mime: variant === 'original' ? m.mime : 'image/webp' };
    });
  }
  async media(k: string, variant: string, token?: string | null) {
    id(k);
    if (!['original', 'preview', 'thumbnail'].includes(variant)) invalid('图片版本无效');
    await this.authorizeMedia(k, variant as PhotoVariant, token);
    let bytes: Buffer;
    try {
      bytes = await this.storage.read(k, variant as PhotoVariant);
    } catch {
      missing();
    }
    const meta = await this.authorizeMedia(k, variant as PhotoVariant, token);
    return { bytes, ...meta };
  }
  async publicInfo(token?: string | null) {
    const actor = token != null ? await this.auth.requireAccount(this.auth.db, token) : null;
    if (actor) await this.fresh(this.auth.db, token, actor, false);
    return { contactAvailable: true };
  }
}
