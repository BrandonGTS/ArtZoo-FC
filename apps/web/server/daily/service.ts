import { emitMessage } from '../messages/emit';
import { AccountError } from '@artzoo/domain';
import { randomUUID, createHash } from 'node:crypto';
import { visibleCommentIds, commentSubtreeIds } from './comment-tree';
import type { Prisma, MediaBudgetAttempt, createMediaBudgetAdapter } from '@artzoo/db';
import { AccountService, lock, lockShared } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import { memberSelect, memberSummary } from '../members/service';
import { processPhoto, withPhotoSlot, dailyStorage, type PhotoStorage, type PhotoVariant } from './media';
import { PHOTO_RULES } from '../media/photo-contract';
import {
  bad,
  conflict,
  denied,
  missing,
  id,
  ids,
  text,
  revision,
  containsMention,
  mentionLabel,
  type DailyPostView,
  type DailyCommentView
} from './contract';
type Tx = Prisma.TransactionClient;
const select = {
  id: true,
  body: true,
  mentions: true,
  authorId: true,
  author: { select: memberSelect },
  createdAt: true,
  editedAt: true,
  revision: true,
  removedAt: true,
  comments: { select: { id: true, parentId: true, removedAt: true } },
  media: {
    where: { removedAt: null, commentId: null },
    orderBy: [{ position: 'asc' as const }, { id: 'asc' as const }]
  },
  _count: { select: { likes: true } }
} as const satisfies Prisma.DailyPostSelect;
type Row = Prisma.DailyPostGetPayload<{ select: typeof select }>;
const commentSelect = {
  id: true,
  body: true,
  authorId: true,
  author: { select: memberSelect },
  parentId: true,
  parent: { select: { author: { select: memberSelect } } },
  createdAt: true,
  revision: true,
  removedAt: true,
  media: { where: { removedAt: null }, orderBy: [{ position: 'asc' as const }, { id: 'asc' as const }] }
} satisfies Prisma.DailyCommentSelect;
export class DailyService {
  constructor(
    readonly auth: AccountService,
    readonly storage: PhotoStorage = dailyStorage(),
    readonly budget: ReturnType<typeof createMediaBudgetAdapter> | null = null
  ) {}
  private async actor(
    tx: Tx,
    token: string | null | undefined,
    actor: Awaited<ReturnType<AccountService['requireAccount']>>
  ) {
    await lock(tx, `phone:${actor.account.phone}`);
    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${actor.accountId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${actor.id} FOR UPDATE`;
    const fresh = await this.auth.requireAccount(tx, token);
    if (fresh.accountId !== actor.accountId) denied('请重新登录');
    return fresh;
  }
  private async post(tx: Tx, key: string) {
    const row = await tx.dailyPost.findUnique({ where: { id: key }, select });
    if (!row || row.removedAt) missing();
    return row;
  }
  private async view(
    tx: Tx,
    row: Row,
    actorId: string,
    admin = false,
    liked?: boolean
  ): Promise<DailyPostView> {
    return {
      id: row.id,
      body: row.body,
      mentions: row.mentions,
      author: memberSummary(row.author),
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
      revision: row.revision,
      media: row.media.map((m) => ({
        id: m.id,
        width: m.width,
        height: m.height,
        frames: m.frames,
        thumbnailUrl: `/api/daily/media/${m.id}?variant=thumbnail`,
        previewUrl: `/api/daily/media/${m.id}?variant=preview`
      })),
      likes: row._count.likes,
      liked:
        liked ??
        !!(await tx.dailyLike.findUnique({
          where: { postId_accountId: { postId: row.id, accountId: actorId } }
        })),
      comments: visibleCommentIds(row.comments).size,
      canEdit: row.authorId === actorId,
      canModerate: admin
    };
  }
  private async listViews(tx: Tx, rows: Row[], actorId: string, admin: boolean) {
    if (!rows.length) return [];
    const likes = await tx.dailyLike.findMany({
        where: { accountId: actorId, postId: { in: rows.map((row) => row.id) } },
        select: { postId: true }
      }),
      likedIds = new Set(likes.map((like) => like.postId));
    return Promise.all(rows.map((row) => this.view(tx, row, actorId, admin, likedIds.has(row.id))));
  }
  private async listPage(url: URL, token?: string | null) {
    const raw = url.searchParams.get('page')!;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || url.searchParams.has('before'))
      bad('页码无效');
    const author = url.searchParams.get('author'),
      where = { removedAt: null, ...(author ? { authorId: id(author) } : {}) };
    // Count and rows share one snapshot, including when another author publishes or deletes.
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.auth.requireAccount(tx, token),
          total = await tx.dailyPost.count({ where });
        const totalPages = Math.max(1, Math.ceil(total / 10)),
          page = Math.min(Number(raw), totalPages);
        const rows = await tx.dailyPost.findMany({
          where,
          select,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * 10,
          take: 10
        });
        return {
          items: await this.listViews(tx, rows, actor.accountId, actor.account.adminRole !== 'NONE'),
          next: null,
          page,
          totalPages,
          total
        };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 }
    );
  }
  async list(url: URL, token?: string | null) {
    if (url.searchParams.has('page')) return this.listPage(url, token);
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token),
        author = url.searchParams.get('author'),
        raw = url.searchParams.get('before');
      let cursor: { createdAt: Date; id: string } | null = null;
      if (raw) {
        try {
          const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
          cursor = { createdAt: new Date(value.time), id: id(value.id) };
          if (!Number.isFinite(cursor.createdAt.getTime())) bad('分页标识无效');
        } catch {
          bad('分页标识无效');
        }
      }
      const rows = await tx.dailyPost.findMany({
        where: {
          removedAt: null,
          ...(author ? { authorId: id(author) } : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } }
                ]
              }
            : {})
        },
        select,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 11
      });
      const page = rows.slice(0, 10),
        last = page.at(-1);
      return {
        items: await this.listViews(tx, page, actor.accountId, actor.account.adminRole !== 'NONE'),
        next:
          rows.length > 10 && last
            ? Buffer.from(JSON.stringify({ time: last.createdAt.toISOString(), id: last.id })).toString(
                'base64url'
              )
            : null
      };
    });
  }
  async get(key: string, token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token);
      return this.view(tx, await this.post(tx, id(key)), actor.accountId, actor.account.adminRole !== 'NONE');
    });
  }
  private async mentions(tx: Tx, body: string, values: unknown) {
    const targets = ids(values);
    if (targets.length > 50) bad('提及成员过多');
    const people = await tx.account.findMany({
      where: { id: { in: targets } },
      select: { id: true, displayName: true, gameServer: true }
    });
    if (people.length !== targets.length) bad('提及的成员已变化');
    for (const p of people) {
      if (!p.displayName) bad('提及的成员尚未填写昵称');
      const duplicates = await tx.account.count({ where: { displayName: p.displayName } });
      if (!containsMention(body, mentionLabel(p, duplicates > 1)))
        bad('提及文字与所选成员不一致，请重新选择');
    }
    return targets;
  }
  private async notify(
    tx: Tx,
    postId: string,
    commentId: string | null,
    recipients: string[],
    actorId: string,
    key: string,
    kind: string
  ) {
    const now = this.auth.now();
    for (const recipientId of new Set(recipients.filter((x) => x !== actorId)))
      await tx.dailyNotification.create({
        data: { postId, commentId, recipientId, eventKey: `${key}:${recipientId}`, kind, createdAt: now }
      });
  }
  private async run(
    kind: string,
    body: Record<string, unknown>,
    token: string | null | undefined,
    mutate: (tx: Tx, actorId: string, admin: boolean) => Promise<string>
  ) {
    const key = id(body.submissionKey),
      fingerprint = tokenDigest(JSON.stringify({ kind, body })),
      actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`daily-write:${actor.accountId}`, 120, 900);
    return this.auth.transaction(async (tx) => {
      const fresh = await this.actor(tx, token, actor);
      await lock(tx, `daily-command:${fresh.accountId}:${key}`);
      await lock(tx, `daily-media:${fresh.accountId}`);
      const confirmActor = async () => {
        const current = await this.auth.requireAccount(tx, token);
        if (
          current.id !== fresh.id ||
          current.accountId !== fresh.accountId ||
          current.account.membership !== fresh.account.membership ||
          current.account.adminRole !== fresh.account.adminRole
        )
          denied('账号身份已变化，请重新登录');
      };
      const previous = await tx.dailyCommand.findUnique({
        where: { actorId_submissionKey: { actorId: fresh.accountId, submissionKey: key } }
      });
      if (previous) {
        if (previous.fingerprint !== fingerprint) conflict('上次提交内容已变化，请先确认原操作结果');
        await confirmActor();
        return { id: previous.resultId, replayed: true };
      }
      const resultId = await mutate(tx, fresh.accountId, fresh.account.adminRole !== 'NONE');
      await this.auth.requireAccount(tx, token);
      await tx.dailyCommand.create({
        data: {
          actorId: fresh.accountId,
          submissionKey: key,
          fingerprint,
          resultId,
          createdAt: this.auth.now()
        }
      });
      // The final insert can wait on database locks after the earlier guard.
      // Recheck after it so an expired session rolls back content, notices and command together.
      await confirmActor();
      return { id: resultId, replayed: false };
    });
  }
  private async attach(tx: Tx, postId: string, actorId: string, values: unknown) {
    const mediaIds = ids(values),
      media = await tx.dailyMedia.findMany({ where: { id: { in: mediaIds } } });
    if (
      media.length !== mediaIds.length ||
      media.some(
        (m) => m.ownerId !== actorId || m.removedAt || m.commentId || (m.postId && m.postId !== postId)
      )
    )
      denied('部分图片不可用于此动态');
    if (mediaIds.length && (await (await import('@artzoo/db')).dailyMediaFencedTx(tx, actorId, mediaIds)))
      denied('部分图片不可用于此动态');
    await tx.dailyMedia.updateMany({
      where: { postId, commentId: null, id: { notIn: mediaIds } },
      data: { removedAt: this.auth.now() }
    });
    for (let position = 0; position < mediaIds.length; position++)
      await tx.dailyMedia.update({ where: { id: mediaIds[position] }, data: { postId, position } });
    return mediaIds;
  }
  async create(body: Record<string, unknown>, token?: string | null) {
    return this.run('create', body, token, async (tx, actorId) => {
      const content = text(body.body),
        mediaIds = ids(body.mediaIds);
      if (!content && !mediaIds.length) bad('请填写正文或选择图片');
      const mentions = await this.mentions(tx, content, body.mentions);
      const post = await tx.dailyPost.create({
        data: { authorId: actorId, body: content, mentions, createdAt: this.auth.now() }
      });
      await this.attach(tx, post.id, actorId, mediaIds);
      await this.notify(tx, post.id, null, mentions, actorId, `daily-post:${post.id}`, 'MENTION');
      return post.id;
    });
  }
  async update(key: string, body: Record<string, unknown>, token?: string | null) {
    return this.run('edit:' + id(key), body, token, async (tx, actorId) => {
      await lock(tx, `daily-post:${key}`);
      const row = await this.post(tx, key);
      if (row.authorId !== actorId) denied('仅作者可以编辑动态');
      if (row.revision !== revision(body.revision)) conflict();
      const content = text(body.body),
        mediaIds = ids(body.mediaIds);
      if (!content && !mediaIds.length) bad('请填写正文或选择图片');
      const mentions = await this.mentions(tx, content, body.mentions);
      await this.attach(tx, key, actorId, mediaIds);
      await tx.dailyPost.update({
        where: { id: key },
        data: { body: content, mentions, editedAt: this.auth.now(), revision: { increment: 1 } }
      });
      await this.notify(
        tx,
        key,
        null,
        mentions.filter((x) => !row.mentions.includes(x)),
        actorId,
        `daily-edit:${body.submissionKey}`,
        'MENTION'
      );
      return key;
    });
  }
  async remove(key: string, body: Record<string, unknown>, token?: string | null) {
    return this.run('remove:' + id(key), body, token, async (tx, actorId) => {
      await lock(tx, `daily-post:${key}`);
      const row = await this.post(tx, key);
      if (row.authorId !== actorId) denied('仅作者可以删除动态');
      if (row.revision !== revision(body.revision)) conflict();
      await tx.dailyPost.update({
        where: { id: key },
        data: { removedAt: this.auth.now(), revision: { increment: 1 } }
      });
      await tx.dailyAudit.create({
        data: { postId: key, actorId, action: 'AUTHOR_REMOVE', createdAt: this.auth.now() }
      });
      return key;
    });
  }
  async comments(key: string, token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token);
      await this.post(tx, id(key));
      const rows = await tx.dailyComment.findMany({
        where: { postId: key },
        select: commentSelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      });
      const visible = visibleCommentIds(rows);
      return {
        items: rows
          .filter((c) => visible.has(c.id))
          .map(
            (c) =>
              ({
                id: c.id,
                body: c.removedAt ? '评论已删除' : c.body,
                author: memberSummary(c.author),
                parentId: c.parentId,
                replyTo: c.parent ? memberSummary(c.parent.author) : null,
                createdAt: c.createdAt.toISOString(),
                revision: c.revision,
                removed: !!c.removedAt,
                canDelete: !c.removedAt && c.authorId === actor.accountId,
                canModerate: !c.removedAt && actor.account.adminRole !== 'NONE',
                media: c.removedAt
                  ? []
                  : c.media.map((m) => ({
                      id: m.id,
                      width: m.width,
                      height: m.height,
                      frames: m.frames,
                      thumbnailUrl: `/api/daily/media/${m.id}?variant=thumbnail`,
                      previewUrl: `/api/daily/media/${m.id}?variant=preview`
                    }))
              }) satisfies DailyCommentView
          )
      };
    });
  }
  async comment(key: string, body: Record<string, unknown>, token?: string | null) {
    return this.run('comment:' + id(key), body, token, async (tx, actorId) => {
      await lock(tx, `daily-post:${key}`);
      const post = await this.post(tx, key),
        content = text(body.body, 2000),
        mediaIds = ids(body.mediaIds ?? []),
        mentions = await this.mentions(tx, content, body.mentions),
        parentId = body.parentId == null ? null : id(body.parentId),
        parent = parentId ? await tx.dailyComment.findUnique({ where: { id: parentId } }) : null;
      if (!content && !mediaIds.length) bad('请填写正文或选择图片');
      if (mediaIds.length > PHOTO_RULES.maxBatch) bad('每次最多选择10张图片');
      const media = await tx.dailyMedia.findMany({ where: { id: { in: mediaIds } } });
      if (
        media.length !== mediaIds.length ||
        media.some((m) => m.ownerId !== actorId || m.removedAt || m.postId || m.commentId)
      )
        denied('部分图片不可用于此评论');
      if (parentId && (!parent || parent.postId !== key || !visibleCommentIds(post.comments).has(parentId)))
        bad('回复的评论不存在或已删除');
      if (mediaIds.length && (await (await import('@artzoo/db')).dailyMediaFencedTx(tx, actorId, mediaIds)))
        denied('部分图片不可用于此评论');
      const c = await tx.dailyComment.create({
        data: {
          postId: key,
          authorId: actorId,
          body: content,
          mentions,
          parentId,
          createdAt: this.auth.now()
        }
      });
      for (let position = 0; position < mediaIds.length; position++)
        await tx.dailyMedia.update({
          where: { id: mediaIds[position] },
          data: { postId: key, commentId: c.id, position }
        });
      await this.notify(
        tx,
        key,
        c.id,
        [post.authorId, ...(parent ? [parent.authorId] : []), ...mentions],
        actorId,
        `daily-comment:${c.id}`,
        'COMMENT'
      );
      return c.id;
    });
  }
  // All callers hold daily-post; comment creation takes the same lock before validating ancestry.
  private async removeCommentTree(tx: Tx, postId: string, rootId: string) {
    const rows = await tx.dailyComment.findMany({ where: { postId }, select: { id: true, parentId: true } });
    const branch = commentSubtreeIds(rows, rootId);
    await tx.dailyComment.updateMany({
      where: { postId, id: { in: [...branch] }, removedAt: null },
      data: { removedAt: this.auth.now(), revision: { increment: 1 } }
    });
  }
  async removeComment(key: string, body: Record<string, unknown>, token?: string | null) {
    return this.run('removeComment:' + id(key), body, token, async (tx, actorId) => {
      const c = await tx.dailyComment.findUnique({ where: { id: key } });
      if (!c) missing();
      await lock(tx, `daily-post:${c.postId}`);
      await this.post(tx, c.postId);
      const fresh = await tx.dailyComment.findUnique({ where: { id: key } });
      if (!fresh || fresh.removedAt) missing();
      if (fresh.authorId !== actorId) denied('仅评论者可以删除本人评论');
      if (fresh.revision !== revision(body.revision)) conflict();
      await this.removeCommentTree(tx, c.postId, key);
      await tx.dailyAudit.create({
        data: {
          actorId,
          postId: c.postId,
          commentId: key,
          action: 'AUTHOR_REMOVE_COMMENT',
          createdAt: this.auth.now()
        }
      });
      return key;
    });
  }
  async moderate(key: string, body: Record<string, unknown>, token?: string | null) {
    return this.run('moderate:' + id(key), body, token, async (tx, actorId, admin) => {
      if (!admin) denied('仅管理员可以处理违规内容');
      const reason = text(body.reason, 1000, true);
      await lock(tx, `daily-post:${key}`);
      await this.post(tx, key);
      const commentId = body.commentId == null ? null : id(body.commentId);
      if (commentId) {
        const c = await tx.dailyComment.findUnique({ where: { id: commentId } });
        if (!c || c.postId !== key || c.removedAt) missing();
        if (c.revision !== revision(body.revision)) conflict();
        await this.removeCommentTree(tx, key, commentId);
      } else {
        const p = await this.post(tx, key);
        if (p.revision !== revision(body.revision)) conflict();
        await tx.dailyPost.update({
          where: { id: key },
          data: { removedAt: this.auth.now(), revision: { increment: 1 } }
        });
      }
      await tx.dailyAudit.create({
        data: {
          postId: key,
          commentId,
          actorId,
          reason,
          action: 'MODERATE_REMOVE',
          createdAt: this.auth.now()
        }
      });
      return key;
    });
  }
  async like(key: string, body: Record<string, unknown>, token?: string | null) {
    if (typeof body.liked !== 'boolean') bad('点赞状态无效');
    const liked = body.liked;
    return this.run('like:' + id(key), body, token, async (tx, actorId) => {
      await lock(tx, `daily-post:${key}`);
      const post = await this.post(tx, key);
      if (liked) {
        await tx.dailyLike.upsert({
          where: { postId_accountId: { postId: key, accountId: actorId } },
          create: { postId: key, accountId: actorId },
          update: {}
        });
        await emitMessage(tx, {
          recipientId: post.authorId,
          actorId,
          kind: 'LIKE',
          sourceType: 'daily',
          sourceId: key,
          eventKey: `like:daily:${key}:${actorId}`,
          createdAt: this.auth.now()
        });
      } else await tx.dailyLike.deleteMany({ where: { postId: key, accountId: actorId } });
      return key;
    });
  }
  async upload(fields: Record<string, unknown>, input: Buffer, name: string, token?: string | null) {
    const batchId = id(fields.batchId),
      batchIndex = fields.batchIndex;
    if (
      typeof batchIndex !== 'number' ||
      !Number.isInteger(batchIndex) ||
      batchIndex < 0 ||
      batchIndex >= PHOTO_RULES.maxBatch
    )
      bad('每次最多选择10张图片');
    if (!input.length || input.length > PHOTO_RULES.maxBytes) bad('每张图片最多30MiB');
    const actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate(`daily-upload:${actor.accountId}`, 100, 900);
    const fingerprint = tokenDigest(Buffer.concat([Buffer.from(name + '\0'), input]).toString('base64'));
    const inspect = async (tx: Tx) => {
      const fresh = await this.actor(tx, token, actor);
      await lock(tx, `daily-media:${fresh.accountId}`);
      await this.auth.requireAccount(tx, token);
      const old = await tx.dailyMedia.findUnique({
        where: { ownerId_batchId_batchIndex: { ownerId: fresh.accountId, batchId, batchIndex } }
      });
      if (old && old.fingerprint !== fingerprint) conflict('同次上传内容已变化');
      if (old && (await (await import('@artzoo/db')).dailyMediaFencedTx(tx, fresh.accountId, [old.id])))
        denied('图片已过期，请重新上传');
      await this.auth.requireAccount(tx, token);
      return { fresh, old };
    };
    const replay = await this.auth.transaction(async (tx) => {
      const { old } = await inspect(tx);
      return old ? { id: old.id, replayed: true } : null;
    });
    if (replay) return replay;
    let quotaAttempt: MediaBudgetAttempt | null = null;
    let beginAttempted = false;
    let budgetMediaId: string | undefined;
    let photoNamespaces: Awaited<ReturnType<NonNullable<PhotoStorage['writePhotoNamespaces']>>> | undefined;
    let photoAllocation: import('@artzoo/db').MediaBoundAllocationTicket | undefined;
    const photoProofs: import('@artzoo/media/stock-retirement').MediaWriteProof[] = [];
    try {
      if (this.budget) {
        budgetMediaId = randomUUID();
        const prepared = await this.budget.prepare({
          scope: 'daily',
          operationKey: `${actor.accountId}:${batchId}:${batchIndex}`,
          fingerprint,
          accountId: actor.accountId,
          rawBytes: BigInt(input.length),
          objectIdentity: `daily:${budgetMediaId}`
        });
        if (prepared.kind === 'owner') quotaAttempt = prepared.attempt;
        else if (prepared.kind === 'existing') {
          const existing = await this.auth.transaction(async (tx) => {
            const { old } = await inspect(tx);
            return old ? { id: old.id, replayed: true } : null;
          });
          if (existing) return existing;
          throw (await import('../media/budget-errors')).mediaUploadPendingError();
        }
      }
      const output = await withPhotoSlot(() => processPhoto(input, name)),
        mediaId = budgetMediaId ?? randomUUID();
      if (quotaAttempt) {
        if (this.storage.writePhotoNamespaces || this.storage.boundPhotoNamespaces) {
          photoNamespaces = await (this.storage.writePhotoNamespaces ??
            this.storage.boundPhotoNamespaces)!.call(this.storage, 'daily');
          photoAllocation = await quotaAttempt.allocateBoundComponents({
            kind: 'photo',
            scope: 'daily',
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
          // Custom byte-only ports stay opaque and cannot enroll orphan candidates.
          await quotaAttempt.allocate(
            BigInt(output.original.length) + BigInt(output.preview.length) + BigInt(output.thumbnail.length)
          );
        }
        beginAttempted = true;
        await quotaAttempt.begin();
      }
      await this.storage.put(mediaId, output);
      if (photoNamespaces && photoAllocation) {
        for (const variant of ['original', 'preview', 'thumbnail'] as const) {
          const namespace = variant === 'original' ? photoNamespaces.original : photoNamespaces.derived;
          photoProofs.push(
            await namespace.capture(
              mediaId,
              ('photo-' + variant) as 'photo-original' | 'photo-preview' | 'photo-thumbnail',
              createHash('sha256').update(output[variant]).digest('hex'),
              BigInt(output[variant].length)
            )
          );
        }
      }
      try {
        return await this.auth
          .transaction(async (tx) => {
            const { fresh, old } = await inspect(tx);
            if (old) return { id: old.id, replayed: true };
            await tx.dailyMedia.create({
              data: {
                id: mediaId,
                ownerId: fresh.accountId,
                batchId,
                batchIndex,
                fingerprint,
                mime: output.mime,
                width: output.width,
                height: output.height,
                frames: output.frames,
                createdAt: this.auth.now()
              }
            });
            if (quotaAttempt) {
              await quotaAttempt.commit(tx);
              if (photoAllocation)
                await (
                  await import('@artzoo/media/stock-retirement')
                ).bindDailyPhotoWrite(tx, photoAllocation, fresh.accountId, mediaId, photoProofs);
              // Only a fresh ordinary SELECT after quota waiting; existing actor locks are already held.
              const afterBudget = await this.auth.requireAccount(tx, token);
              if (afterBudget.id !== fresh.id || afterBudget.accountId !== fresh.accountId)
                throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
            }
            return { id: mediaId, replayed: false };
          })
          .then(async (result) => {
            if (result.replayed) {
              await this.storage.discardUncommitted(mediaId);
              if (quotaAttempt) await quotaAttempt.unknown().catch(() => undefined);
            }
            return result;
          });
      } catch (error) {
        // A lost commit acknowledgement is not proof of rollback. Retain bytes on uncertain DB errors.
        if (!this.budget) {
          const row = await this.auth.db.dailyMedia
            .findUnique({ where: { id: mediaId } })
            .catch(() => undefined);
          if (row === null) await this.storage.discardUncommitted(mediaId);
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
          // Never replace the original failure or release an uncertain begun attempt.
        }
      }
      throw (await import('../media/budget-errors')).mediaBudgetError(error);
    }
  }
  async media(key: string, variant: string, token?: string | null) {
    if (!['original', 'preview', 'thumbnail'].includes(variant)) bad('图片版本无效');
    const retry = Symbol('daily-media-attachment-changed');
    const authorize = async (expected?: { id: string; accountId: string }) => {
      let expectedActor = expected;
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await this.auth.transaction(async (tx) => {
          const actor = await this.auth.requireAccount(tx, token);
          if (expectedActor && (actor.id !== expectedActor.id || actor.accountId !== expectedActor.accountId))
            throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
          expectedActor ??= actor;
          const pointer = await tx.dailyMedia.findUnique({
            where: { id: id(key) },
            include: { post: true, comment: true }
          });
          if (!pointer || pointer.removedAt) missing();
          await lockShared(
            tx,
            pointer.postId ? `daily-post:${pointer.postId}` : `daily-media:${pointer.ownerId}`
          );
          const afterLock = await this.auth.requireAccount(tx, token);
          if (afterLock.id !== actor.id || afterLock.accountId !== actor.accountId)
            throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
          const current = await tx.dailyMedia.findUnique({
            where: { id: key },
            include: { post: true, comment: true }
          });
          if (!current || current.removedAt) missing();
          // Attachment may have committed before our old lock was acquired.
          // A fresh transaction chooses the new lock, without reversing writers' order.
          if (current.postId !== pointer.postId || current.ownerId !== pointer.ownerId) return retry;
          if (
            current.post?.removedAt ||
            current.comment?.removedAt ||
            (!current.postId && current.ownerId !== actor.accountId)
          )
            missing();
          if (
            !current.postId &&
            (await (await import('@artzoo/db')).dailyMediaFencedTx(tx, current.ownerId, [current.id]))
          )
            missing();
          if (current.commentId && current.postId) {
            const ancestry = await tx.dailyComment.findMany({
              where: { postId: current.postId },
              select: { id: true, parentId: true, removedAt: true }
            });
            if (!visibleCommentIds(ancestry).has(current.commentId)) missing();
          }
          const fresh = await this.auth.requireAccount(tx, token);
          if (fresh.id !== actor.id || fresh.accountId !== actor.accountId)
            throw new AccountError('UNAUTHENTICATED', '请重新登录', 401);
          return { actor, mime: variant === 'original' ? current.mime : 'image/webp' };
        });
        if (result !== retry) return result;
      }
      throw new AccountError('CONFLICT', '图片所属内容已变化，请重试', 409);
    };
    const initial = await authorize();
    // Shared locks protect short authorization reads, never the file I/O.
    const bytes = await this.storage.read(key, variant as PhotoVariant);
    const current = await authorize(initial.actor);
    return { bytes, mime: current.mime };
  }

  async audits(key: string, token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token);
      if (actor.account.adminRole === 'NONE') denied('仅管理员可以查看处理记录');
      if (!(await tx.dailyPost.findUnique({ where: { id: id(key) }, select: { id: true } }))) missing();
      return {
        items: await tx.dailyAudit
          .findMany({
            where: { postId: key },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              action: true,
              reason: true,
              createdAt: true,
              commentId: true,
              actor: { select: memberSelect }
            }
          })
          .then((rows) => rows.map((a) => ({ ...a, actor: memberSummary(a.actor) })))
      };
    });
  }
  async notifications(token?: string | null) {
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token);
      return {
        items: await tx.dailyNotification.findMany({
          where: { recipientId: actor.accountId, deletedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 100,
          select: { id: true, postId: true, commentId: true, kind: true, createdAt: true, readAt: true }
        })
      };
    });
  }
}
