import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AccountError } from '@artzoo/domain';
import type { Prisma, PrismaClient } from '@artzoo/db';
import { lotteryAccountActive } from '@artzoo/db/lottery-eligibility';
import { mainlandChinaPhone } from '../auth/ports';
import { lock } from '../auth/service';

export const LOCAL_QC_NAMESPACE = 'artzoo-local-qc-v1';
export const LOCAL_QC_LABEL = '[虚构QC-V1]';
export const LOCAL_QC_MIGRATION = '20261019210000_local_qc_tools';
export const QC_ACTORS = [
  {
    slot: 'member-a',
    membership: 'MEMBER',
    displayName: `${LOCAL_QC_LABEL}同名练习`,
    gameRegion: '陆行鸟',
    gameServer: '拉诺西亚'
  },
  {
    slot: 'member-b',
    membership: 'MEMBER',
    displayName: `${LOCAL_QC_LABEL}同名练习`,
    gameRegion: '陆行鸟',
    gameServer: '幻影群岛'
  },
  {
    slot: 'friend',
    membership: 'FRIEND',
    displayName: `${LOCAL_QC_LABEL}亲友练习`,
    gameRegion: '莫古力',
    gameServer: '潮风亭'
  },
  {
    slot: 'admin',
    membership: 'MEMBER',
    displayName: `${LOCAL_QC_LABEL}管理练习`,
    gameRegion: '猫小胖',
    gameServer: '紫水栈桥'
  }
] as const;
export type QcSlot = (typeof QC_ACTORS)[number]['slot'];
export type QcBindings = Record<QcSlot, string>;
export type QcTarget = 'family' | 'isolated';
type Tx = Prisma.TransactionClient;
export type PreparedQcAccount = { slot: QcSlot; phone: string; passwordHash: string };
function conflict(message: string): never {
  throw new AccountError('CONFLICT', message, 409);
}
function forbidden(message: string): never {
  throw new AccountError('FORBIDDEN', message, 403);
}

/** Runs before database imports/personal input in each CLI. No password/phone arguments or SSH. */
export function assertQcCliContext(input: {
  argv: readonly string[];
  stdinTTY: boolean;
  stdoutTTY: boolean;
  environment: Readonly<Record<string, string | undefined>>;
}): void {
  const e = input.environment;
  const smsFields = [
    'ARTZOO_SMS_ACCESS_KEY_ID',
    'ARTZOO_SMS_ACCESS_KEY_SECRET',
    'ARTZOO_SMS_SIGN_NAME',
    'ARTZOO_SMS_REGISTER_TEMPLATE_CODE',
    'ARTZOO_SMS_RESET_TEMPLATE_CODE'
  ];
  if (
    input.argv.length ||
    !input.stdinTTY ||
    !input.stdoutTTY ||
    e.SSH_CONNECTION ||
    e.SSH_CLIENT ||
    e.SSH_TTY ||
    e.ARTZOO_DEPLOYMENT_ENV !== 'local' ||
    e.ARTZOO_PUBLIC_ORIGIN !== 'http://localhost:3100' ||
    e.PGHOST !== 'postgres' ||
    e.PGPORT !== '5432' ||
    e.PGDATABASE !== 'artzoo_dev' ||
    e.PGUSER !== 'artzoo_dev' ||
    e.ARTZOO_SMS_PROVIDER !== 'unconfigured' ||
    smsFields.some((k) => Boolean(e[k])) ||
    e.ARTZOO_SMS_TEMPLATE_CODE !== undefined ||
    e.ARTZOO_OFFICIAL_SYNC_ENABLED !== '0'
  ) {
    forbidden('仅允许既定家庭本地交互终端，无参数／SSH，短信关闭且官方采集 OFF');
  }
}

export async function assertLocalQcTarget(tx: Tx | PrismaClient, target: QcTarget = 'family'): Promise<void> {
  if (
    target === 'isolated' &&
    (process.env.NODE_ENV !== 'test' || process.env.ARTZOO_QC_TOOLS_TEST !== 'isolated-approved')
  ) {
    forbidden('隔离验证门禁未满足');
  }
  if (target !== 'family' && target !== 'isolated') forbidden('未知目标');
  const [identity] = await tx.$queryRaw<
    { database: string; role: string }[]
  >`SELECT current_database() AS database,current_user AS role`;
  const expected =
    target === 'family' ? ['artzoo_dev', 'artzoo_dev'] : ['artzoo_local_qc_isolated', 'qc_tools_test'];
  if (identity?.database !== expected[0] || identity?.role !== expected[1])
    forbidden('目标数据库或用户不符，未执行');
  const rows = await tx.$queryRaw<
    { name: string; checksum: string; finished: boolean; rolledBack: boolean }[]
  >`
    SELECT migration_name AS name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS "rolledBack"
    FROM "_prisma_migrations" ORDER BY migration_name`;
  const source = await readFile(
    new URL(`../../../../packages/db/prisma/migrations/${LOCAL_QC_MIGRATION}/migration.sql`, import.meta.url)
  );
  const last = rows.at(-1);
  if (
    rows.length !== 33 ||
    rows.some((r) => !r.finished || r.rolledBack) ||
    last?.name !== LOCAL_QC_MIGRATION ||
    last.checksum !== createHash('sha256').update(source).digest('hex')
  )
    forbidden('需先由主任务安装核对后的第33迁移；工具不会自行迁移');
  if (target === 'family' && !(await tx.account.count({ where: { adminRole: 'SUPER_ADMIN' } })))
    forbidden('原有超级管理员缺失，停止');
}

const actorSelect = {
  id: true,
  localQcNamespace: true,
  localQcSlot: true,
  displayName: true,
  gameRegion: true,
  gameServer: true,
  membership: true,
  adminRole: true
} as const;
export async function readQcBindings(
  tx: Tx | PrismaClient,
  requireAdmin = false
): Promise<QcBindings | null> {
  const rows = await tx.account.findMany({
    where: { localQcNamespace: LOCAL_QC_NAMESPACE },
    select: actorSelect
  });
  if (!rows.length) return null;
  if (rows.length !== QC_ACTORS.length) conflict('本批账号不完整，保留现状，不补建或重置');
  const result = {} as QcBindings;
  for (const actor of QC_ACTORS) {
    const row = rows.find((r) => r.localQcSlot === actor.slot);
    if (
      !row ||
      row.displayName !== actor.displayName ||
      row.gameRegion !== actor.gameRegion ||
      row.gameServer !== actor.gameServer ||
      row.membership !== actor.membership ||
      row.adminRole === 'SUPER_ADMIN' ||
      (actor.slot !== 'admin' && row.adminRole !== 'NONE') ||
      (actor.slot === 'admin' &&
        (requireAdmin ? row.adminRole !== 'ADMIN' : !['NONE', 'ADMIN'].includes(row.adminRole)))
    ) {
      conflict(
        requireAdmin ? '演示身份已变化，或普通管理员尚未由用户超管授权' : '演示账号已被修改，不覆盖用户改动'
      );
    }
    if (!(await lotteryAccountActive(tx, row.id))) conflict('演示账号已停用，不恢复或重建');
    result[actor.slot] = row.id;
  }
  return result;
}

/** Shared order matches all existing Lottery writers; fresh checks and mutations share this tx. */
export async function assertQcTransaction(
  tx: Tx,
  options: { target?: QcTarget; bindings?: QcBindings; requireAdmin?: boolean } = {}
): Promise<void> {
  await lock(tx, 'lottery:write');
  await lock(tx, `local-qc:${LOCAL_QC_NAMESPACE}`);
  await assertLocalQcTarget(tx, options.target ?? 'family');
  const [risk] = await tx.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "Lottery" WHERE state='OPEN' AND (mode='AUTO' OR kind='MONTHLY')`;
  if (risk?.count)
    conflict('存在未结束的自动／月度抽奖，新账号或签到可能影响既有资格；停止，未改抽奖或 worker');
  if (options.bindings) {
    const requestedIds = QC_ACTORS.map((a) => options.bindings![a.slot]).sort();
    for (const id of requestedIds)
      await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id"=${id} FOR NO KEY UPDATE`;
    const current = await readQcBindings(tx, options.requireAdmin ?? false);
    if (!current || QC_ACTORS.some((a) => current[a.slot] !== options.bindings![a.slot]))
      conflict('绑定账号已变化');
    const ids = QC_ACTORS.map((a) => current[a.slot]);
    const existingEntries = await tx.lotteryEntry.count({ where: { accountId: { in: ids } } });
    // Baseline imports intentionally contain no lottery entries at all, even on re-run.
    if (existingEntries) conflict('演示账号已有抽奖参与记录，保留用户操作并停止');
  }
}

export async function preflightQcAccounts(db: PrismaClient, target: QcTarget = 'family') {
  return db.$transaction(
    async (tx) => {
      await assertQcTransaction(tx, { target });
      return { bindings: await readQcBindings(tx), target, namespace: LOCAL_QC_NAMESPACE };
    },
    { maxWait: 5000, timeout: 15000, isolationLevel: 'ReadCommitted' }
  );
}

/** Only the user-facing TTY caller computes real hashes; no account gets ADMIN here. */
export async function provisionLocalQcAccounts(
  db: PrismaClient,
  inputs: readonly PreparedQcAccount[],
  options: { target?: QcTarget; confirmation: string }
) {
  const target = options.target ?? 'family';
  if (options.confirmation !== 'CREATE_FOUR_LOCAL_QC_ACCOUNTS') forbidden('未明确确认四个本地演示账号');
  if (inputs.length !== 4 || new Set(inputs.map((i) => i.slot)).size !== 4) conflict('需四个不同身份槽位');
  for (const actor of QC_ACTORS) {
    const input = inputs.find((i) => i.slot === actor.slot);
    if (!input || !/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(input.passwordHash))
      conflict('本机密码准备未完成');
    if (target === 'family') {
      if (mainlandChinaPhone.normalize(input.phone) !== input.phone) conflict('手机号必须经既有规则规范化');
    } else if (input.phone !== `qc-isolated:${actor.slot}`)
      conflict('隔离验证只用不可登录标识，不生成可路由演示号码');
  }
  if (new Set(inputs.map((i) => i.phone)).size !== 4) conflict('四个账号需不同的受控手机号');
  try {
    return await db.$transaction(
      async (tx) => {
        await assertQcTransaction(tx, { target });
        const previous = await readQcBindings(tx);
        if (previous) return { created: false, bindings: previous, administratorGrantRequired: true };
        for (const input of [...inputs].sort((a, b) => a.phone.localeCompare(b.phone)))
          await lock(tx, `phone:${input.phone}`);
        for (const actor of QC_ACTORS) {
          const input = inputs.find((i) => i.slot === actor.slot)!;
          await lock(
            tx,
            `game-name:${createHash('sha256')
              .update(JSON.stringify([actor.gameServer, actor.displayName]))
              .digest('hex')}`
          );
          if (await tx.account.findUnique({ where: { phone: input.phone }, select: { id: true } }))
            conflict('手机号已有账号；不认领、改身份或重设密码');
          if (
            await tx.account.findFirst({
              where: { gameServer: actor.gameServer, displayName: actor.displayName },
              select: { id: true }
            })
          )
            conflict('演示昵称已存在；不覆盖既有账号');
          const [pending] = await tx.$queryRaw<{ blocked: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM "VerificationCode" WHERE phone=${input.phone} AND "invalidatedAt" IS NULL
            AND (("deliveredAt" IS NULL) OR ("consumedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP))) AS blocked`;
          if (pending?.blocked) conflict('该号码有未完成或有效验证码流程；等待结束后重试，不取消既有流程');
        }
        const bindings = {} as QcBindings;
        for (const actor of QC_ACTORS) {
          const input = inputs.find((i) => i.slot === actor.slot)!;
          const account = await tx.account.create({
            data: {
              phone: input.phone,
              passwordHash: input.passwordHash,
              displayName: actor.displayName,
              gameRegion: actor.gameRegion,
              gameServer: actor.gameServer,
              membership: actor.membership,
              adminRole: 'NONE',
              activityPoints: 0,
              activityDecayAt: null,
              localQcNamespace: LOCAL_QC_NAMESPACE,
              localQcSlot: actor.slot,
              profile: { create: { bio: `${LOCAL_QC_LABEL} 仅为本机人工验证使用，无真实人物或角色信息。` } }
            },
            select: { id: true }
          });
          bindings[actor.slot] = account.id;
          await tx.accountAudit.create({
            data: {
              action: 'LOCAL_QC_ACCOUNT_PROVISIONED',
              actorId: account.id,
              targetAccountId: account.id,
              reason: `${LOCAL_QC_LABEL} 用户本人在受控本地终端置备；无短信、无会话、无管理授权`
            }
          });
        }
        return { created: true, bindings, administratorGrantRequired: true };
      },
      { maxWait: 5000, timeout: 20000, isolationLevel: 'ReadCommitted' }
    );
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')
      conflict('并发或唯一性冲突，保留既有账号，不重置');
    throw error;
  }
}
