import type { Prisma } from '@artzoo/db';
import { AccountError } from '@artzoo/domain';
import { AccountService, lock } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import { ANNOUNCEMENT_MAX_LENGTH, type AnnouncementList, type AnnouncementCommandResult } from './contract';
type Tx = Prisma.TransactionClient;
type Actor = Awaited<ReturnType<AccountService['requireAccount']>>;
type Body = Record<string, unknown>;
function invalid(message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400);
}
function conflict(message = '公告展示已更新，请重新读取展示选择'): never {
  throw new AccountError('CONFLICT', message, 409);
}
function fields(body: Body, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) invalid('提交字段无效');
}
function key(value: unknown) {
  if (typeof value !== 'string' || !/^[-_a-zA-Z0-9]{16,128}$/.test(value)) invalid('提交标识无效');
  return value;
}
function revision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= 2147483647) invalid('版本无效');
  return Number(value);
}
export function announcementText(value: unknown) {
  if (typeof value !== 'string') invalid('请填写公告内容');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (
    !text ||
    [...text].length > ANNOUNCEMENT_MAX_LENGTH ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(text)
  )
    invalid('公告需为1—2000字纯文字，不能包含控制字符');
  return text;
}
function selection(value: unknown) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some(
      (id) =>
        typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
    ) ||
    new Set(value).size !== value.length
  )
    invalid('请至少选择一条有效公告');
  return (value as string[]).slice().sort();
}
const order = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
export class AnnouncementService {
  constructor(readonly auth: AccountService) {}
  private async fresh(tx: Tx, token: string | null | undefined, expected: Actor) {
    const actor = await this.auth.requireAccount(tx, token, true);
    if (
      actor.expiresAt <= this.auth.now() ||
      actor.id !== expected.id ||
      actor.accountId !== expected.accountId ||
      actor.account.membership !== expected.account.membership ||
      actor.account.adminRole !== expected.account.adminRole
    )
      throw new AccountError('UNAUTHENTICATED', '登录身份已变化，请重新登录', 401);
    return actor;
  }
  private async writeActor(tx: Tx, token: string | null | undefined, expected: Actor) {
    await lock(tx, 'phone:' + expected.account.phone);
    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${expected.accountId} FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${expected.id} FOR UPDATE`;
    await this.fresh(tx, token, expected);
    await lock(tx, 'site-announcements:write');
  }
  async active() {
    const items = await this.auth.db.siteAnnouncement.findMany({
      where: { active: true, deletedAt: null },
      orderBy: order,
      select: { id: true, text: true }
    });
    return { items };
  }
  async list(url: URL, token?: string | null): Promise<AnnouncementList> {
    const actor = await this.auth.requireAccount(this.auth.db, token, true);
    const number = (name: string, fallback: number, max: number) => {
      const raw = url.searchParams.get(name);
      if (raw === null) return fallback;
      if (!/^[1-9]\d{0,6}$/.test(raw) || Number(raw) > max) invalid('分页参数无效');
      return Number(raw);
    };
    const requestedPage = number('page', 1, 1000000),
      pageSize = number('pageSize', 12, 100);
    const result = await this.auth.db.$transaction(
      async (tx) => {
        const state = await tx.siteAnnouncementState.findUnique({ where: { id: 'site' } });
        const total = await tx.siteAnnouncement.count({ where: { deletedAt: null } }),
          page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
        const rows = await tx.siteAnnouncement.findMany({
          where: { deletedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize
        });
        const selected = await tx.siteAnnouncement.findMany({
          where: { active: true, deletedAt: null },
          select: { id: true },
          orderBy: order
        });
        return {
          items: rows.map((row) => ({
            id: row.id,
            text: row.text,
            createdAt: row.createdAt.toISOString(),
            active: row.active
          })),
          selectedIds: selected.map((row) => row.id),
          revision: state?.revision ?? 0,
          total,
          page,
          pageSize
        };
      },
      { isolationLevel: 'RepeatableRead' }
    );
    await this.fresh(this.auth.db, token, actor);
    return result;
  }
  private async mutate(
    kind: 'publish' | 'selection' | 'delete',
    body: Body,
    token?: string | null,
    targetId?: string
  ): Promise<AnnouncementCommandResult> {
    fields(
      body,
      kind === 'publish'
        ? ['text', 'idempotencyKey']
        : kind === 'selection'
          ? ['selectedIds', 'expectedRevision', 'idempotencyKey']
          : ['expectedRevision', 'idempotencyKey']
    );
    const idempotencyKey = key(body.idempotencyKey),
      text = kind === 'publish' ? announcementText(body.text) : null;
    const selectedIds = kind === 'selection' ? selection(body.selectedIds) : [],
      expectedRevision = kind !== 'publish' ? revision(body.expectedRevision) : null;
    const announcementId = kind === 'delete' ? selection([targetId])[0]! : null;
    // Preserve the established publish/selection fingerprint so old commands remain replayable.
    const fingerprint = tokenDigest(
      JSON.stringify(
        kind === 'delete'
          ? { kind, announcementId, expectedRevision }
          : { kind, text, selectedIds, expectedRevision }
      )
    );
    const actor = await this.auth.requireAccount(this.auth.db, token, true);
    return this.auth.transaction(async (tx) => {
      await this.writeActor(tx, token, actor);
      const old = await tx.siteAnnouncementCommand.findUnique({
        where: { actorId_idempotencyKey: { actorId: actor.accountId, idempotencyKey } }
      });
      if (old) {
        if (old.requestFingerprint !== fingerprint) conflict('同次提交内容已变化，请使用原内容重试');
        await this.fresh(tx, token, actor);
        return {
          revision: (old.result as { revision: number }).revision,
          replayed: true,
          ...(kind === 'delete' ? { deleted: true } : {})
        };
      }
      if (kind === 'delete') {
        const target = await tx.siteAnnouncement.findUnique({ where: { id: announcementId! } });
        if (!target) throw new AccountError('NOT_FOUND', '公告不存在', 404);
        if (target.deletedAt)
          throw new AccountError('ANNOUNCEMENT_DELETED', '这条公告已删除，请重新读取公告列表', 410);
      }
      const state = await tx.siteAnnouncementState.upsert({
        where: { id: 'site' },
        create: { id: 'site', revision: 0 },
        update: {}
      });
      if (state.revision >= 2147483646) conflict('公告版本已达上限，请联系维护者');
      if (kind !== 'publish' && state.revision !== expectedRevision) conflict();
      if (kind === 'selection') {
        if (
          (await tx.siteAnnouncement.count({ where: { id: { in: selectedIds }, deletedAt: null } })) !==
          selectedIds.length
        )
          invalid('选择的公告不存在，请重新读取');
      }
      if (kind !== 'delete')
        await tx.siteAnnouncement.updateMany({
          where: { active: true, deletedAt: null },
          data: { active: false }
        });
      if (kind === 'delete')
        await tx.siteAnnouncement.update({
          where: { id: announcementId! },
          data: { active: false, deletedAt: this.auth.now(), deletedById: actor.accountId }
        });
      else if (kind === 'publish')
        await tx.siteAnnouncement.create({
          data: { text: text!, active: true, createdById: actor.accountId, createdAt: this.auth.now() }
        });
      else
        await tx.siteAnnouncement.updateMany({
          where: { id: { in: selectedIds }, deletedAt: null },
          data: { active: true }
        });
      const updated = await tx.siteAnnouncementState.update({
        where: { id: 'site' },
        data: { revision: { increment: 1 } }
      });
      await tx.siteAnnouncementCommand.create({
        data: {
          actorId: actor.accountId,
          idempotencyKey,
          requestFingerprint: fingerprint,
          kind,
          result: {
            revision: updated.revision,
            ...(kind === 'delete' ? { announcementId: announcementId!, deleted: true } : {})
          },
          createdAt: this.auth.now()
        }
      });
      await this.fresh(tx, token, actor);
      return { revision: updated.revision, replayed: false, ...(kind === 'delete' ? { deleted: true } : {}) };
    });
  }
  remove(id: string, body: Body, token?: string | null) {
    return this.mutate('delete', body, token, id);
  }
  publish(body: Body, token?: string | null) {
    return this.mutate('publish', body, token);
  }
  select(body: Body, token?: string | null) {
    return this.mutate('selection', body, token);
  }
}
