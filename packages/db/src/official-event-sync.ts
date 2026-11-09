import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from './generated/prisma/client.js';
import { AccountError, BEIJING_OFFSET_MS, type OfficialSyncRunView } from '@artzoo/domain';
import { collectOfficialEventInputs } from './official-event-source.js';
import { ingestOfficialEventTx } from './official-event-ingestion.js';
import type { OfficialImagePorts, OfficialPreparedImage } from './official-event-images.js';
import type { OfficialEventSourceInput } from './official-event-source.js';
import { prepareOfficialUnusedBatchTx } from './official-media-retirement.js';
import type { OfficialLiveCandidate } from './official-media-contract.js';
type Tx = Prisma.TransactionClient;
type Run = {
  id: string;
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
  imported: number;
  unchanged: number;
  errors: unknown;
};
export function officialSyncRunView(run: Run): OfficialSyncRunView {
  return {
    id: run.id,
    status: run.status as OfficialSyncRunView['status'],
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    imported: run.imported,
    unchanged: run.unchanged,
    errors: Array.isArray(run.errors)
      ? run.errors.filter((item): item is string => typeof item === 'string')
      : []
  };
}
interface Options {
  imagePorts?: OfficialImagePorts;
  actorId?: string;
  idempotencyKey?: string;
  now?: () => Date;
  intervalHours?: number;
  collector?: typeof collectOfficialEventInputs;
  beforeWrite?: (tx: Tx) => Promise<void>;
  finalCheck?: (tx: Tx) => Promise<void>;
}
async function lock(tx: Tx) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('official-event-sync',0))::text`;
}
const LEASE = 120_000;
export function officialSyncSettings(env: Record<string, string | undefined> = process.env) {
  const raw = env.ARTZOO_OFFICIAL_SYNC_INTERVAL_HOURS ?? '24',
    intervalHours = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(intervalHours) || intervalHours !== 24)
    throw new Error('Official sync interval is invalid');
  // Default off; enable only for an explicitly authorized environment.
  const enabled = env.ARTZOO_OFFICIAL_SYNC_ENABLED ?? '0';
  if (!['0', '1'].includes(enabled)) throw new Error('Official sync switch is invalid');
  return { enabled: enabled === '1', intervalHours };
}
export async function runOfficialEventSync(db: PrismaClient, options: Options = {}) {
  const now = options.now ?? (() => new Date()),
    manual = Boolean(options.actorId),
    intervalHours = options.intervalHours ?? 24;
  if (!Number.isSafeInteger(intervalHours) || intervalHours !== 24)
    throw new Error('Official sync interval is invalid');
  if (manual && !options.idempotencyKey) throw new Error('Official manual sync requires a command key');
  const claimed = await db.$transaction(
    async (tx) => {
      await options.beforeWrite?.(tx);
      await lock(tx);
      await options.finalCheck?.(tx);
      const at = now(),
        since = new Date(at.getTime() - LEASE);
      await tx.$executeRaw`UPDATE "OfficialSyncRun" SET status='FAILED',errors='["同步超时，请稍后重试"]'::jsonb,"finishedAt"=${at} WHERE status='RUNNING' AND "createdAt"<=${since}`;
      if (manual) {
        const [previous] = await tx.$queryRaw<
          Run[]
        >`SELECT * FROM "OfficialSyncRun" WHERE "actorId"=${options.actorId!} AND "idempotencyKey"=${options.idempotencyKey!}`;
        if (previous) {
          await options.finalCheck?.(tx);
          return { run: previous, replayed: true, claimed: false };
        }
      }
      const [running] = await tx.$queryRaw<
        Run[]
      >`SELECT * FROM "OfficialSyncRun" WHERE status='RUNNING' ORDER BY "createdAt" DESC,id DESC LIMIT 1`;
      if (running) {
        await options.finalCheck?.(tx);
        if (manual) throw new AccountError('CONFLICT', '已有同步正在进行，请稍后刷新', 409);
        return { run: running, replayed: false, claimed: false };
      }
      if (!manual) {
        const threshold = officialSyncDailyBoundary(at);
        const [recent] = await tx.$queryRaw<
          Run[]
        >`SELECT * FROM "OfficialSyncRun" WHERE "createdAt">=${threshold} ORDER BY "createdAt" DESC,id DESC LIMIT 1`;
        if (recent) return { run: recent, replayed: false, claimed: false };
      }
      const id = randomUUID();
      await tx.$executeRaw`INSERT INTO "OfficialSyncRun" (id,trigger,"actorId","idempotencyKey",status,"createdAt") VALUES (${id},${manual ? 'MANUAL' : 'DAILY'},${options.actorId ?? null},${options.idempotencyKey ?? null},'RUNNING',${at})`;
      const [run] = await tx.$queryRaw<Run[]>`SELECT * FROM "OfficialSyncRun" WHERE id=${id}`;
      await options.finalCheck?.(tx);
      return { run: run!, replayed: false, claimed: true };
    },
    { maxWait: 5000, timeout: 15000 }
  );
  if (!claimed.claimed)
    return { run: officialSyncRunView(claimed.run), replayed: claimed.replayed, processed: false };
  try {
    const collected = await (options.collector ?? collectOfficialEventInputs)({ now: now() });
    const staged = await stageOfficialImages(collected.inputs, options.imagePorts, collected.errors);
    const used = new Set<string>();
    const result = await db.$transaction(
      async (tx) => {
        await options.beforeWrite?.(tx);
        await lock(tx);
        await options.finalCheck?.(tx);
        const [current] = await tx.$queryRaw<
          Run[]
        >`SELECT * FROM "OfficialSyncRun" WHERE id=${claimed.run.id} FOR UPDATE`;
        if (
          !current ||
          current.status !== 'RUNNING' ||
          now().getTime() - current.createdAt.getTime() >= LEASE
        )
          throw new Error('Official sync lease expired');
        let imported = 0,
          unchanged = 0;
        const errors = [...collected.errors].slice(0, 30);
        for (const input of collected.inputs) {
          const result = await ingestOfficialEventTx(tx, input, now(), staged.get(input));
          if (result.imageId) used.add(result.imageId);
          if (result.replayed && (!result.changedSource || !input.calendar)) unchanged++;
          else imported++;
          if (result.changedSource && !input.calendar) errors.push('旧采集原文已变化，已保留原记录');
        }
        const status = errors.length ? (collected.inputs.length ? 'PARTIAL' : 'FAILED') : 'COMPLETED';
        await tx.$executeRaw`UPDATE "OfficialSyncRun" SET status=${status},imported=${imported},unchanged=${unchanged},errors=${JSON.stringify(errors.slice(0, 30))}::jsonb,"finishedAt"=${now()} WHERE id=${claimed.run.id}`;
        const [run] = await tx.$queryRaw<Run[]>`SELECT * FROM "OfficialSyncRun" WHERE id=${claimed.run.id}`;
        const batch = await prepareOfficialUnusedBatchTx(tx, unusedStockCandidates(staged, used), now());
        await options.finalCheck?.(tx);
        return { result: { run: officialSyncRunView(run!), replayed: false, processed: true }, batch };
      },
      { maxWait: 5000, timeout: 15000 }
    );
    // The batch is private and executable only after the owning transaction ACK.
    if (result.batch) await options.imagePorts?.discardUnused?.(result.batch).catch(() => undefined);
    for (const image of staged.values())
      if (!('stockCandidate' in image) && !used.has(image.id))
        await options.imagePorts!.discard(image.id).catch(() => undefined);
    return result.result;
  } catch (error) {
    await db.$transaction(async (tx) => {
      await lock(tx);
      await tx.$executeRaw`UPDATE "OfficialSyncRun" SET status='FAILED',errors='["同步未完成，请稍后重试"]'::jsonb,"finishedAt"=${now()} WHERE id=${claimed.run.id} AND status='RUNNING'`;
    });
    throw error;
  }
}
export function officialSyncDailyBoundary(at: Date): Date {
  if (!Number.isFinite(at.getTime())) throw new Error('Invalid official sync time');
  const local = new Date(at.getTime() + BEIJING_OFFSET_MS);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - BEIJING_OFFSET_MS
  );
}
export function officialSyncDailyReady(at: Date): boolean {
  return at.getTime() - officialSyncDailyBoundary(at).getTime() >= 4 * 3_600_000;
}
export async function processOfficialEventSync(
  db: PrismaClient,
  env: Record<string, string | undefined> = process.env,
  imagePorts?: OfficialImagePorts
) {
  const settings = officialSyncSettings(env);
  if (!settings.enabled) return { enabled: false, processed: false };
  if (!officialSyncDailyReady(new Date())) return { enabled: true, processed: false };
  const result = await runOfficialEventSync(db, { intervalHours: settings.intervalHours, imagePorts });
  return {
    enabled: true,
    processed: result.processed,
    status: result.run.status,
    imported: result.run.imported,
    unchanged: result.run.unchanged
  };
}

async function stageOfficialImages(
  inputs: OfficialEventSourceInput[],
  ports: OfficialImagePorts | undefined,
  errors: string[]
) {
  const staged = new Map<OfficialEventSourceInput, OfficialPreparedImage>(),
    deadline = Date.now() + 55_000;
  for (const input of inputs) {
    if (!input.image) {
      if (input.imageMissingReason) errors.push(`${input.sourceTitle}：${input.imageMissingReason}`);
      continue;
    }
    // 8s download + two 5s encodes + bounded metadata/local IO, leaving SQL lease headroom.
    if (Date.now() + 24_000 > deadline) {
      errors.push(`${input.sourceTitle}：本轮图片时间预算不足，已保留原图`);
      continue;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!ports) throw new Error('Official image storage unavailable');
      const image = await Promise.race([
        ports.stage(input.image, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Official image stage timed out'));
          }, 24_000);
        })
      ]);
      staged.set(input, image);
    } catch {
      errors.push(`${input.sourceTitle}：官方图片获取失败，已保留原图`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return staged;
}
/** Explicit one-time enrichment for the already imported published calendar records.
 * Does not alter the daily scheduler or create/impersonate an administrator. No notifications.
 */
export async function enrichOfficialEventImages(
  db: PrismaClient,
  imagePorts: OfficialImagePorts,
  options: { collector?: typeof collectOfficialEventInputs; now?: () => Date } = {}
) {
  const now = options.now ?? (() => new Date());
  const collected = await (options.collector ?? collectOfficialEventInputs)({ now: now() });
  const rows = await db.$queryRaw<
    { id: string; sourceKey: string; externalId: string; imageId: string | null; manualFields: unknown }[]
  >`SELECT id,"sourceKey","externalId","imageId","manualFields" FROM "OfficialEvent" WHERE status='PUBLISHED' AND "externalId" LIKE 'calendar:%'`;
  const allowed = new Set(
    rows
      .filter((r) => !r.imageId && Array.isArray(r.manualFields) && !r.manualFields.includes('image'))
      .map((r) => JSON.stringify([r.sourceKey, r.externalId]))
  );
  const inputs = collected.inputs.filter(
    (input) => input.calendar && allowed.has(JSON.stringify([input.sourceKey, input.externalId]))
  );
  const errors = [...collected.errors],
    staged = await stageOfficialImages(inputs, imagePorts, errors),
    used = new Set<string>();
  const results = await db.$transaction(
    async (tx) => {
      await lock(tx);
      const results: { externalId: string; eventId: string; imageId: string | null; status: string }[] = [];
      for (const input of inputs) {
        const [row] = await tx.$queryRaw<
          { id: string; imageId: string | null; manualFields: unknown; status: string }[]
        >`SELECT id,"imageId","manualFields",status FROM "OfficialEvent" WHERE "sourceKey"=${input.sourceKey} AND "externalId"=${input.externalId} FOR UPDATE`;
        if (
          !row ||
          row.status !== 'PUBLISHED' ||
          row.imageId ||
          !Array.isArray(row.manualFields) ||
          row.manualFields.includes('image')
        )
          continue;
        const result = await ingestOfficialEventTx(tx, input, now(), staged.get(input));
        if (result.imageId) used.add(result.imageId);
        results.push({
          externalId: input.externalId,
          eventId: result.eventId,
          imageId: result.imageId ?? null,
          status: result.imageId ? 'HAS_IMAGE' : 'NO_IMAGE'
        });
      }
      const batch = await prepareOfficialUnusedBatchTx(tx, unusedStockCandidates(staged, used), now());
      return { results, batch };
    },
    { maxWait: 5000, timeout: 15000 }
  );
  // A thrown/unknown commit deliberately retains staged files; never infer rollback from SELECT absence.
  if (results.batch) await imagePorts.discardUnused?.(results.batch).catch(() => undefined);
  for (const image of staged.values())
    if (!('stockCandidate' in image) && !used.has(image.id))
      await imagePorts.discard(image.id).catch(() => undefined);
  return { results: results.results, errors };
}

/** Used IDs are only a filter; the DB helper proves all references and complete bound stock. */
function unusedStockCandidates(
  staged: ReadonlyMap<OfficialEventSourceInput, OfficialPreparedImage>,
  used: ReadonlySet<string>
): OfficialLiveCandidate[] {
  return [
    ...new Set(
      [...staged.values()]
        .filter((image) => !used.has(image.id) && 'stockCandidate' in image)
        .map((image) => image.stockCandidate!)
    )
  ];
}
