import { moderationInput } from '../content-moderation/contract';
import { emitMessage } from '../messages/emit';
import { ids, containsMention, mentionLabel, type DailyMediaView } from '../daily/contract';
import { PHOTO_RULES } from '../media/photo-contract';
import { processPhoto, withPhotoSlot, wishStorage, type PhotoStorage, type PhotoVariant } from './media';
import { randomUUID, createHash } from 'node:crypto';
import { sampleHomeWishIds } from './home-sample';
import type { Prisma } from '@artzoo/db';
import { AccountError, activityId } from '@artzoo/domain';
import { AccountService, lock, lockShared } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import { createWishActivity } from './activity-adapter';
import { ActivityService, activitySelect, activitySummary } from '../activities/service';
import { memberSelect, memberSummary } from '../members/service';
import {
  fields,
  key,
  pageNumber,
  publishInput,
  text,
  invalid,
  wishContent,
  wishCategory,
  WISH_PAGE_SIZE,
  WISH_INTEREST_PAGE_SIZE,
  type WishInterestList,
  type WishHomeList,
  type WishDetail,
  type WishSummary,
  type WishList,
  type WishWrite,
  type WishDelete,
  type WishComment
} from './contract';
type Tx = Prisma.TransactionClient;
type Actor = Awaited<ReturnType<AccountService['requireAccount']>>;
type Row = {
  id: string;
  authorId: string;
  title: string;
  category: WishSummary['category'];
  body: string;
  wantedContent: string;
  convenientTime: string;
  createdAt: Date;
  activityId: string | null;
  idempotencyKey: string;
  requestFingerprint: string;
  revision: number;
  deletedAt: Date | null;
  moderatedAt: Date | null;
};
type WishCounts = { interestCount: number; commentCount: number; interested: boolean };
type WishAuthor = Prisma.AccountGetPayload<{ select: typeof memberSelect }>;
type ListSummaryContext = {
  counts: Map<string, WishCounts>;
  authors: Map<string, WishAuthor>;
  activities: Map<string, Prisma.ActivityGetPayload<{ select: typeof activitySelect }>>;
};
type MediaRow = {
  id: string;
  ownerId: string;
  wishId: string | null;
  commentId: string | null;
  batchId: string;
  batchIndex: number;
  fingerprint: string;
  mime: string;
  width: number;
  height: number;
  frames: number;
  position: number;
  removedAt: Date | null;
};
const forbidden = (message: string): never => {
  throw new AccountError('FORBIDDEN', message, 403);
};
const conflict = (message: string): never => {
  throw new AccountError('CONFLICT', message, 409);
};
export class WishService {
  constructor(
    readonly auth: AccountService,
    readonly storage: PhotoStorage = wishStorage()
  ) {}
  private async actorLocked(
    tx: Tx,
    token: string | null | undefined,
    actor: Awaited<ReturnType<AccountService['requireAccount']>>
  ) {
    await lock(tx, 'phone:' + actor.account.phone);
    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${actor.accountId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${actor.id} FOR UPDATE`;
    return this.fresh(tx, token, actor);
  }
  private async fresh(tx: Tx, token: string | null | undefined, expected: Actor) {
    const actor = await this.auth.requireAccount(tx, token);
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
  private async row(tx: Tx, id: string, includeDeleted = false) {
    const [row] = await tx.$queryRaw<Row[]>`SELECT * FROM "Wish" WHERE "id"=${id}`;
    if (!row || (!includeDeleted && (row.deletedAt || row.moderatedAt)))
      throw new AccountError('NOT_FOUND', '心愿不存在或已删除', 404);
    return row;
  }
  private async listSummaryContext(tx: Tx, rows: Row[], actorId: string): Promise<ListSummaryContext> {
    const wishIds = [...new Set(rows.map((row) => row.id))];
    const counts = await tx.$queryRaw<(WishCounts & { wishId: string })[]>`WITH selected AS (
      SELECT unnest(${wishIds}::text[]) AS id
    ), interests AS (
      SELECT i."wishId",count(*)::int AS "interestCount",
        bool_or(i."accountId"=${actorId}) AS interested
      FROM "WishInterest" i JOIN selected s ON s.id=i."wishId"
      WHERE i.active GROUP BY i."wishId"
    ), comments AS (
      SELECT c."wishId",count(*)::int AS "commentCount"
      FROM "WishComment" c JOIN selected s ON s.id=c."wishId"
      GROUP BY c."wishId"
    )
    SELECT s.id AS "wishId",coalesce(i."interestCount",0)::int AS "interestCount",
      coalesce(c."commentCount",0)::int AS "commentCount",
      coalesce(i.interested,FALSE) AS interested
    FROM selected s LEFT JOIN interests i ON i."wishId"=s.id
    LEFT JOIN comments c ON c."wishId"=s.id`;
    const authors = await tx.account.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.authorId))] } },
      select: memberSelect
    });
    const activityIds = [...new Set(rows.flatMap((row) => (row.activityId ? [row.activityId] : [])))];
    const activities = activityIds.length
      ? await tx.activity.findMany({ where: { id: { in: activityIds } }, select: activitySelect })
      : [];
    return {
      activities: new Map(activities.map((activity) => [activity.id, activity])),
      counts: new Map(
        counts.map((row) => [
          row.wishId,
          {
            interestCount: row.interestCount,
            commentCount: row.commentCount,
            interested: row.interested
          }
        ])
      ),
      authors: new Map(authors.map((author) => [author.id, author]))
    };
  }
  private async summary(
    tx: Tx,
    row: Row,
    actorId: string,
    context?: ListSummaryContext
  ): Promise<WishSummary> {
    const precomputed = context?.counts.get(row.id);
    const counts = precomputed
      ? [precomputed]
      : await tx.$queryRaw<{ interestCount: number; commentCount: number; interested: boolean }[]>`SELECT
    (SELECT count(*)::int FROM "WishInterest" WHERE "wishId"=${row.id} AND active) AS "interestCount",
    (SELECT count(*)::int FROM "WishComment" WHERE "wishId"=${row.id}) AS "commentCount",
    EXISTS(SELECT 1 FROM "WishInterest" WHERE "wishId"=${row.id} AND "accountId"=${actorId} AND active) AS interested`;
    const author =
      context?.authors.get(row.authorId) ??
      (await tx.account.findUniqueOrThrow({ where: { id: row.authorId }, select: memberSelect }));
    const activity = await (row.activityId
      ? (context?.activities.get(row.activityId) ??
        tx.activity.findUniqueOrThrow({ where: { id: row.activityId }, select: activitySelect }))
      : null);
    return {
      id: row.id,
      title: row.title,
      category: row.category,
      body: wishContent(row),
      wantedContent: '',
      convenientTime: row.convenientTime,
      revision: row.revision,
      author: memberSummary(author),
      createdAt: row.createdAt.toISOString(),
      ...counts[0]!,
      isAuthor: row.authorId === actorId,
      activity: activity ? activitySummary(activity, actorId, this.auth.now()) : null
    };
  }
  private async commentPage(tx: Tx, id: string, page = 1, commentId?: string | null) {
    if (commentId) {
      const [position] = await tx.$queryRaw<{ ordinal: number }[]>`WITH RECURSIVE ancestry AS (
    SELECT id,"parentId","createdAt" FROM "WishComment" WHERE id=${commentId} AND "wishId"=${id}
    UNION ALL SELECT p.id,p."parentId",p."createdAt" FROM "WishComment" p JOIN ancestry c ON c."parentId"=p.id WHERE p."wishId"=${id}
   ) SELECT (SELECT count(*)::int FROM "WishComment" r WHERE r."wishId"=${id} AND r."parentId" IS NULL
    AND (r."createdAt",r.id)<=(root."createdAt",root.id)) AS ordinal FROM ancestry root WHERE root."parentId" IS NULL`;
      if (!position) throw new AccountError('NOT_FOUND', '留言不存在', 404);
      page = Math.floor((position.ordinal - 1) / 20) + 1;
    }
    const [count] = await tx.$queryRaw<
      { total: number }[]
    >`SELECT count(*)::int AS total FROM "WishComment" WHERE "wishId"=${id} AND "parentId" IS NULL`;
    const total = count!.total,
      totalPages = Math.max(1, Math.ceil(total / 20));
    page = Math.min(page, totalPages);
    const branch = await tx.$queryRaw<{ id: string }[]>`WITH RECURSIVE roots AS (
   SELECT id FROM "WishComment" WHERE "wishId"=${id} AND "parentId" IS NULL ORDER BY "createdAt",id LIMIT 20 OFFSET ${(page - 1) * 20}
  ), tree AS (
   SELECT c.id FROM "WishComment" c JOIN roots r ON r.id=c.id
   UNION ALL SELECT c.id FROM "WishComment" c JOIN tree p ON c."parentId"=p.id WHERE c."wishId"=${id}
  ) SELECT id FROM tree`;
    const rows = await tx.wishComment.findMany({
      where: { wishId: id, id: { in: branch.map((c) => c.id) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        body: true,
        createdAt: true,
        parentId: true,
        author: { select: memberSelect },
        parent: { select: { author: { select: memberSelect } } }
      }
    });
    const selectedIds = rows.map((c) => c.id);
    const extras = selectedIds.length
      ? await tx.$queryRaw<
          { id: string; mentions: string[] }[]
        >`SELECT id,mentions FROM "WishComment" WHERE "wishId"=${id} AND id=ANY(${selectedIds}::text[])`
      : [];
    const media = selectedIds.length
      ? await tx.$queryRaw<
          MediaRow[]
        >`SELECT * FROM "WishMedia" WHERE "wishId"=${id} AND "commentId"=ANY(${selectedIds}::text[]) AND "removedAt" IS NULL ORDER BY position,id`
      : [];
    const items: WishComment[] = [];
    for (const c of rows) {
      items.push({
        id: c.id,
        body: c.body,
        author: memberSummary(c.author),
        createdAt: c.createdAt.toISOString(),
        parentId: c.parentId,
        replyTo: c.parent ? memberSummary(c.parent.author) : null,
        mentions: extras.find((e) => e.id === c.id)?.mentions ?? [],
        media: media.filter((m) => m.commentId === c.id).map((m) => this.mediaView(m)),
        revision: 0,
        removed: false,
        canDelete: false,
        canModerate: false
      });
    }
    return { items, page, total, totalPages };
  }
  private mediaView(m: MediaRow): DailyMediaView {
    return {
      id: m.id,
      width: m.width,
      height: m.height,
      frames: m.frames,
      thumbnailUrl: `/api/wishes/media/${m.id}?variant=thumbnail`,
      previewUrl: `/api/wishes/media/${m.id}?variant=preview`
    };
  }
  private async detail(
    tx: Tx,
    id: string,
    actorId: string,
    page = 1,
    interestPage = 1,
    commentId?: string | null
  ): Promise<WishDetail> {
    const row = await this.row(tx, id),
      discussion = await this.commentPage(tx, id, page, commentId);
    const summary = await this.summary(tx, row, actorId),
      interests = await this.interestList(tx, id, interestPage, summary.interestCount);
    return {
      ...summary,
      canModerate:
        (
          await tx.account.findUniqueOrThrow({
            where: { id: actorId },
            select: { adminRole: true }
          })
        ).adminRole === 'SUPER_ADMIN',
      comments: discussion.items,
      commentPage: discussion.page,
      commentTotal: summary.commentCount,
      commentRootTotal: discussion.total,
      interests: interests.items,
      interestPage: interests.page
    };
  }
  private async interestList(tx: Tx, id: string, page: number, total?: number): Promise<WishInterestList> {
    total ??= await tx.wishInterest.count({ where: { wishId: id, active: true } });
    page = Math.min(page, Math.max(1, Math.ceil(total / WISH_INTEREST_PAGE_SIZE)));
    // updatedAt records the latest transition to active, so rejoining appends.
    // accountId breaks equal-time ties without changing existing membership.
    const rows = await tx.wishInterest.findMany({
      where: { wishId: id, active: true },
      orderBy: [{ updatedAt: 'asc' }, { accountId: 'asc' }],
      skip: (page - 1) * WISH_INTEREST_PAGE_SIZE,
      take: WISH_INTEREST_PAGE_SIZE,
      select: { account: { select: memberSelect } }
    });
    return {
      items: rows.map((i) => memberSummary(i.account)),
      total,
      page,
      pageSize: WISH_INTEREST_PAGE_SIZE
    };
  }
  async interests(id: string, url: URL, token?: string | null): Promise<WishInterestList> {
    activityId(id);
    const page = pageNumber(url.searchParams.get('page'));
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token);
      await this.row(tx, id);
      const result = await this.interestList(tx, id, page);
      await this.fresh(tx, token, actor);
      return result;
    });
  }
  async home(url: URL, token?: string | null): Promise<WishHomeList> {
    const previous = (url.searchParams.get('exclude') || '').split(',').filter(Boolean);
    if (previous.length > 2) invalid('上一批心愿数量无效');
    previous.forEach((id) => activityId(id));
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token);
      // Same visibility as list/get: authenticated accounts see undeleted wishes,
      // including legacy NULL categories. Read IDs only until the sample is chosen.
      const candidates = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "Wish" WHERE "deletedAt" IS NULL AND "moderatedAt" IS NULL`;
      const selected = sampleHomeWishIds(
        candidates.map((row) => row.id),
        previous
      );
      const rows = selected.length
        ? await tx.$queryRaw<
            Row[]
          >`SELECT * FROM "Wish" WHERE "deletedAt" IS NULL AND "moderatedAt" IS NULL AND id=ANY(${selected}::text[])`
        : [];
      const items: WishSummary[] = [];
      for (const id of selected) {
        const row = rows.find((row) => row.id === id);
        if (row) items.push(await this.summary(tx, row, actor.accountId));
      }
      await this.fresh(tx, token, actor);
      return { items };
    });
  }
  async comments(id: string, url: URL, token?: string | null) {
    activityId(id);
    const page = pageNumber(
        url.searchParams.get('rootPage') ??
          url.searchParams.get('page') ??
          url.searchParams.get('commentPage')
      ),
      commentId = url.searchParams.get('commentId');
    if (commentId) activityId(commentId);
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token);
      await this.row(tx, id);
      const result = await this.commentPage(tx, id, page, commentId);
      await this.fresh(tx, token, actor);
      return result;
    });
  }
  async list(url: URL, token?: string | null): Promise<WishList> {
    const page = pageNumber(url.searchParams.get('page')),
      category = wishCategory(url.searchParams.get('category'), true),
      query = text(url.searchParams.get('query') ?? '', '搜索内容', 100, true);
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token);
      const rows = await tx.$queryRaw<
        Row[]
      >`SELECT * FROM "Wish" WHERE "deletedAt" IS NULL AND "moderatedAt" IS NULL AND (${category}::text IS NULL OR "category"=${category}) AND position(lower(${query}) in lower("title"||' '||"body"||' '||"wantedContent"))>0 ORDER BY "createdAt" DESC,"id" DESC LIMIT ${WISH_PAGE_SIZE} OFFSET ${(page - 1) * WISH_PAGE_SIZE}`;
      const [count] = await tx.$queryRaw<
        { total: number }[]
      >`SELECT count(*)::int AS total FROM "Wish" WHERE "deletedAt" IS NULL AND "moderatedAt" IS NULL AND (${category}::text IS NULL OR "category"=${category}) AND position(lower(${query}) in lower("title"||' '||"body"||' '||"wantedContent"))>0`;
      const context = rows.length ? await this.listSummaryContext(tx, rows, actor.accountId) : undefined;
      const items: WishSummary[] = [];
      for (const row of rows) items.push(await this.summary(tx, row, actor.accountId, context));
      await this.fresh(tx, token, actor);
      return {
        items,
        total: count!.total,
        page,
        pageSize: WISH_PAGE_SIZE,
        canPublish: actor.account.membership === 'MEMBER'
      };
    });
  }
  async get(id: string, url: URL, token?: string | null) {
    activityId(id);
    const page = pageNumber(url.searchParams.get('commentPage'));
    const interestPage = pageNumber(url.searchParams.get('interestPage')),
      commentId = url.searchParams.get('commentId');
    if (commentId) activityId(commentId, 'commentId');
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token);
      const result = await this.detail(tx, id, actor.accountId, page, interestPage, commentId);
      await this.fresh(tx, token, actor);
      return result;
    });
  }
  async create(body: Record<string, unknown>, token?: string | null): Promise<WishWrite> {
    const input = publishInput(body),
      actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate('wish-create:' + actor.accountId, 60, 3600);
    return this.auth.transaction(async (tx) => {
      await this.actorLocked(tx, token, actor);
      await lock(tx, 'wish-create:' + actor.accountId + ':' + input.idempotencyKey);
      const fresh = await this.fresh(tx, token, actor);
      if (fresh.account.membership !== 'MEMBER') forbidden('仅正式成员可以发布心愿');
      const fingerprint = tokenDigest(JSON.stringify(input));
      const [existing] = await tx.$queryRaw<
        Row[]
      >`SELECT * FROM "Wish" WHERE "authorId"=${fresh.accountId} AND "idempotencyKey"=${input.idempotencyKey}`;
      if (existing?.deletedAt || existing?.moderatedAt) conflict('该心愿已删除，不能重用原发布提交');
      if (existing && existing.requestFingerprint !== fingerprint) conflict('发布内容已变化，请重新提交');
      const id = existing?.id ?? randomUUID();
      if (!existing)
        await tx.$executeRaw`INSERT INTO "Wish" ("id","authorId","title","category","body","wantedContent","convenientTime","idempotencyKey","requestFingerprint","createdAt")
    VALUES (${id},${fresh.accountId},${input.title},${input.category},${input.body},${input.wantedContent},${input.convenientTime},${input.idempotencyKey},${fingerprint},${this.auth.now()})`;
      const wish = await this.detail(tx, id, fresh.accountId);
      await this.fresh(tx, token, fresh);
      return { wish, replayed: Boolean(existing) };
    });
  }
  private async previous(
    tx: Tx,
    id: string,
    actorId: string,
    command: string,
    kind: string,
    fingerprint: string
  ) {
    const [row] = await tx.$queryRaw<
      { kind: string; requestFingerprint: string }[]
    >`SELECT kind,"requestFingerprint" FROM "WishCommand" WHERE "wishId"=${id} AND "actorId"=${actorId} AND "idempotencyKey"=${command}`;
    if (row && (row.kind !== kind || row.requestFingerprint !== fingerprint))
      conflict('同次提交内容已变化，请使用原内容重试');
    return Boolean(row);
  }
  private async record(
    tx: Tx,
    id: string,
    actorId: string,
    command: string,
    kind: string,
    fingerprint: string,
    payload: unknown = {}
  ) {
    await tx.$executeRaw`INSERT INTO "WishCommand" ("wishId","actorId","idempotencyKey",kind,"requestFingerprint",payload,"createdAt")
   VALUES (${id},${actorId},${command},${kind},${fingerprint},${JSON.stringify(payload)}::jsonb,${this.auth.now()})`;
  }
  private async convertedNotices(tx: Tx, row: Row, recipients: string[]) {
    if (!row.activityId) return;
    for (const accountId of new Set(recipients.filter((id) => id !== row.authorId)))
      await tx.$executeRaw`INSERT INTO "WishNotification" ("id","eventKey","wishId","activityId","recipientId","createdAt")
   VALUES (${randomUUID()},${'wish-converted:' + row.id + ':' + accountId},${row.id},${row.activityId},${accountId},${this.auth.now()}) ON CONFLICT ("eventKey") DO NOTHING`;
  }
  async edit(id: string, body: Record<string, unknown>, token?: string | null) {
    fields(body, [
      'idempotencyKey',
      'expectedRevision',
      'title',
      'category',
      'body',
      'wantedContent',
      'convenientTime'
    ]);
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
      invalid('心愿版本无效');
    const { expectedRevision, ...payload } = body,
      input = publishInput(payload),
      fingerprint = tokenDigest(JSON.stringify(input));
    return this.mutate(id, token, async (tx, actor, row) => {
      if (row.authorId !== actor.accountId) forbidden('仅心愿作者可以修改');
      if (await this.previous(tx, id, actor.accountId, input.idempotencyKey, 'EDIT', fingerprint))
        return true;
      if (row.revision !== expectedRevision) conflict('心愿内容已更新，请重新打开修改');
      await tx.$executeRaw`UPDATE "Wish" SET title=${input.title},"category"=${input.category},body=${input.body},"wantedContent"=${input.wantedContent},"convenientTime"=${input.convenientTime},revision=revision+1,"updatedAt"=${this.auth.now()} WHERE id=${id}`;
      await this.record(tx, id, actor.accountId, input.idempotencyKey, 'EDIT', fingerprint, {
        before: {
          title: row.title,
          category: row.category,
          body: row.body,
          wantedContent: row.wantedContent,
          convenientTime: row.convenientTime,
          revision: row.revision
        },
        after: input
      });
      return false;
    });
  }
  async remove(id: string, body: Record<string, unknown>, token?: string | null): Promise<WishDelete> {
    activityId(id);
    fields(body, ['idempotencyKey', 'confirmed']);
    const command = key(body.idempotencyKey);
    if (body.confirmed !== true) invalid('请确认删除这条心愿');
    const actor = await this.auth.requireAccount(this.auth.db, token),
      fingerprint = tokenDigest('DELETE_CONFIRMED');
    await this.auth.rate('wish-write:' + actor.accountId, 120, 900);
    return this.auth.transaction(async (tx) => {
      await this.actorLocked(tx, token, actor);
      await lock(tx, 'wish:' + id);
      await this.fresh(tx, token, actor);
      const row = await this.row(tx, id, true);
      if (row.moderatedAt) throw new AccountError('NOT_FOUND', '心愿已违规删除', 404);
      if (row.authorId !== actor.accountId) forbidden('仅心愿作者可以删除');
      const replayed = await this.previous(tx, id, actor.accountId, command, 'DELETE', fingerprint);
      if (!replayed) {
        if (row.deletedAt) throw new AccountError('NOT_FOUND', '心愿已删除', 404);
        await tx.$executeRaw`UPDATE "Wish" SET "deletedAt"=${this.auth.now()},"activityId"=NULL,"updatedAt"=${this.auth.now()} WHERE id=${id}`;
        await this.record(tx, id, actor.accountId, command, 'DELETE', fingerprint);
      }
      await this.fresh(tx, token, actor);
      return { id, deleted: true, replayed };
    });
  }
  async moderate(id: string, body: Record<string, unknown>, token?: string | null) {
    activityId(id);
    const input = moderationInput(body),
      fingerprint = tokenDigest(JSON.stringify(input)),
      actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate('wish-write:' + actor.accountId, 120, 900);
    return this.auth.transaction(async (tx) => {
      await this.actorLocked(tx, token, actor);
      await lock(tx, 'wish:' + id);
      const fresh = await this.fresh(tx, token, actor);
      if (fresh.account.adminRole !== 'SUPER_ADMIN') forbidden('仅超级管理员可以违规删除心愿');
      const row = await this.row(tx, id, true);
      const replayed = await this.previous(
        tx,
        id,
        fresh.accountId,
        input.idempotencyKey,
        'MODERATE',
        fingerprint
      );
      if (!replayed) {
        if (row.deletedAt || row.moderatedAt) conflict('心愿已移除，请刷新页面');
        if (row.revision !== input.expectedRevision) conflict('心愿内容已更新，请重新确认');
        const now = this.auth.now();
        await tx.$executeRaw`UPDATE "Wish" SET "moderatedAt"=${now},revision=revision+1,"updatedAt"=${now} WHERE id=${id}`;
        await this.record(tx, id, fresh.accountId, input.idempotencyKey, 'MODERATE', fingerprint, {
          reason: input.reason,
          expectedRevision: input.expectedRevision,
          before: { revision: row.revision, activityId: row.activityId },
          after: { revision: row.revision + 1, moderatedAt: now.toISOString() }
        });
      }
      await this.fresh(tx, token, fresh);
      return { id, moderated: true as const, replayed };
    });
  }
  private async mutate(
    id: string,
    token: string | null | undefined,
    action: (
      tx: Tx,
      actor: Awaited<ReturnType<AccountService['requireAccount']>>,
      row: Row
    ) => Promise<boolean>
  ): Promise<WishWrite> {
    activityId(id);
    const actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate('wish-write:' + actor.accountId, 120, 900);
    return this.auth.transaction(async (tx) => {
      await this.actorLocked(tx, token, actor);
      await lock(tx, 'wish:' + id);
      // Mandatory after the LAST contended lock, including role changes while waiting.
      const fresh = await this.fresh(tx, token, actor),
        row = await this.row(tx, id);
      const replayed = await action(tx, fresh, row);
      const wish = await this.detail(tx, id, fresh.accountId);
      await this.fresh(tx, token, fresh);
      return { wish, replayed };
    });
  }
  async interest(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.interestChange(id, body, true, token);
  }
  async cancelInterest(id: string, body: Record<string, unknown>, token?: string | null) {
    return this.interestChange(id, body, false, token);
  }
  private async interestChange(
    id: string,
    body: Record<string, unknown>,
    active: boolean,
    token?: string | null
  ) {
    fields(body, ['idempotencyKey']);
    const command = body.idempotencyKey === undefined && active ? null : key(body.idempotencyKey),
      kind = active ? 'INTEREST_ADD' : 'INTEREST_CANCEL',
      fingerprint = tokenDigest(kind);
    return this.mutate(id, token, async (tx, actor, row) => {
      if (command && (await this.previous(tx, id, actor.accountId, command, kind, fingerprint))) return true;
      const changed = active
        ? await tx.$executeRaw`INSERT INTO "WishInterest" ("wishId","accountId","createdAt",active,"updatedAt") VALUES (${id},${actor.accountId},${this.auth.now()},TRUE,${this.auth.now()})
    ON CONFLICT ("wishId","accountId") DO UPDATE SET active=TRUE,"updatedAt"=EXCLUDED."updatedAt" WHERE NOT "WishInterest".active`
        : await tx.$executeRaw`UPDATE "WishInterest" SET active=FALSE,"updatedAt"=${this.auth.now()} WHERE "wishId"=${id} AND "accountId"=${actor.accountId} AND active`;
      if (active) {
        await this.convertedNotices(tx, row, [actor.accountId]);
        if (changed !== 0)
          await emitMessage(tx, {
            recipientId: row.authorId,
            actorId: actor.accountId,
            kind: 'WISH_INTEREST',
            sourceType: 'wish',
            sourceId: id,
            eventKey: `wish-interest:${id}:${actor.accountId}`,
            createdAt: this.auth.now()
          });
      }
      if (command) await this.record(tx, id, actor.accountId, command, kind, fingerprint);
      return changed === 0;
    });
  }
  private async mentions(tx: Tx, content: string, values: unknown) {
    const targets = ids(values ?? []);
    if (targets.length > 50) invalid('提及成员过多');
    const people = await tx.account.findMany({
      where: { id: { in: targets } },
      select: { id: true, displayName: true, gameServer: true }
    });
    if (people.length !== targets.length) invalid('提及的成员已变化');
    for (const p of people) {
      if (!p.displayName) invalid('提及的成员尚未填写昵称');
      if (
        !containsMention(
          content,
          mentionLabel(p, (await tx.account.count({ where: { displayName: p.displayName } })) > 1)
        )
      )
        invalid('提及文字与所选成员不一致，请重新选择');
    }
    return targets;
  }
  async comment(id: string, body: Record<string, unknown>, token?: string | null) {
    fields(body, ['idempotencyKey', 'submissionKey', 'body', 'parentId', 'mediaIds', 'mentions']);
    if (body.idempotencyKey && body.submissionKey && body.idempotencyKey !== body.submissionKey)
      invalid('提交标识不一致');
    const command = key(body.idempotencyKey ?? body.submissionKey),
      content = text(body.body ?? '', '留言', 2000, true),
      mediaIds = ids(body.mediaIds ?? []),
      mentionIds = ids(body.mentions ?? []),
      parentId = body.parentId == null ? null : activityId(body.parentId, 'parentId');
    if (!content && !mediaIds.length) invalid('请填写正文或选择图片');
    if (mediaIds.length > PHOTO_RULES.maxBatch) invalid('每次最多选择10张图片');
    const fingerprint = tokenDigest(
      JSON.stringify({ body: content, parentId, mediaIds, mentions: mentionIds })
    );
    let commentId = '';
    const result = await this.mutate(id, token, async (tx, actor, row) => {
      await lock(tx, 'wish-media:' + actor.accountId);
      await this.fresh(tx, token, actor);
      const [previous] = await tx.$queryRaw<
        { id: string; requestFingerprint: string }[]
      >`SELECT id,"requestFingerprint" FROM "WishComment" WHERE "wishId"=${id} AND "authorId"=${actor.accountId} AND "idempotencyKey"=${command}`;
      if (previous) {
        const oldFingerprint = tokenDigest(JSON.stringify({ body: content, parentId }));
        if (
          previous.requestFingerprint !== fingerprint &&
          (mediaIds.length ||
            mentionIds.length ||
            (previous.requestFingerprint !== oldFingerprint &&
              (parentId || previous.requestFingerprint !== tokenDigest(content))))
        )
          conflict('留言内容已变化，请重新提交');
        commentId = previous.id;
        return true;
      }
      const mentions = await this.mentions(tx, content, mentionIds);
      let replyAuthor: string | null = null;
      if (parentId) {
        const [parent] = await tx.$queryRaw<
          { authorId: string }[]
        >`SELECT "authorId" FROM "WishComment" WHERE id=${parentId} AND "wishId"=${id}`;
        if (!parent) invalid('回复目标不属于这条心愿');
        replyAuthor = parent.authorId;
      }
      const media = mediaIds.length
        ? await tx.$queryRaw<MediaRow[]>`SELECT * FROM "WishMedia" WHERE id=ANY(${mediaIds}::text[])`
        : [];
      if (
        media.length !== mediaIds.length ||
        media.some((m) => m.ownerId !== actor.accountId || m.removedAt || m.wishId || m.commentId)
      )
        forbidden('部分图片不可用于此评论');
      if (
        mediaIds.length &&
        (await (await import('@artzoo/db')).wishMediaFencedTx(tx, actor.accountId, mediaIds))
      )
        forbidden('部分图片不可用于此评论');
      commentId = randomUUID();
      await tx.$executeRaw`INSERT INTO "WishComment" ("id","wishId","authorId","body","idempotencyKey","requestFingerprint","createdAt","parentId",mentions) VALUES
    (${commentId},${id},${actor.accountId},${content},${command},${fingerprint},${this.auth.now()},${parentId},${mentions}::text[])`;
      for (let position = 0; position < mediaIds.length; position++)
        await tx.$executeRaw`UPDATE "WishMedia" SET "wishId"=${id},"commentId"=${commentId},position=${position} WHERE id=${mediaIds[position]}`;
      // Keep the original wish notification boundary. Mentions are validated presentation data.
      for (const recipient of new Set(
        [row.authorId, replyAuthor].filter(
          (value): value is string => Boolean(value) && value !== actor.accountId
        )
      ))
        await tx.$executeRaw`
    INSERT INTO "WishNotification" (id,"eventKey","wishId","recipientId",kind,"commentId","createdAt")
    VALUES (${randomUUID()},${'wish-comment:' + commentId + ':' + recipient},${id},${recipient},'WISH_INTERACTION',${commentId},${this.auth.now()}) ON CONFLICT ("eventKey") DO NOTHING`;
      return false;
    });
    return { ...result, id: commentId };
  }
  async upload(body: Record<string, unknown>, input: Buffer, name: string, token?: string | null) {
    const batchId = activityId(body.batchId),
      batchIndex = body.batchIndex;
    if (
      typeof batchIndex !== 'number' ||
      !Number.isInteger(batchIndex) ||
      batchIndex < 0 ||
      batchIndex >= PHOTO_RULES.maxBatch
    )
      invalid('每批最多10张图片');
    if (!input.length || input.length > PHOTO_RULES.maxBytes) invalid('每张图片最多30MiB');
    const actor = await this.auth.requireAccount(this.auth.db, token);
    await this.auth.rate('wish-upload:' + actor.accountId, 100, 900);
    const fingerprint = tokenDigest(Buffer.concat([Buffer.from(name + '\0'), input]).toString('base64'));
    const inspect = async (tx: Tx) => {
      await this.actorLocked(tx, token, actor);
      await lock(tx, 'wish-media:' + actor.accountId);
      await this.fresh(tx, token, actor);
      const [old] = await tx.$queryRaw<
        MediaRow[]
      >`SELECT * FROM "WishMedia" WHERE "ownerId"=${actor.accountId} AND "batchId"=${batchId} AND "batchIndex"=${batchIndex}`;
      if (old && old.fingerprint !== fingerprint) conflict('同次上传内容已变化');
      if (old && (await (await import('@artzoo/db')).wishMediaFencedTx(tx, actor.accountId, [old.id])))
        forbidden('图片已过期，请重新上传');
      await this.fresh(tx, token, actor);
      return old;
    };
    const replay = await this.auth.transaction(async (tx) => {
      const old = await inspect(tx);
      return old ? { id: old.id, replayed: true } : null;
    });
    if (replay) return replay;
    if ((process.env.ARTZOO_MEDIA_BUDGET_ENABLED ?? '0') !== '0') {
      const { mediaBudgetError, mediaUploadPendingError } = await import('../media/budget-errors');
      let attempt: import('@artzoo/db').MediaBudgetAttempt | undefined;
      let beginAttempted = false;
      let photoNamespaces: Awaited<ReturnType<NonNullable<PhotoStorage['writePhotoNamespaces']>>> | undefined;
      let photoAllocation: import('@artzoo/db').MediaBoundAllocationTicket | undefined;
      const photoProofs: import('@artzoo/media/stock-retirement').MediaWriteProof[] = [];
      try {
        const [{ createMediaBudgetAdapter }, { mediaBudgetPolicy, MediaBudgetError }] = await Promise.all([
          import('@artzoo/db'),
          import('@artzoo/domain')
        ]);
        const policy = mediaBudgetPolicy(process.env),
          mediaId = randomUUID(),
          prepared = await createMediaBudgetAdapter(this.auth.db, policy, this.auth.now).prepare({
            scope: 'wish',
            operationKey: actor.accountId + ':' + batchId + ':' + batchIndex,
            fingerprint,
            accountId: actor.accountId,
            rawBytes: BigInt(input.length),
            objectIdentity: 'wish:' + mediaId
          });
        if (prepared.kind === 'disabled') throw new MediaBudgetError('MEDIA_BUDGET_UNEXPECTED_DISABLED');
        if (prepared.kind === 'existing') {
          const old = await this.auth.transaction(inspect);
          if (old) return { id: old.id, replayed: true };
          throw mediaUploadPendingError();
        }
        attempt = prepared.attempt;
        const output = await withPhotoSlot(() => processPhoto(input, name));
        if (this.storage.writePhotoNamespaces || this.storage.boundPhotoNamespaces) {
          photoNamespaces = await (this.storage.writePhotoNamespaces ??
            this.storage.boundPhotoNamespaces)!.call(this.storage, 'wish');
          photoAllocation = await attempt.allocateBoundComponents({
            kind: 'photo',
            scope: 'wish',
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
          // Byte-only ports remain opaque and cannot enroll orphan stock.
          await attempt.allocate(
            BigInt(output.original.length) + BigInt(output.preview.length) + BigInt(output.thumbnail.length)
          );
        }
        // A rejected begin acknowledgement may already have committed. Never release its reservation.
        beginAttempted = true;
        await attempt.begin();
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
        const result = await this.auth.transaction(async (tx) => {
          const old = await inspect(tx);
          if (old) return { id: old.id, replayed: true };
          await tx.$executeRaw`INSERT INTO "WishMedia" (id,"ownerId","batchId","batchIndex",fingerprint,mime,width,height,frames,"createdAt")
    VALUES (${mediaId},${actor.accountId},${batchId},${batchIndex},${fingerprint},${output.mime},${output.width},${output.height},${output.frames},${this.auth.now()})`;
          await this.fresh(tx, token, actor);
          await attempt!.commit(tx);
          if (photoAllocation)
            await (
              await import('@artzoo/media/stock-retirement')
            ).bindWishPhotoWrite(tx, photoAllocation, actor.accountId, mediaId, photoProofs);
          // Settlement may wait. Repeat the original ReadCommitted authorization reads,
          // including expiry/active policy, without acquiring new business row/advisory locks.
          await this.fresh(tx, token, actor);
          return { id: mediaId, replayed: false };
        });
        if (result.replayed) await attempt.unknown().catch(() => undefined);
        return result;
      } catch (error) {
        if (attempt) {
          if (beginAttempted) await attempt.unknown().catch(() => undefined);
          else await attempt.failBeforePersistence().catch(() => undefined);
        }
        throw mediaBudgetError(error);
      }
    }
    const output = await withPhotoSlot(() => processPhoto(input, name)),
      mediaId = randomUUID();
    await this.storage.put(mediaId, output);
    try {
      return await this.auth
        .transaction(async (tx) => {
          const old = await inspect(tx);
          if (old) return { id: old.id, replayed: true };
          await tx.$executeRaw`INSERT INTO "WishMedia" (id,"ownerId","batchId","batchIndex",fingerprint,mime,width,height,frames,"createdAt")
    VALUES (${mediaId},${actor.accountId},${batchId},${batchIndex},${fingerprint},${output.mime},${output.width},${output.height},${output.frames},${this.auth.now()})`;
          await this.fresh(tx, token, actor);
          return { id: mediaId, replayed: false };
        })
        .then(async (result) => {
          if (result.replayed) await this.storage.discardUncommitted(mediaId);
          return result;
        });
    } catch (error) {
      const row = await this.auth.db.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "WishMedia" WHERE id=${mediaId}`.catch(() => undefined);
      if (row?.length === 0) await this.storage.discardUncommitted(mediaId);
      throw error;
    }
  }
  async media(id: string, variant: string, token?: string | null) {
    activityId(id);
    if (!['original', 'preview', 'thumbnail'].includes(variant)) invalid('图片版本无效');
    const retry = Symbol('wish-media-attachment-changed');
    const authorize = async (expected?: Actor) => {
      let expectedActor = expected;
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await this.auth.transaction(async (tx) => {
          const actor = expectedActor
            ? await this.fresh(tx, token, expectedActor)
            : await this.auth.requireAccount(tx, token);
          expectedActor ??= actor;
          const [pointer] = await tx.$queryRaw<MediaRow[]>`SELECT * FROM "WishMedia" WHERE id=${id}`;
          if (!pointer || pointer.removedAt) missingMedia();
          // A writer attaches under wish -> owner-media. Never acquire a wish lock
          // while holding an owner-media read lock: release and retry instead.
          await lockShared(tx, pointer.wishId ? 'wish:' + pointer.wishId : 'wish-media:' + pointer.ownerId);
          await this.fresh(tx, token, actor);
          const [media] = await tx.$queryRaw<MediaRow[]>`SELECT * FROM "WishMedia" WHERE id=${id}`;
          if (!media || media.removedAt) missingMedia();
          if (media.wishId !== pointer.wishId || media.ownerId !== pointer.ownerId) return retry;
          if (!media.wishId && media.ownerId !== actor.accountId) missingMedia();
          if (
            !media.wishId &&
            (await (await import('@artzoo/db')).wishMediaFencedTx(tx, media.ownerId, [media.id]))
          )
            missingMedia();
          if (media.wishId) await this.row(tx, media.wishId);
          await this.fresh(tx, token, actor);
          return { actor, mime: variant === 'original' ? media.mime : 'image/webp' };
        });
        if (result !== retry) return result;
      }
      throw new AccountError('CONFLICT', '图片所属内容已变化，请重试', 409);
    };
    function missingMedia(): never {
      throw new AccountError('NOT_FOUND', '图片不存在', 404);
    }
    const initial = await authorize();
    // Both authorization transactions finish before/after I/O; no lock or pool
    // connection is retained while the storage implementation reads the file.
    const bytes = await this.storage.read(id, variant as PhotoVariant);
    const current = await authorize(initial.actor);
    return { bytes, mime: current.mime };
  }
  async convert(id: string, body: Record<string, unknown>, token?: string | null) {
    fields(body, ['activity']);
    if (!body.activity || typeof body.activity !== 'object' || Array.isArray(body.activity))
      throw new AccountError('VALIDATION_ERROR', '请填写正式活动信息', 400);
    const activity = body.activity as Record<string, unknown>;
    key(activity.idempotencyKey);
    const fingerprint = tokenDigest(JSON.stringify(activity));
    const result = await this.mutate(id, token, async (tx, actor, row) => {
      if (actor.account.membership !== 'MEMBER' || row.authorId !== actor.accountId)
        forbidden('仅心愿作者本人可以创建关联正式活动');
      const [previous] = await tx.$queryRaw<
        { requestFingerprint: string; idempotencyKey: string }[]
      >`SELECT "requestFingerprint","idempotencyKey" FROM "WishConversion" WHERE "wishId"=${id}`;
      if (previous) {
        if (
          previous.idempotencyKey !== activity.idempotencyKey ||
          previous.requestFingerprint !== fingerprint
        )
          conflict('此心愿已有相关活动');
        return true;
      }
      if (row.activityId) conflict('此心愿已有相关活动');
      const result = await createWishActivity(this.auth, tx, activity, token);
      // Never attach an independently created activity through an idempotency-key collision.
      if (result.replayed) conflict('此活动提交标识已使用，请重新提交');
      // Activity creation can wait on catalog/category locks: validate again before linking.
      const final = await this.fresh(tx, token, actor);
      if (final.account.membership !== 'MEMBER' || final.accountId !== row.authorId)
        forbidden('仅正式成员作者可以创建关联活动');
      const now = this.auth.now();
      await tx.$executeRaw`UPDATE "Wish" SET "activityId"=${result.activity.id} WHERE "id"=${id}`;
      await tx.$executeRaw`INSERT INTO "WishConversion" ("wishId","actorId","activityId","idempotencyKey","requestFingerprint","createdAt") VALUES
    (${id},${actor.accountId},${result.activity.id},${activity.idempotencyKey as string},${fingerprint},${now})`;
      const interested = await tx.$queryRaw<
        { accountId: string }[]
      >`SELECT "accountId" FROM "WishInterest" WHERE "wishId"=${id} AND active`;
      await this.convertedNotices(
        tx,
        { ...row, activityId: result.activity.id },
        interested.map((person) => person.accountId)
      );
      return false;
    });
    return {
      ...result,
      activity: await new ActivityService(this.auth).detail(result.wish.activity!.id, token)
    };
  }
}
