import { deletionIntent } from '../deletion-intent';
import { emitMessage } from '../messages/emit';
import { visibleCommentIds, commentSubtreeIds } from '../daily/comment-tree';
import { memberSelect, memberSummary } from '../members/service';
import type { DailyCommentView } from '../daily/contract';
import { AccountError } from '@artzoo/domain';
import {
  validateKnowledgeBody,
  readKnowledgeDocument,
  documentText,
  documentImages,
  type BodyFormat
} from '../../content/knowledge-document';
import { bindKnowledgeImages } from './image-references';
import { Prisma } from '@artzoo/db';
import { AccountService, lock } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import {
  fields,
  id,
  revision,
  text,
  metadata,
  page,
  fail,
  denied,
  conflict,
  missing,
  type Body,
  type Article
} from './contract';
type Tx = Prisma.TransactionClient;
const person = { id: true, displayName: true } as const;
const include = {
  author: { select: memberSelect },
  category: true,
  contributions: { select: { accountId: true } }
} as const;
type Row = Prisma.KnowledgeArticleGetPayload<{ include: typeof include }>;
const admin = (role: string) => role === 'ADMIN' || role === 'SUPER_ADMIN';
const editFields = [
  'body',
  'bodyFormat',
  'expectedRevision',
  'title',
  'categoryId',
  'jobs',
  'playstyles',
  'gameVersions',
  'editMode'
];
export class KnowledgeService {
  constructor(readonly auth: AccountService) {}
  private body(body: Body) {
    try {
      return validateKnowledgeBody(body.body, body.bodyFormat ?? 'PLAIN');
    } catch (error) {
      return fail(error instanceof Error ? error.message : '正文结构无效');
    }
  }
  private async account(tx: Tx, token?: string | null) {
    const actor = await this.auth.requireAccount(tx, token);
    if (actor.expiresAt <= this.auth.now()) throw new AccountError('UNAUTHENTICATED', '请先登录', 401);
    return actor;
  }
  private writeTransaction<T>(token: string | null | undefined, action: (tx: Tx) => Promise<T>): Promise<T> {
    return this.auth.transaction(async (tx) => {
      const result = await action(tx);
      await this.account(tx, token);
      return result;
    });
  }
  private async writer(tx: Tx, token?: string | null) {
    const actor = await this.account(tx, token);
    await lock(tx, `phone:${actor.account.phone}`);
    await tx.$queryRaw`SELECT id FROM "Account" WHERE id=${actor.accountId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT id FROM "AccountSession" WHERE id=${actor.id} FOR UPDATE`;
    const fresh = await this.account(tx, token);
    if (fresh.accountId !== actor.accountId) denied();
    return fresh;
  }
  private async revalidate(
    tx: Tx,
    token: string | null | undefined,
    actor: Awaited<ReturnType<KnowledgeService['writer']>>
  ) {
    const fresh = await this.account(tx, token);
    if (fresh.id !== actor.id || fresh.accountId !== actor.accountId) denied();
    return fresh;
  }
  private async article(tx: Tx, articleId: string, locked = false): Promise<Row> {
    articleId = id(articleId);
    if (locked) await lock(tx, `knowledge:${articleId}`);
    const row = await tx.knowledgeArticle.findUnique({ where: { id: articleId }, include });
    if (!row || row.removedAt) return missing();
    return row;
  }
  private view(
    row: Row,
    actorId: string,
    role: string,
    thumbnailVariant: 'preview' | 'thumbnail' = 'preview'
  ): Article {
    const owner = row.authorId === actorId,
      isAdmin = admin(role),
      other = row.contributions.some((c) => c.accountId !== row.authorId);
    const document = readKnowledgeDocument(row.body, row.bodyFormat as BodyFormat);
    return {
      id: row.id,
      title: row.title,
      summary: documentText(document).replace(/\s+/g, ' ').slice(0, 180),
      thumbnailUrls: documentImages(document)
        .slice(0, 3)
        .map((imageId) => `/api/knowledge-images/${imageId}?variant=${thumbnailVariant}`),
      body: row.body,
      bodyFormat: row.bodyFormat as BodyFormat,
      author: memberSummary(row.author),
      category: row.category,
      jobs: row.jobs,
      playstyles: row.playstyles,
      gameVersions: row.gameVersions,
      editMode: row.editMode as 'AUTHOR' | 'COMMUNITY',
      revision: row.revision,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      canEdit: owner,
      canManage: owner,
      canDelete: owner && !other,
      canHistory: owner || isAdmin,
      isAdmin,
      hasOtherContributions: other,
      reads: 0,
      collections: 0,
      likes: 0,
      comments: 0,
      collected: false,
      liked: false
    };
  }
  private async category(tx: Tx, categoryId: string, current?: string) {
    await lock(tx, `knowledge-category:${categoryId}`);
    const category = await tx.knowledgeCategory.findUnique({ where: { id: categoryId } });
    if (!category || (!category.active && current !== categoryId)) fail('请选择有效分类');
  }
  async categories(token?: string | null, all = false) {
    return this.auth.db.$transaction(async (tx) => {
      const actor = await this.account(tx, token);
      if (all && !admin(actor.account.adminRole)) denied();
      return {
        items: await tx.knowledgeCategory.findMany({
          where: all ? {} : { active: true },
          orderBy: [{ label: 'asc' }, { id: 'asc' }]
        })
      };
    });
  }
  async saveCategory(body: Body, token?: string | null) {
    void body;
    return this.writeTransaction(token, async (tx) => {
      const actor = await this.writer(tx, token);
      if (!admin(actor.account.adminRole)) denied();
      return fail('固定配置由开发维护', 'FORBIDDEN', 403);
    });
  }
  async list(url: URL, token?: string | null) {
    const query = url.searchParams.get('query') ?? '';
    if (query.length > 200) fail('搜索内容过长');
    const categoryLabel = url.searchParams.get('categoryLabel');
    if (categoryLabel && categoryLabel.length > 60) fail('分区名称无效');
    const categoryId = url.searchParams.get('categoryId'),
      authorId = url.searchParams.get('author'),
      requested = page(url);
    const tag = (key: string) => {
      const value = url.searchParams.get(key);
      return value ? text(value, 200000) : null;
    };
    const job = tag('job'),
      playstyle = tag('playstyle'),
      gameVersion = tag('gameVersion');
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.account(tx, token);
        const where: Prisma.KnowledgeArticleWhereInput = {
          removedAt: null,
          ...(authorId ? { authorId: id(authorId) } : {}),
          ...(query ? { title: { contains: query.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' } } : {}),
          ...(categoryId ? { categoryId: id(categoryId) } : {}),
          ...(categoryLabel ? { category: { label: categoryLabel } } : {}),
          ...(job ? { jobs: { has: job } } : {}),
          ...(playstyle ? { playstyles: { has: playstyle } } : {}),
          ...(gameVersion ? { gameVersions: { has: gameVersion } } : {})
        };
        const total = await tx.knowledgeArticle.count({ where }),
          current = Math.min(requested, Math.max(1, Math.ceil(total / 10)));
        const rows = await tx.knowledgeArticle.findMany({
          where,
          include,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (current - 1) * 10,
          take: 10
        });
        const facets = await tx.$queryRaw<
          Array<{ kind: string; label: string }>
        >`SELECT DISTINCT kind,label FROM (SELECT 'jobs' AS kind,unnest(jobs) AS label FROM "KnowledgeArticle" WHERE "removedAt" IS NULL UNION ALL SELECT 'playstyles',unnest(playstyles) FROM "KnowledgeArticle" WHERE "removedAt" IS NULL UNION ALL SELECT 'gameVersions',unnest("gameVersions") FROM "KnowledgeArticle" WHERE "removedAt" IS NULL) tags ORDER BY kind,label`;
        const filters = {
          jobs: facets.filter((f) => f.kind === 'jobs').map((f) => f.label),
          playstyles: facets.filter((f) => f.kind === 'playstyles').map((f) => f.label),
          gameVersions: facets.filter((f) => f.kind === 'gameVersions').map((f) => f.label)
        };
        return {
          items: rows.map((row) => {
            const { body: _body, ...summary } = this.view(
              row,
              actor.accountId,
              actor.account.adminRole,
              'thumbnail'
            );
            void _body;
            return summary;
          }),
          filters,
          total,
          page: current,
          pageSize: 10
        };
      },
      { isolationLevel: 'RepeatableRead' }
    );
  }
  private async imageDimensions(
    tx: Tx,
    articleId: string,
    bodies: Array<{ body: string; bodyFormat: string }>
  ) {
    const ids = [
      ...new Set(
        bodies.flatMap((item) =>
          documentImages(readKnowledgeDocument(item.body, item.bodyFormat as BodyFormat))
        )
      )
    ];
    if (!ids.length) return {};
    const images = await tx.knowledgeImage.findMany({
      where: { articleId, commentId: null, id: { in: ids } },
      select: { id: true, width: true, height: true }
    });
    return Object.fromEntries(
      images.map((image) => [image.id, { width: image.width, height: image.height }])
    );
  }
  private async detailView(tx: Tx, row: Row, actorId: string, role: string) {
    const [imageDimensions, reads, collections, likes, interaction, comments] = await Promise.all([
      this.imageDimensions(tx, row.id, [row]),
      tx.knowledgeArticleRead.count({ where: { articleId: row.id } }),
      tx.knowledgeArticleInteraction.count({ where: { articleId: row.id, collectedAt: { not: null } } }),
      tx.knowledgeArticleInteraction.count({ where: { articleId: row.id, likedAt: { not: null } } }),
      tx.knowledgeArticleInteraction.findUnique({
        where: { articleId_accountId: { articleId: row.id, accountId: actorId } }
      }),
      tx.knowledgeComment.findMany({
        where: { articleId: row.id },
        select: { id: true, parentId: true, removedAt: true }
      })
    ]);
    return {
      ...this.view(row, actorId, role),
      imageDimensions,
      reads,
      collections,
      likes,
      comments: visibleCommentIds(comments).size,
      collected: !!interaction?.collectedAt,
      liked: !!interaction?.likedAt
    };
  }
  async detail(articleId: string, token?: string | null) {
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.account(tx, token);
        return this.detailView(
          tx,
          await this.article(tx, articleId),
          actor.accountId,
          actor.account.adminRole
        );
      },
      { isolationLevel: 'RepeatableRead' }
    );
  }
  async read(articleId: string, body: Body, token?: string | null) {
    fields(body, []);
    return this.writeTransaction(token, async (tx) => {
      const actor = await this.writer(tx, token),
        row = await this.article(tx, articleId, true);
      await this.revalidate(tx, token, actor);
      const sessionKey = tokenDigest(actor.id);
      await tx.knowledgeArticleRead.upsert({
        where: { articleId_sessionKey: { articleId: row.id, sessionKey } },
        create: { articleId: row.id, sessionKey },
        update: {}
      });
      return { reads: await tx.knowledgeArticleRead.count({ where: { articleId: row.id } }) };
    });
  }
  async interact(articleId: string, kind: 'like' | 'collect', body: Body, token?: string | null) {
    const field = kind === 'like' ? 'liked' : 'collected';
    fields(body, [field, 'submissionKey']);
    id(body.submissionKey);
    if (typeof body[field] !== 'boolean') fail('互动状态无效');
    const active = body[field] as boolean;
    return this.writeTransaction(token, async (tx) => {
      const actor = await this.writer(tx, token),
        row = await this.article(tx, articleId, true),
        where = { articleId_accountId: { articleId: row.id, accountId: actor.accountId } };
      const previous = await tx.knowledgeArticleInteraction.findUnique({ where }),
        now = this.auth.now();
      const stateField = kind === 'like' ? 'likedAt' : 'collectedAt',
        noticeField = kind === 'like' ? 'likeNotifiedAt' : 'collectionNotifiedAt';
      const firstNotice = active && !previous?.[noticeField] && row.authorId !== actor.accountId;
      await this.revalidate(tx, token, actor);
      await tx.knowledgeArticleInteraction.upsert({
        where,
        create: {
          articleId: row.id,
          accountId: actor.accountId,
          [stateField]: active ? now : null,
          ...(firstNotice ? { [noticeField]: now } : {})
        },
        update: { [stateField]: active ? now : null, ...(firstNotice ? { [noticeField]: now } : {}) }
      });
      if (firstNotice)
        await emitMessage(tx, {
          recipientId: row.authorId,
          actorId: actor.accountId,
          kind: kind === 'like' ? 'LIKE' : 'COLLECTION',
          sourceType: 'knowledge',
          sourceId: row.id,
          eventKey: kind + ':knowledge:' + row.id + ':' + actor.accountId,
          createdAt: now
        });
      return { id: row.id, [field]: active };
    });
  }
  async create(body: Body, token?: string | null) {
    fields(body, [...editFields.filter((f) => f !== 'expectedRevision'), 'submissionKey']);
    const data = metadata(body),
      payload = this.body(body),
      content = payload.body,
      submissionKey = id(body.submissionKey),
      fingerprint = tokenDigest(
        JSON.stringify({
          ...data,
          body: content,
          ...(payload.bodyFormat === 'RICH_V1' ? { bodyFormat: payload.bodyFormat } : {})
        })
      );
    return this.writeTransaction(token, async (tx) => {
      const actor = await this.writer(tx, token);
      await lock(tx, `knowledge-create:${actor.accountId}:${submissionKey}`);
      await this.revalidate(tx, token, actor);
      const old = await tx.knowledgeArticle.findUnique({
        where: { authorId_submissionKey: { authorId: actor.accountId, submissionKey } }
      });
      if (old) {
        if (old.requestFingerprint !== fingerprint) conflict();
        if (old.removedAt) missing();
        return { id: old.id, replayed: true };
      }
      await this.category(tx, data.categoryId);
      await this.revalidate(tx, token, actor);
      const article = await tx.knowledgeArticle.create({
        data: {
          ...data,
          body: content,
          bodyFormat: payload.bodyFormat,
          authorId: actor.accountId,
          submissionKey,
          requestFingerprint: fingerprint,
          versions: {
            create: { editorId: actor.accountId, body: content, bodyFormat: payload.bodyFormat, number: 1 }
          },
          contributions: { create: { accountId: actor.accountId } }
        }
      });
      await bindKnowledgeImages(tx, payload.images, article.id, actor.accountId);
      return { id: article.id, replayed: false };
    });
  }
  async edit(articleId: string, body: Body, token?: string | null) {
    fields(body, editFields);
    const expected = revision(body.expectedRevision),
      payload = this.body(body),
      content = payload.body;
    return this.writeTransaction(token, async (tx) => {
      const actor = await this.writer(tx, token),
        row = await this.article(tx, articleId, true);
      if (row.revision !== expected) conflict();
      const owner = row.authorId === actor.accountId;
      if (!owner) denied();
      const data = metadata({
        ...body,
        jobs: body.jobs ?? row.jobs,
        playstyles: body.playstyles ?? row.playstyles,
        gameVersions: body.gameVersions ?? row.gameVersions,
        editMode: body.editMode ?? row.editMode
      });
      await this.category(tx, data.categoryId, row.categoryId);
      await this.revalidate(tx, token, actor);
      const changed = content !== row.body || payload.bodyFormat !== row.bodyFormat;
      await bindKnowledgeImages(tx, payload.images, row.id, actor.accountId, {
        currentImages: documentImages(readKnowledgeDocument(row.body, row.bodyFormat as BodyFormat)),
        canUseHistory: owner || admin(actor.account.adminRole)
      });
      await this.revalidate(tx, token, actor);
      if (changed) {
        const last = await tx.knowledgeVersion.aggregate({
          where: { articleId: row.id },
          _max: { number: true }
        });
        await tx.knowledgeVersion.create({
          data: {
            articleId: row.id,
            editorId: actor.accountId,
            body: content,
            bodyFormat: payload.bodyFormat,
            number: (last._max.number ?? 0) + 1
          }
        });
        await tx.knowledgeContribution.upsert({
          where: { articleId_accountId: { articleId: row.id, accountId: actor.accountId } },
          create: { articleId: row.id, accountId: actor.accountId },
          update: {}
        });
      }
      const metadataChanged =
        owner &&
        Object.entries(data).some(
          ([key, value]) => JSON.stringify(row[key as keyof Row]) !== JSON.stringify(value)
        );
      if (changed || metadataChanged)
        await tx.knowledgeArticle.update({
          where: { id: row.id },
          data: {
            ...data,
            body: content,
            bodyFormat: payload.bodyFormat,
            revision: { increment: 1 },
            updatedAt: this.auth.now()
          }
        });
      return { id: row.id, changed: changed || metadataChanged };
    });
  }
  async history(articleId: string, url: URL, token?: string | null) {
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.account(tx, token),
          row = await this.article(tx, articleId);
        if (row.authorId !== actor.accountId && !admin(actor.account.adminRole)) denied();
        const requested = page(url),
          total = await tx.knowledgeVersion.count({ where: { articleId: row.id } }),
          current = Math.min(requested, Math.max(1, Math.ceil(total / 20)));
        const items = await tx.knowledgeVersion.findMany({
          where: { articleId: row.id },
          include: { editor: { select: person } },
          orderBy: { number: 'desc' },
          skip: (current - 1) * 20,
          take: 20
        });
        const dimensions = await this.imageDimensions(tx, row.id, items);
        return {
          items: items.map((v) => ({
            ...v,
            imageDimensions: Object.fromEntries(
              documentImages(readKnowledgeDocument(v.body, v.bodyFormat as BodyFormat))
                .filter((id) => dimensions[id])
                .map((id) => [id, dimensions[id]!])
            ),
            createdAt: v.createdAt.toISOString()
          })),
          total,
          page: current,
          pageSize: 20
        };
      },
      { isolationLevel: 'RepeatableRead' }
    );
  }
  async restore(articleId: string, body: Body, token?: string | null) {
    fields(body, ['versionId', 'expectedRevision', 'reason']);
    const versionId = id(body.versionId),
      expected = revision(body.expectedRevision);
    return this.writeTransaction(token, async (tx) => {
      const actor = await this.writer(tx, token),
        row = await this.article(tx, articleId, true);
      if (row.authorId !== actor.accountId && !admin(actor.account.adminRole)) denied();
      if (row.revision !== expected) conflict();
      const selected = await tx.knowledgeVersion.findFirst({ where: { id: versionId, articleId: row.id } });
      if (!selected) missing();
      const restored = this.body({ body: selected!.body, bodyFormat: selected!.bodyFormat });
      await bindKnowledgeImages(tx, restored.images, row.id, actor.accountId, {
        currentImages: documentImages(readKnowledgeDocument(row.body, row.bodyFormat as BodyFormat)),
        canUseHistory: true
      });
      const reason = admin(actor.account.adminRole)
        ? text(body.reason, 1000)
        : `作者恢复正文版本 v${selected!.number}`;
      if (selected!.body === row.body && selected!.bodyFormat === row.bodyFormat)
        return { id: row.id, changed: false };
      const last = await tx.knowledgeVersion.aggregate({
        where: { articleId: row.id },
        _max: { number: true }
      });
      await this.revalidate(tx, token, actor);
      await tx.knowledgeVersion.create({
        data: {
          articleId: row.id,
          editorId: actor.accountId,
          body: selected!.body,
          bodyFormat: selected!.bodyFormat,
          number: (last._max.number ?? 0) + 1,
          restoredFromId: versionId
        }
      });
      await tx.knowledgeContribution.upsert({
        where: { articleId_accountId: { articleId: row.id, accountId: actor.accountId } },
        create: { articleId: row.id, accountId: actor.accountId },
        update: {}
      });
      await tx.knowledgeAudit.create({
        data: {
          articleId: row.id,
          actorId: actor.accountId,
          action: 'BODY_RESTORED',
          targetId: versionId,
          reason
        }
      });
      // Restoration changes only the body. Permanent contribution records and current metadata/permissions are never reverted.
      await tx.knowledgeArticle.update({
        where: { id: row.id },
        data: {
          body: selected!.body,
          bodyFormat: selected!.bodyFormat,
          revision: { increment: 1 },
          updatedAt: this.auth.now()
        }
      });
      return { id: row.id, changed: true };
    });
  }
  async remove(articleId: string, body: Body, token?: string | null) {
    fields(body, ['expectedRevision', 'reason', 'intent']);
    const expected = revision(body.expectedRevision);
    return this.writeTransaction(token, async (tx) => {
      const actor = await this.writer(tx, token),
        row = await this.article(tx, articleId, true);
      if (row.revision !== expected) conflict();
      const isAdmin = admin(actor.account.adminRole),
        owner = row.authorId === actor.accountId,
        other = row.contributions.some((c) => c.accountId !== row.authorId);
      const { moderate, reason } = deletionIntent(body, owner && !other, isAdmin, '作者删除本人文章', 1000);
      await this.revalidate(tx, token, actor);
      await tx.knowledgeArticle.update({
        where: { id: row.id },
        data: { removedAt: this.auth.now(), revision: { increment: 1 } }
      });
      await tx.knowledgeAudit.create({
        data: {
          articleId: row.id,
          actorId: actor.accountId,
          action: moderate ? 'ARTICLE_MODERATED' : 'ARTICLE_REMOVED',
          targetId: row.id,
          reason
        }
      });
      return { removed: true };
    });
  }
  async comments(articleId: string, url: URL, token?: string | null) {
    return this.auth.db.$transaction(
      async (tx) => {
        const actor = await this.account(tx, token),
          row = await this.article(tx, articleId),
          requested = page(url);
        const rows = await tx.knowledgeComment.findMany({
          where: { articleId: row.id },
          include: {
            author: { select: memberSelect },
            parent: { select: { author: { select: memberSelect } } },
            images: { orderBy: [{ commentPosition: 'asc' }, { id: 'asc' }] }
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
        });
        const visible = visibleCommentIds(rows),
          roots = rows.filter((c) => !c.parentId && visible.has(c.id));
        let current = Math.min(requested, Math.max(1, Math.ceil(roots.length / 10)));
        const focus = url.searchParams.get('commentId');
        if (focus) {
          let node = rows.find((c) => c.id === id(focus) && visible.has(c.id));
          if (!node) missing();
          const visited = new Set<string>();
          while (node?.parentId && !visited.has(node.id)) {
            visited.add(node.id);
            node = rows.find((c) => c.id === node!.parentId);
          }
          const index = roots.findIndex((c) => c.id === node?.id);
          if (index >= 0) current = Math.floor(index / 10) + 1;
        }
        const chosen = new Set(
          roots.slice((current - 1) * 10, current * 10).flatMap((c) => [...commentSubtreeIds(rows, c.id)])
        );
        return {
          items: rows
            .filter((c) => chosen.has(c.id) && visible.has(c.id))
            .map(
              (c) =>
                ({
                  id: c.id,
                  body: c.body,
                  author: memberSummary(c.author),
                  parentId: c.parentId,
                  replyTo: c.parent ? memberSummary(c.parent.author) : null,
                  createdAt: c.createdAt.toISOString(),
                  revision: c.revision,
                  removed: false,
                  canDelete: c.authorId === actor.accountId,
                  canModerate: admin(actor.account.adminRole),
                  media: c.images.map((m) => ({
                    id: m.id,
                    width: m.width,
                    height: m.height,
                    frames: m.frames,
                    thumbnailUrl: '/api/knowledge-images/' + m.id + '?variant=thumbnail',
                    previewUrl: '/api/knowledge-images/' + m.id + '?variant=preview'
                  }))
                }) satisfies DailyCommentView
            ),
          total: visible.size,
          page: current,
          totalPages: Math.max(1, Math.ceil(roots.length / 10)),
          pageSize: 10
        };
      },
      { isolationLevel: 'RepeatableRead' }
    );
  }
  async comment(articleId: string, body: Body, token?: string | null) {
    fields(body, ['body', 'parentId', 'mentions', 'submissionKey', 'mediaIds']);
    const mediaIds =
      body.mediaIds === undefined
        ? []
        : Array.isArray(body.mediaIds)
          ? body.mediaIds.map(id)
          : fail('图片无效');
    if (mediaIds.length > 10 || new Set(mediaIds).size !== mediaIds.length) fail('每次最多选择10张图片');
    const content =
      typeof body.body === 'string' && body.body.length <= 4000 && !body.body.includes('\0')
        ? body.body.trim()
        : fail('文字内容无效');
    if (!content && !mediaIds.length) fail('请填写正文或选择图片');
    const parentId = body.parentId ? id(body.parentId) : null,
      submissionKey = id(body.submissionKey);
    if (!Array.isArray(body.mentions) || body.mentions.length > 20) fail('提及成员无效');
    const mentions = [...new Set((body.mentions as unknown[]).map(id))].sort();
    return this.writeTransaction(token, async (tx) => {
      const actor = await this.writer(tx, token),
        row = await this.article(tx, articleId, true);
      const ancestry = await tx.knowledgeComment.findMany({
        where: { articleId: row.id },
        select: { id: true, parentId: true, removedAt: true }
      });
      if (parentId && !visibleCommentIds(ancestry).has(parentId)) fail('回复目标不存在');
      const parent = parentId
        ? await tx.knowledgeComment.findFirst({ where: { id: parentId, articleId: row.id, removedAt: null } })
        : null;
      if (parentId && !parent) fail('回复目标不存在');
      const targets = await tx.account.findMany({
        where: { id: { in: mentions } },
        select: { ...person, gameServer: true }
      });
      // Only unambiguous names or an exact name+server token can bind a user; arbitrary client IDs cannot generate mentions.
      for (const target of targets) {
        if (!target.displayName) fail('提及成员无效');
        const duplicates = await tx.account.count({ where: { displayName: target.displayName } });
        const label =
          duplicates > 1
            ? `${target.displayName}（${target.gameServer || target.id.slice(0, 8)}）`
            : target.displayName;
        if (
          !new RegExp('(?:^|\\s)@' + label!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)').test(
            content
          )
        )
          fail('提及成员与正文不一致');
      }
      if (targets.length !== mentions.length) fail('提及成员不存在');
      await this.revalidate(tx, token, actor);
      const old = await tx.knowledgeComment.findUnique({
        where: { authorId_submissionKey: { authorId: actor.accountId, submissionKey } }
      });
      if (old) {
        const previousImages = await tx.knowledgeImage.findMany({
          where: { commentId: old.id },
          orderBy: [{ commentPosition: 'asc' }, { id: 'asc' }],
          select: { id: true }
        });
        if (JSON.stringify(previousImages.map((i) => i.id)) !== JSON.stringify(mediaIds)) conflict();
        if (
          old.articleId !== row.id ||
          old.body !== content ||
          old.parentId !== parentId ||
          JSON.stringify(old.mentions) !== JSON.stringify(mentions)
        )
          conflict();
        return { id: old.id, replayed: true };
      }
      const images = await tx.knowledgeImage.findMany({ where: { id: { in: mediaIds } } });
      if (
        images.length !== mediaIds.length ||
        images.some((i) => i.uploaderId !== actor.accountId || i.articleId || i.commentId)
      )
        denied();
      if (
        mediaIds.length &&
        (await (await import('@artzoo/db')).knowledgeMediaFencedTx(tx, actor.accountId, mediaIds))
      )
        denied();
      const comment = await tx.knowledgeComment.create({
        data: {
          articleId: row.id,
          authorId: actor.accountId,
          body: content,
          parentId,
          mentions,
          submissionKey
        }
      });
      for (let commentPosition = 0; commentPosition < mediaIds.length; commentPosition++)
        await tx.knowledgeImage.update({
          where: { id: mediaIds[commentPosition] },
          data: { articleId: row.id, commentId: comment.id, commentPosition }
        });
      const recipients = new Set([row.authorId, ...(parent ? [parent.authorId] : []), ...mentions]);
      recipients.delete(actor.accountId);
      await tx.knowledgeNotification.createMany({
        data: [...recipients].map((recipientId) => ({ recipientId, commentId: comment.id }))
      });
      return { id: comment.id, replayed: false };
    });
  }
  async removeComment(articleId: string, commentId: string, body: Body, token?: string | null) {
    fields(body, ['reason', 'revision', 'submissionKey', 'commentId', 'intent']);
    if (body.commentId !== undefined && id(body.commentId) !== id(commentId)) fail('评论标识不一致');
    return this.writeTransaction(token, async (tx) => {
      const actor = await this.writer(tx, token),
        row = await this.article(tx, articleId, true),
        c = await tx.knowledgeComment.findFirst({ where: { id: id(commentId), articleId: row.id } });
      if (!c) missing();
      const owner = c!.authorId === actor.accountId;
      const { reason } = deletionIntent(
        body,
        owner,
        admin(actor.account.adminRole),
        '作者删除本人评论',
        1000
      );
      if (c!.removedAt) return { removed: true, replayed: true };
      if (body.revision !== undefined && c!.revision !== revision(body.revision)) conflict();
      const rows = await tx.knowledgeComment.findMany({
        where: { articleId: row.id },
        select: { id: true, parentId: true, removedAt: true }
      });
      if (!visibleCommentIds(rows).has(c!.id)) missing();
      await this.revalidate(tx, token, actor);
      await tx.knowledgeComment.updateMany({
        where: { articleId: row.id, id: { in: [...commentSubtreeIds(rows, c!.id)] }, removedAt: null },
        data: { removedAt: this.auth.now(), revision: { increment: 1 } }
      });
      await tx.knowledgeAudit.create({
        data: {
          articleId: row.id,
          actorId: actor.accountId,
          action: 'COMMENT_REMOVED',
          targetId: c!.id,
          reason
        }
      });
      return { removed: true };
    });
  }
  async audits(articleId: string, token?: string | null) {
    return this.auth.db.$transaction(async (tx) => {
      const actor = await this.account(tx, token);
      if (!admin(actor.account.adminRole)) denied();
      return {
        items: await tx.knowledgeAudit.findMany({
          where: { articleId: id(articleId) },
          include: { actor: { select: person } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 100
        })
      };
    });
  }
}
