import { randomUUID } from 'node:crypto';
import type { Prisma, OfficialImagePorts } from '@artzoo/db';
import { createOfficialImagePorts } from '@artzoo/media/official';
import {
  AccountError,
  fromBeijingParts,
  activityId,
  type OfficialEventSummary,
  type OfficialEventDetail,
  type OfficialEventStatus,
  type OfficialCalendar,
  type OfficialEventList
} from '@artzoo/domain';
import { AccountService, lock } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import { officialSyncRunView, runOfficialEventSync } from '@artzoo/db';
type Tx = Prisma.TransactionClient;
type Actor = Awaited<ReturnType<AccountService['requireAccount']>>;
type Body = Record<string, unknown>;
type Row = {
  id: string;
  sourceKey: string;
  sourceTitle: string;
  sourceText: string;
  sourceUrl: string;
  status: OfficialEventStatus;
  summary: string;
  startsAt: Date | null;
  endsAt: Date | null;
  revision: number;
  createdAt: Date;
  manualFields: unknown;
  imageId?: string | null;
};
type ImageRow = { id: string; eventId: string; sourceUrl: string; mime: string };
type ImageVariant = 'original' | 'preview' | 'thumbnail';
type ImagePorts = OfficialImagePorts & {
  storage: { read(id: string, variant: ImageVariant): Promise<Buffer> };
};
function invalid(message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400);
}
function conflict(message: string): never {
  throw new AccountError('CONFLICT', message, 409);
}
function fields(body: Body, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) invalid('提交包含不支持的字段');
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) invalid('请填写有效内容');
  return value.trim();
}
function page(value: string | null) {
  if (value !== null && !/^[1-9]\d{0,5}$/.test(value)) invalid('分页无效');
  return value === null ? 1 : Number(value);
}
function key(value: unknown): string {
  if (typeof value !== 'string' || !/^[-_a-zA-Z0-9]{16,128}$/.test(value)) invalid('提交标识无效');
  return value;
}
function instant(value: unknown): Date | null {
  if (value === null || value === '') return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    invalid('请填写完整的活动时间');
  const result = new Date(value);
  if (!Number.isFinite(result.getTime()) || Number(value.slice(0, 4)) < 1000) invalid('活动时间无效');
  const suffix = value.slice(-6),
    offset = value.endsWith('Z')
      ? 0
      : (Number(suffix.slice(1, 3)) * 60 + Number(suffix.slice(4, 6))) * (suffix[0] === '-' ? -1 : 1);
  if (Math.abs(offset) > 14 * 60 || (!value.endsWith('Z') && Number(suffix.slice(4, 6)) > 59))
    invalid('活动时区无效');
  if (new Date(result.getTime() + offset * 60_000).toISOString().slice(0, 19) !== value.slice(0, 19))
    invalid('活动日期或时间无效');
  return result;
}
function imagePath(eventId: string, imageId: string, variant: ImageVariant) {
  return `/api/official-events/${eventId}/images/${imageId}/${variant}`;
}
function summary(row: Row, image: ImageRow | null = null): OfficialEventSummary {
  return {
    id: row.id,
    title: row.sourceTitle,
    sourceUrl: row.sourceUrl,
    status: row.status,
    summary: row.summary,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    image: image
      ? {
          id: image.id,
          thumbnailUrl: imagePath(row.id, image.id, 'thumbnail'),
          previewUrl: imagePath(row.id, image.id, 'preview'),
          sourceUrl: image.sourceUrl
        }
      : null
  };
}
export class OfficialEventService {
  constructor(
    readonly auth: AccountService,
    readonly imagePorts: ImagePorts = createOfficialImagePorts()
  ) {}
  private async fresh(tx: Tx, token: string | null | undefined, expected: Actor, administrator = true) {
    const actor = await this.auth.requireAccount(tx, token, administrator);
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
  private async row(tx: Tx, id: string) {
    const [row] = await tx.$queryRaw<Row[]>`SELECT * FROM "OfficialEvent" WHERE id=${id}`;
    if (!row) throw new AccountError('NOT_FOUND', '官方活动不存在', 404);
    return row;
  }
  private async summaries(tx: Tx, rows: Row[]): Promise<OfficialEventSummary[]> {
    const ids = rows.flatMap((row) => (row.imageId ? [row.imageId] : []));
    const images = ids.length
      ? await tx.$queryRaw<
          ImageRow[]
        >`SELECT id,"eventId","sourceUrl",mime FROM "OfficialEventImage" WHERE id=ANY(${ids}::text[])`
      : [];
    const byId = new Map(images.map((image) => [image.id, image]));
    return rows.map((row) => {
      const image = row.imageId ? byId.get(row.imageId) : undefined;
      return summary(row, image?.eventId === row.id ? image : null);
    });
  }
  private async detail(tx: Tx, row: Row, historyPage = 1): Promise<OfficialEventDetail> {
    const audits = await tx.$queryRaw<
      {
        id: string;
        action: string;
        reason: string;
        actorId: string | null;
        displayName: string | null;
        createdAt: Date;
        before: unknown;
        after: unknown;
      }[]
    >`
   SELECT h.id,h.action,h.reason,h."actorId",a."displayName",h."createdAt",h.before,h.after FROM "OfficialEventAudit" h
   LEFT JOIN "Account" a ON a.id=h."actorId" WHERE h."eventId"=${row.id} ORDER BY h."createdAt" DESC,h.id DESC LIMIT 20 OFFSET ${(historyPage - 1) * 20}`;
    const [count] = await tx.$queryRaw<
      { total: number }[]
    >`SELECT count(*)::int AS total FROM "OfficialEventAudit" WHERE "eventId"=${row.id}`;
    return {
      ...(await this.summaries(tx, [row]))[0]!,
      sourceKey: row.sourceKey,
      sourceText: row.sourceText,
      manualFields: Array.isArray(row.manualFields)
        ? row.manualFields.filter((field): field is string => typeof field === 'string')
        : [],
      historyPage,
      historyTotal: count!.total,
      audits: audits.map((h) => ({
        id: h.id,
        action: h.action,
        reason: h.reason,
        actor: h.actorId ? { id: h.actorId, displayName: h.displayName } : null,
        createdAt: h.createdAt.toISOString(),
        before: h.before,
        after: h.after
      }))
    };
  }
  async list(url: URL, token?: string | null): Promise<OfficialEventList> {
    const current = page(url.searchParams.get('page')),
      status = url.searchParams.get('status') ?? 'ALL';
    if (!['ALL', 'PENDING', 'PUBLISHED', 'REJECTED', 'WITHDRAWN'].includes(status)) invalid('活动状态无效');
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token, true);
      const rows = await tx.$queryRaw<
        Row[]
      >`SELECT * FROM "OfficialEvent" WHERE (${status}='ALL' OR status=${status}) ORDER BY "createdAt" DESC,id DESC LIMIT 12 OFFSET ${(current - 1) * 12}`;
      const [count] = await tx.$queryRaw<
        { total: number }[]
      >`SELECT count(*)::int AS total FROM "OfficialEvent" WHERE (${status}='ALL' OR status=${status})`;
      const [run] = await tx.$queryRaw<
        Parameters<typeof officialSyncRunView>[0][]
      >`SELECT * FROM "OfficialSyncRun" ORDER BY "createdAt" DESC,id DESC LIMIT 1`;
      const items = await this.summaries(tx, rows);
      await this.fresh(tx, token, actor);
      return { items, total: count!.total, page: current, latestRun: run ? officialSyncRunView(run) : null };
    });
  }
  async get(id: string, url: URL, token?: string | null) {
    activityId(id);
    const historyPage = page(url.searchParams.get('historyPage'));
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token, true);
      const event = await this.detail(tx, await this.row(tx, id), historyPage);
      await this.fresh(tx, token, actor);
      return event;
    });
  }
  private validateMutation(
    row: Row,
    action: unknown,
    expectedRevision: number,
    next: { startsAt: Date | null; endsAt: Date | null } | null
  ) {
    if (row.revision !== expectedRevision) conflict('官方活动已更新，请刷新后重试');
    if (
      (action === 'WITHDRAW' && row.status !== 'PUBLISHED') ||
      (action === 'SAVE' && !['PENDING', 'PUBLISHED'].includes(row.status)) ||
      (['APPROVE', 'REJECT'].includes(String(action)) && row.status !== 'PENDING')
    )
      conflict('当前状态不允许此操作');
    if (action === 'SAVE' && row.status === 'PUBLISHED' && (!next?.startsAt || !next.endsAt))
      invalid('请补齐活动起止时间');
  }
  async mutate(id: string, body: Body, token?: string | null) {
    activityId(id);
    const action = body.action;
    if (!['SAVE', 'APPROVE', 'REJECT', 'WITHDRAW'].includes(String(action))) invalid('操作无效');
    const edit = action === 'SAVE' || action === 'APPROVE';
    // Old in-flight commands may only replay their exact recorded fingerprint.
    // New commands cannot modify source content or images.
    const legacy = edit
      ? ['title', 'sourceUrl', 'summary', 'imageUrl'].some((field) => body[field] !== undefined)
      : action === 'WITHDRAW' && body.reason !== undefined;
    fields(body, [
      'action',
      'expectedRevision',
      'idempotencyKey',
      ...(edit
        ? legacy
          ? ['title', 'sourceUrl', 'summary', 'startsAt', 'endsAt', 'imageUrl']
          : ['startsAt', 'endsAt']
        : action === 'REJECT' || legacy
          ? ['reason']
          : [])
    ]);
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
      invalid('活动版本无效');
    const idempotencyKey = key(body.idempotencyKey),
      expectedRevision = Number(body.expectedRevision);
    const next = edit ? { startsAt: instant(body.startsAt), endsAt: instant(body.endsAt) } : null;
    if (next?.startsAt && next.endsAt && next.endsAt <= next.startsAt) invalid('结束时间须晚于开始时间');
    if (action === 'APPROVE' && (!next?.startsAt || !next.endsAt)) invalid('请补齐活动起止时间后通过');
    const reason = edit
      ? action === 'APPROVE'
        ? '审核通过'
        : '管理员纠错'
      : action === 'WITHDRAW' && !legacy
        ? '管理员下架'
        : text(body.reason, 500);
    const legacyNext =
      legacy && edit
        ? {
            title: body.title === undefined ? null : text(body.title, 300),
            sourceUrl: body.sourceUrl === undefined ? null : text(body.sourceUrl, 2048),
            summary: text(body.summary, 2000, true),
            ...next
          }
        : null;
    const legacyImage =
      legacy && edit && body.imageUrl !== undefined
        ? body.imageUrl === null
          ? null
          : text(body.imageUrl, 2048)
        : undefined;
    const fingerprint = tokenDigest(
      JSON.stringify({
        action,
        expectedRevision,
        ...(legacy ? legacyNext : next),
        reason,
        ...(legacyImage !== undefined ? { imageUrl: legacyImage } : {})
      })
    );
    const actor = await this.auth.requireAccount(this.auth.db, token, true);
    await this.auth.rate('official-review:' + actor.accountId, 120, 900);
    const result = await this.auth.transaction(async (tx) => {
      await this.actorLocked(tx, token, actor);
      await lock(tx, 'official-event:' + id);
      await tx.$queryRaw`SELECT id FROM "OfficialEvent" WHERE id=${id} FOR UPDATE`;
      await this.fresh(tx, token, actor);
      const row = await this.row(tx, id);
      const [previous] = await tx.$queryRaw<
        { requestFingerprint: string }[]
      >`SELECT "requestFingerprint" FROM "OfficialEventCommand" WHERE "eventId"=${id} AND "actorId"=${actor.accountId} AND "idempotencyKey"=${idempotencyKey}`;
      if (previous && previous.requestFingerprint !== fingerprint)
        conflict('同次提交内容已变化，请使用原内容重试');
      if (!previous) {
        if (legacy) invalid('来源内容与图片由同步维护，不能手工修改');
        this.validateMutation(row, action, expectedRevision, next);
        const status =
          action === 'SAVE'
            ? row.status
            : action === 'APPROVE'
              ? 'PUBLISHED'
              : action === 'REJECT'
                ? 'REJECTED'
                : 'WITHDRAWN';
        const changed = {
          title: row.sourceTitle,
          sourceUrl: row.sourceUrl,
          status,
          summary: row.summary,
          startsAt: next ? next.startsAt : row.startsAt,
          endsAt: next ? next.endsAt : row.endsAt
        };
        const manualFields = new Set(
          Array.isArray(row.manualFields)
            ? row.manualFields.filter((field): field is string => typeof field === 'string')
            : []
        );
        const before = (await this.summaries(tx, [row]))[0]!;
        for (const field of ['title', 'sourceUrl', 'summary', 'startsAt', 'endsAt', 'status'] as const) {
          const value = changed[field],
            serialized = value instanceof Date ? value.toISOString() : value;
          if (serialized !== before[field]) manualFields.add(field);
        }
        const now = this.auth.now();
        const imageId = row.imageId ?? null;
        await tx.$executeRaw`UPDATE "OfficialEvent" SET "imageId"=${imageId},"sourceTitle"=${changed.title},"sourceUrl"=${changed.sourceUrl},"manualFields"=${JSON.stringify([...manualFields])}::jsonb,status=${changed.status},summary=${changed.summary},"startsAt"=${changed.startsAt},"endsAt"=${changed.endsAt},revision=revision+1,"updatedAt"=${now} WHERE id=${id} AND revision=${expectedRevision}`;
        const after = await this.row(tx, id);
        await tx.$executeRaw`INSERT INTO "OfficialEventAudit" (id,"eventId","actorId",action,reason,before,after,"createdAt") VALUES (${randomUUID()},${id},${actor.accountId},${String(action)},${reason},${JSON.stringify(before)}::jsonb,${JSON.stringify((await this.summaries(tx, [after]))[0])}::jsonb,${now})`;
        await tx.$executeRaw`INSERT INTO "OfficialEventCommand" (id,"eventId","actorId","idempotencyKey","requestFingerprint",action,"createdAt") VALUES (${randomUUID()},${id},${actor.accountId},${idempotencyKey},${fingerprint},${String(action)},${now})`;
      }
      const event = await this.detail(tx, await this.row(tx, id));
      await this.fresh(tx, token, actor);
      return { event, replayed: Boolean(previous) };
    });
    return result;
  }
  async calendar(url: URL, token?: string | null): Promise<OfficialCalendar> {
    const month = url.searchParams.get('month') ?? '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1000) invalid('月份无效');
    const first = new Date(month + '-01T00:00:00Z');
    const gridStart = new Date(first);
    gridStart.setUTCDate(1 - first.getUTCDay());
    const startsAt = fromBeijingParts({
        year: gridStart.getUTCFullYear(),
        month: gridStart.getUTCMonth() + 1,
        day: gridStart.getUTCDate(),
        hour: 0,
        minute: 0
      }),
      endsAt = new Date(startsAt.getTime() + 42 * 86_400_000);
    return this.auth.transaction(async (tx) => {
      const actor = await this.auth.requireAccount(tx, token);
      const rows = await tx.$queryRaw<
        Row[]
      >`SELECT * FROM "OfficialEvent" WHERE status='PUBLISHED' AND "startsAt"<${endsAt} AND "endsAt">=${startsAt} ORDER BY "startsAt","endsAt",id`;
      const summaries = await this.summaries(tx, rows);
      const items = rows.map((row, index) => ({
        id: row.id,
        title: row.sourceTitle,
        summary: row.summary,
        sourceUrl: row.sourceUrl,
        image: summaries[index]!.image ?? null,
        startsAt: row.startsAt!.toISOString(),
        endsAt: row.endsAt!.toISOString()
      }));
      await this.fresh(tx, token, actor, false);
      return { items, month, serverNow: this.auth.now().toISOString(), timeZone: 'Asia/Shanghai' };
    });
  }
  async image(id: string, imageId: string, variant: string, token?: string | null) {
    const eventId = activityId(id),
      assetId = activityId(imageId);
    if (!['original', 'preview', 'thumbnail'].includes(variant)) invalid('图片版本无效');
    const actor = await this.auth.requireAccount(this.auth.db, token);
    const authorized = async (tx: Tx) => {
      const current = await this.fresh(tx, token, actor, false);
      await tx.$queryRaw`SELECT id FROM "OfficialEvent" WHERE id=${eventId} FOR SHARE`;
      const event = await this.row(tx, eventId);
      const [image] = await tx.$queryRaw<
        ImageRow[]
      >`SELECT id,"eventId","sourceUrl",mime FROM "OfficialEventImage" WHERE id=${assetId} AND "eventId"=${eventId}`;
      if (
        !image ||
        (current.account.adminRole === 'NONE' && (event.status !== 'PUBLISHED' || event.imageId !== image.id))
      )
        throw new AccountError('NOT_FOUND', '官方图片不存在', 404);
      await this.fresh(tx, token, actor, false);
      return image;
    };
    const image = await this.auth.transaction(authorized);
    const bytes = await this.imagePorts.storage.read(assetId, variant as ImageVariant);
    await this.auth.transaction(authorized);
    return { bytes, mime: variant === 'original' ? image.mime : 'image/webp' };
  }
  async sync(body: Body, token?: string | null) {
    fields(body, ['idempotencyKey']);
    const idempotencyKey = key(body.idempotencyKey);
    const actor = await this.auth.requireAccount(this.auth.db, token, true);
    await this.auth.rate('official-sync:' + actor.accountId, 20, 3600);
    const { run, replayed } = await runOfficialEventSync(this.auth.db, {
      actorId: actor.accountId,
      idempotencyKey,
      now: this.auth.now,
      imagePorts: this.imagePorts,
      beforeWrite: async (tx) => {
        await this.actorLocked(tx, token, actor);
      },
      finalCheck: async (tx) => {
        await this.fresh(tx, token, actor);
      }
    });
    return { run, replayed };
  }
}
