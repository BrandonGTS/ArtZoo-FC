import type { Prisma } from '@artzoo/db';
import { AccountError } from '@artzoo/domain';
import { AccountService, lock } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import { contactInput, contactPage, invalid, processInput, type ContactMessage } from './contract';
import { GUEST_TEXT_ONLY_ERROR, guestTextContainsSticker } from '../../components/guest-contact/text-policy';

type Tx = Prisma.TransactionClient;
type Actor = Awaited<ReturnType<AccountService['requireAccount']>>;
const handler = { processedBy: { select: { id: true, displayName: true } } } as const;
type Row = Prisma.GuestContactMessageGetPayload<{ include: typeof handler }>;
function view(row: Row): ContactMessage {
  return {
    id: row.id,
    qq: row.qq,
    message: row.message,
    status: row.status,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
    processedBy: row.processedBy
  };
}
export class GuestContactService {
  constructor(readonly auth: AccountService) {}
  async submit(body: Record<string, unknown>) {
    const { qq, message, submissionKey } = contactInput(body);
    const requestFingerprint = tokenDigest(JSON.stringify({ qq, message }));
    return this.auth.transaction(async (tx) => {
      // No trustworthy source IP is available here. One transaction-scoped global lock
      // serializes both the shared quota and same-key replay before consuming any quota.
      await lock(tx, 'guest-contact:submit');
      const old = await tx.guestContactMessage.findUnique({ where: { submissionKey } });
      if (old) {
        if (old.requestFingerprint !== requestFingerprint)
          throw new AccountError('CONFLICT', '同次提交内容已变化，请使用原内容重试', 409);
        return { submitted: true as const, replayed: true };
      }
      // Existing confirmed receipts remain replayable even if they predate the text-only policy.
      // Reject only a new image-bearing request, before inspecting or consuming any quota.
      if (guestTextContainsSticker(message)) invalid(GUEST_TEXT_ONLY_ERROR);
      const now = this.auth.now(),
        qqKey = tokenDigest('guest-contact:qq:' + qq),
        globalKey = tokenDigest('guest-contact:global');
      const buckets = [
        { key: qqKey, limit: 1, seconds: 60 },
        { key: qqKey, limit: 3, seconds: 86400 },
        { key: globalKey, limit: 10, seconds: 60 }
      ];
      for (const bucket of buckets) {
        const where = { key: bucket.key, createdAt: { gt: new Date(now.getTime() - bucket.seconds * 1000) } };
        if ((await tx.accountRateEvent.count({ where })) >= bucket.limit) {
          const first = await tx.accountRateEvent.findFirst({
            where,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
          });
          const retry = Math.max(
            1,
            Math.ceil(
              ((first?.createdAt.getTime() ?? now.getTime()) + bucket.seconds * 1000 - now.getTime()) / 1000
            )
          );
          throw new AccountError('RATE_LIMITED', '留言提交过于频繁，请稍后再试', 429, undefined, retry);
        }
      }
      await tx.guestContactMessage.create({
        data: { qq, message, submissionKey, requestFingerprint, createdAt: now }
      });
      await tx.accountRateEvent.createMany({
        data: [
          { key: qqKey, createdAt: now },
          { key: globalKey, createdAt: now }
        ]
      });
      return { submitted: true as const, replayed: false };
    });
  }
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
  async list(url: URL, token?: string | null) {
    const actor = await this.auth.requireAccount(this.auth.db, token, true);
    const { status, query, page, pageSize } = contactPage(url);
    const result = await this.auth.db.$transaction(
      async (tx) => {
        const escaped = query.replace(/[\\%_]/g, '\\$&');
        const where: Prisma.GuestContactMessageWhereInput = {
          status,
          ...(query
            ? { OR: [{ qq: { contains: escaped } }, { message: { contains: escaped, mode: 'insensitive' } }] }
            : {})
        };
        const total = await tx.guestContactMessage.count({ where });
        const rows = await tx.guestContactMessage.findMany({
          where,
          include: handler,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize
        });
        return { items: rows.map(view), total, page, pageSize };
      },
      { isolationLevel: 'RepeatableRead' }
    );
    await this.auth.requireAccount(this.auth.db, token, true).then((current) => {
      if (
        current.expiresAt <= this.auth.now() ||
        current.id !== actor.id ||
        current.accountId !== actor.accountId ||
        current.account.membership !== actor.account.membership ||
        current.account.adminRole !== actor.account.adminRole
      )
        throw new AccountError('UNAUTHENTICATED', '登录身份已变化，请重新登录', 401);
    });
    return result;
  }
  async process(id: string, body: Record<string, unknown>, token?: string | null) {
    const expectedRevision = processInput(id, body),
      expected = await this.auth.requireAccount(this.auth.db, token, true);
    return this.auth.transaction(async (tx) => {
      // Follow existing account/lifecycle lock order before locking the contact row.
      await lock(tx, 'phone:' + expected.account.phone);
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${expected.accountId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${expected.id} FOR UPDATE`;
      const actor = await this.fresh(tx, token, expected);
      await tx.$queryRaw`SELECT "id" FROM "GuestContactMessage" WHERE "id"=${id} FOR UPDATE`;
      let row = await tx.guestContactMessage.findUnique({ where: { id }, include: handler });
      if (!row) throw new AccountError('NOT_FOUND', '留言不存在', 404);
      const replayed = row.status === 'PROCESSED';
      if (!replayed) {
        if (row.revision !== expectedRevision)
          throw new AccountError('CONFLICT', '留言已更新，请重新读取后操作', 409);
        row = await tx.guestContactMessage.update({
          where: { id },
          data: {
            status: 'PROCESSED',
            processedById: actor.accountId,
            processedAt: this.auth.now(),
            revision: { increment: 1 }
          },
          include: handler
        });
      }
      await this.fresh(tx, token, expected);
      return { item: view(row), replayed };
    });
  }
}
