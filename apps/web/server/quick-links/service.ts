import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@artzoo/db';
import { AccountError } from '@artzoo/domain';
import { AccountService, lock } from '../auth/service';
import { tokenDigest } from '../auth/crypto';
import { resourceId, resourceUrl } from '../resources/contract';
import { quickCommand, quickInvalid, quickPage, type QuickLinkList, type QuickLinkResult } from './contract';
import {
  fetchQuickIcon,
  fetchQuickWebsite,
  fetchQuickIconMetered,
  fetchQuickWebsiteMetered,
  type QuickIconMeterPort
} from './icon';
import {
  quickIconPolicy,
  selectedIconBytes,
  iconBudgetUnavailable,
  captureQuickIconMutation,
  settleQuickIcon
} from './icon-budget';
import {
  MANUAL_ICON_MAX_BYTES,
  processManualIcon,
  validateManualIconFile,
  type ManualIconFile
} from './manual-icon';
type Tx = Prisma.TransactionClient;
type Actor = Awaited<ReturnType<AccountService['requireAccount']>>;
type Row = {
  id: string;
  name: string;
  url: string;
  revision: number;
  position: number;
  iconVersion: string | null;
  iconSource: string;
};
const conflict = () => {
  throw new AccountError('CONFLICT', '快捷入口已更新，请重新读取后操作', 409);
};
const listSelect = {
  id: true,
  name: true,
  url: true,
  revision: true,
  position: true,
  iconVersion: true,
  iconSource: true
} as const;
export class QuickLinkService {
  constructor(
    readonly auth: AccountService,
    readonly fetchIcon: (url: string) => Promise<Buffer | null> = fetchQuickIcon,
    readonly fetchWebsite: (
      url: string
    ) => Promise<{ name: string | null; icon: Buffer | null }> = fetchQuickWebsite,
    readonly meter?: QuickIconMeterPort
  ) {}
  private async fresh(tx: Tx, token?: string | null, expected?: Actor) {
    const actor = await this.auth.requireAccount(tx, token, true);
    if (actor.expiresAt <= this.auth.now())
      throw new AccountError('UNAUTHENTICATED', '登录已过期，请重新登录', 401);
    if (
      expected &&
      (actor.id !== expected.id ||
        actor.accountId !== expected.accountId ||
        actor.account.membership !== expected.account.membership ||
        actor.account.adminRole !== expected.account.adminRole)
    )
      throw new AccountError('UNAUTHENTICATED', '登录身份已变化，请重新登录', 401);
    return actor;
  }
  async list(url: URL, token?: string | null, admin = false): Promise<QuickLinkList> {
    const actor = admin ? await this.fresh(this.auth.db, token) : null;
    const { page: requested, pageSize, query } = quickPage(url);
    const result = await this.auth.db.$transaction(
      async (tx) => {
        // Raw literal substring search deliberately treats %, _ and SQL punctuation as text.
        const counts = await tx.$queryRaw<
          Array<{ total: number }>
        >`SELECT count(*)::int AS total FROM "ResourceLink" WHERE (${query}='' OR strpos(lower("name"),lower(${query}))>0)`;
        const total = counts[0]!.total,
          totalPages = Math.max(1, Math.ceil(total / pageSize)),
          page = Math.min(requested, totalPages),
          offset = (page - 1) * pageSize;
        const items = await tx.$queryRaw<
          Row[]
        >`SELECT "id","name","url","revision","position","iconVersion" FROM "ResourceLink" WHERE (${query}='' OR strpos(lower("name"),lower(${query}))>0) ORDER BY "position","id" OFFSET ${offset} LIMIT ${pageSize}`;
        const state = await tx.quickLinkState.findUniqueOrThrow({ where: { id: 'global' } });
        return {
          items: items.map((row, i) => ({
            id: row.id,
            name: row.name,
            url: row.url,
            revision: row.revision,
            ordinal: offset + i,
            icon: row.iconVersion ? '/api/quick-links/' + row.id + '/icon?v=' + row.iconVersion : null
          })),
          revision: state.revision,
          page,
          pageSize,
          total,
          totalPages
        };
      },
      { isolationLevel: 'RepeatableRead' }
    );
    if (actor) await this.fresh(this.auth.db, token, actor);
    return result;
  }
  async icon(id: string, version: string | null) {
    resourceId(id);
    if (!version || !/^[a-f0-9]{64}$/.test(version)) throw new AccountError('NOT_FOUND', '图标不存在', 404);
    const row = await this.auth.db.resourceLink.findUnique({
      where: { id },
      select: { iconVersion: true, iconBytes: true }
    });
    if (!row?.iconBytes || row.iconVersion !== version)
      throw new AccountError('NOT_FOUND', '图标不存在', 404);
    return Buffer.from(row.iconBytes);
  }
  async mutate(body: Record<string, unknown>, token?: string | null): Promise<QuickLinkResult> {
    return this.mutateInternal(body, token);
  }
  async authorizeIconUpload(token?: string | null): Promise<void> {
    const actor = await this.fresh(this.auth.db, token);
    await this.auth.rate('quick-links-icon-upload:' + actor.accountId, 30, 900);
  }
  async mutateWithIcon(
    body: Record<string, unknown>,
    token: string | null | undefined,
    file: ManualIconFile
  ): Promise<QuickLinkResult> {
    return this.mutateInternal(body, token, file);
  }
  private async mutateInternal(
    body: Record<string, unknown>,
    token?: string | null,
    file?: ManualIconFile
  ): Promise<QuickLinkResult> {
    const input = quickCommand(body);
    if (file && input.action !== 'update') quickInvalid('手动图标仅支持修改现有快捷入口');
    const actor = await this.fresh(this.auth.db, token);
    await this.auth.rate('quick-links:' + actor.accountId, 120, 900);
    // Keep legacy JSON fingerprints byte-for-byte; file identity is server-computed.
    if (
      file &&
      (!Buffer.isBuffer(file.input) || !file.input.length || file.input.length > MANUAL_ICON_MAX_BYTES)
    )
      quickInvalid('图片大小需在 2 MB 以内');
    const upload = file ? { input: Buffer.from(file.input), name: file.name, type: file.type } : null;
    if (upload) validateManualIconFile(upload);
    const fileHash = upload ? createHash('sha256').update(upload.input).digest('hex') : null;
    const fingerprint = tokenDigest(
      JSON.stringify(upload ? { command: input, manualIconSha256: fileHash } : input)
    );
    const previous = await this.auth.db.quickLinkCommand.findUnique({
      where: { actorId_idempotencyKey: { actorId: actor.accountId, idempotencyKey: input.idempotencyKey } }
    });
    if (previous && previous.requestFingerprint !== fingerprint) conflict();
    const autoName = input.action === 'create' && input.name === null;
    const sameUrl = (value: string) => {
      try {
        return resourceUrl(value) === input.url;
      } catch {
        return value === input.url;
      }
    };
    const original = input.id
      ? await this.auth.db.resourceLink.findUnique({ where: { id: input.id }, select: listSelect })
      : null;
    const refreshIcon =
      !upload &&
      !previous &&
      original?.iconSource !== 'manual' &&
      (input.action === 'create' ||
        (input.action === 'update' && (!original || !sameUrl(original.url) || !original.iconVersion)));
    // External work starts only after role/input validation, outside the transaction/locks.
    // Failure has a default icon; the final transaction rechecks identity after this wait.
    const preventDuplicate =
      input.action === 'create' || (input.action === 'update' && original && !sameUrl(original.url));
    if (!previous && preventDuplicate) {
      const links = await this.auth.db.resourceLink.findMany({ select: { id: true, url: true } });
      if (links.some((row) => row.id !== input.id && sameUrl(row.url))) quickInvalid('该网址已存在');
    }
    const checksIconPolicy = !previous && (upload || refreshIcon);
    const policy = checksIconPolicy ? quickIconPolicy(process.env) : null;
    let autoRawBytes = 0;
    // Existing custom fetch ports must explicitly provide their own measured equivalent on ON.
    // Never fall back from an injected mock/custom fetch to real networking.
    const measured =
      policy?.enabled && !upload && !previous && (autoName || refreshIcon)
        ? (this.meter ?? {
            website:
              this.fetchWebsite === fetchQuickWebsite ? fetchQuickWebsiteMetered : iconBudgetUnavailable,
            icon: this.fetchIcon === fetchQuickIcon ? fetchQuickIconMetered : iconBudgetUnavailable
          })
        : null;
    if (
      measured &&
      ((autoName && measured.website === iconBudgetUnavailable) ||
        (!autoName && measured.icon === iconBudgetUnavailable))
    )
      iconBudgetUnavailable();
    const metadata =
      autoName && !previous
        ? measured
          ? await measured.website(input.url!).catch(() => ({ name: null, icon: null, rawBytes: 0 }))
          : await this.fetchWebsite(input.url!).catch(() => ({ name: null, icon: null }))
        : null;
    if (measured && metadata)
      autoRawBytes = selectedIconBytes(
        metadata.icon,
        'rawBytes' in metadata ? (metadata.rawBytes as number) : 0
      );
    const name = autoName ? metadata?.name || new URL(input.url!).hostname.slice(0, 80) : input.name;
    const manualIcon = upload && !previous ? await processManualIcon(upload) : null;
    let icon = manualIcon ?? (metadata ? metadata.icon : null);
    if (!manualIcon && !metadata && refreshIcon) {
      if (measured) {
        const result = await measured.icon(input.url!).catch(() => ({ icon: null, rawBytes: 0 }));
        autoRawBytes = selectedIconBytes(result.icon, result.rawBytes);
        icon = result.icon;
      } else icon = await this.fetchIcon(input.url!).catch(() => null);
    }
    return this.auth.transaction(async (tx) => {
      await lock(tx, 'phone:' + actor.account.phone);
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${actor.accountId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AccountSession" WHERE "id"=${actor.id} FOR UPDATE`;
      await this.fresh(tx, token, actor);
      await lock(tx, 'quick-links:catalog');
      await this.fresh(tx, token, actor);
      const old = await tx.quickLinkCommand.findUnique({
        where: { actorId_idempotencyKey: { actorId: actor.accountId, idempotencyKey: input.idempotencyKey } }
      });
      if (old) {
        if (old.requestFingerprint !== fingerprint) conflict();
        await this.fresh(tx, token, actor);
        return { ...(old.result as unknown as QuickLinkResult), replayed: true };
      }
      const state = await tx.quickLinkState.findUniqueOrThrow({ where: { id: 'global' } });
      if (state.revision !== input.expectedRevision) conflict();
      const rows = await tx.resourceLink.findMany({
        select: listSelect,
        orderBy: [{ position: 'asc' }, { id: 'asc' }]
      });
      const index = rows.findIndex((row) => row.id === input.id),
        target = index >= 0 ? rows[index]! : null;
      if (input.action !== 'create' && (!target || target.revision !== input.revision)) conflict();
      if (preventDuplicate && rows.some((row) => row.id !== input.id && sameUrl(row.url)))
        quickInvalid('该网址已存在');
      let id = input.id;
      const iconData = upload
        ? {
            iconBytes: new Uint8Array(manualIcon!),
            iconVersion: createHash('sha256').update(manualIcon!).digest('hex'),
            iconSource: 'manual'
          }
        : refreshIcon
          ? {
              iconSource: 'auto',
              iconBytes: icon ? new Uint8Array(icon) : null,
              iconVersion: icon ? createHash('sha256').update(icon).digest('hex') : null
            }
          : {};
      const replacesIcon = input.action === 'update' && Object.hasOwn(iconData, 'iconBytes');
      const retiresIcon = input.action === 'remove' || replacesIcon;
      const stockEnabled =
        policy?.enabled ||
        (!checksIconPolicy && retiresIcon && process.env.ARTZOO_MEDIA_BUDGET_ENABLED === '1');
      let stockPolicy = policy;
      const priorIcon =
        stockEnabled && retiresIcon && (input.action === 'remove' || original?.url === target?.url)
          ? await captureQuickIconMutation(tx, {
              actorId: actor.accountId,
              key: input.idempotencyKey,
              fingerprint,
              id: id!,
              kind: input.action as 'update' | 'remove',
              linkRevision: target!.revision,
              catalogRevision: state.revision
            })
          : null;
      if (priorIcon && !stockPolicy) stockPolicy = quickIconPolicy(process.env);
      if (input.action === 'create') {
        if (rows.length >= 500) quickInvalid('快捷入口最多可添加500个');
        const category = await tx.resourceCategory.upsert({
          where: { name: '快捷入口' },
          create: { name: '快捷入口' },
          update: {}
        });
        id = randomUUID();
        await tx.resourceLink.create({
          data: {
            id,
            name: name!,
            url: input.url!,
            purpose: '',
            categoryId: category.id,
            position: rows.length ? rows.at(-1)!.position + 1 : 0,
            ...iconData
          }
        });
      } else if (input.action === 'update') {
        // A concurrent URL change cannot attach the previously fetched site's icon.
        if (original?.url !== target!.url) conflict();
        await tx.resourceLink.update({
          where: { id: id! },
          data: { name: input.name!, url: input.url!, revision: { increment: 1 }, ...iconData }
        });
      } else if (input.action === 'remove') {
        await tx.resourceLink.delete({ where: { id: id! } });
      } else {
        const destination =
          'targetId' in input
            ? rows.findIndex((row) => row.id === input.targetId)
            : index + (input.direction === 'up' ? -1 : 1);
        if (destination < 0 || destination >= rows.length || destination === index)
          quickInvalid('排序目标无效');
        // Move into the target's original slot in one catalog-locked transaction.
        // Preserve untouched positions, including gaps left by deleted links.
        const ordered = [...rows],
          positions = rows.map((row) => row.position);
        ordered.splice(destination, 0, ordered.splice(index, 1)[0]!);
        for (let i = Math.min(index, destination); i <= Math.max(index, destination); i++) {
          await tx.resourceLink.update({
            where: { id: ordered[i]!.id },
            data: { position: positions[i], revision: { increment: 1 } }
          });
        }
      }
      const revision = state.revision + 1;
      await tx.quickLinkState.update({ where: { id: 'global' }, data: { revision } });
      const result = { id: id!, revision, replayed: false, ...(autoName ? { name: name! } : {}) };
      await tx.quickLinkCommand.create({
        data: {
          actorId: actor.accountId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          kind: input.action,
          result,
          snapshot: {
            id,
            before: target ? { name: target.name, url: target.url, position: target.position } : null,
            after:
              input.action === 'remove' ? null : { name: name ?? target?.name, url: input.url ?? target?.url }
          }
        }
      });
      if (policy?.enabled && iconData.iconBytes && iconData.iconVersion) {
        await settleQuickIcon(
          tx,
          {
            manual: !!upload,
            actorId: actor.accountId,
            key: input.idempotencyKey,
            fingerprint,
            id: id!,
            version: iconData.iconVersion,
            rawBytes: upload ? upload.input.length : autoRawBytes,
            storedBytes: iconData.iconBytes.length
          },
          policy,
          this.auth.now,
          priorIcon
        );
      } else if (priorIcon && stockPolicy?.enabled) {
        await settleQuickIcon(
          tx,
          { kind: 'retire-only', actorId: actor.accountId, key: input.idempotencyKey, fingerprint, id: id! },
          stockPolicy,
          this.auth.now,
          priorIcon
        );
      }
      await this.fresh(tx, token, actor);
      return result;
    });
  }
}
