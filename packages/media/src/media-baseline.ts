import { constants } from 'node:fs';
import { access, lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  initializeMediaBudgetBaseline,
  lockEmptyMediaBaselineTarget,
  assertEmptyMediaBaselineTarget,
  type PrismaClient
} from '@artzoo/db';
import { boundHash, trustedMediaDirectoryIdentity } from './stock-bound-io.js';

type Roots = readonly [string, string, string];

/** Only the reviewed Compose layout is supported. Never silently omit a redirected media directory. */
export function deploymentMediaBaselineRoots(env: NodeJS.ProcessEnv): Roots {
  if (env.NODE_ENV !== 'production' || env.ARTZOO_AVATAR_DIR !== '/app/storage/avatars')
    throw Error('MEDIA_BASELINE_STORAGE_CONFIG');
  for (const key of Object.keys(env)) {
    if (/^ARTZOO_.*_(ORIGINAL|DERIVED)_DIR$/.test(key) && env[key] !== undefined)
      throw Error('MEDIA_BASELINE_STORAGE_CONFIG');
  }
  return ['/app/storage/original', '/app/storage/derived', '/app/storage/avatars'];
}

async function rootFingerprint(roots: Roots) {
  if (new Set(roots).size !== 3) throw Error('MEDIA_BASELINE_STORAGE_CONFIG');
  const identities = [];
  for (const root of roots) {
    identities.push([root, await trustedMediaDirectoryIdentity(root)]);
    await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
  }
  return boundHash(['empty-media-baseline-v1', identities]);
}

/** Bounded scan: empty directories are allowed, every other entry (including hidden files) is refused. */
async function emptySnapshot(roots: Roots) {
  const snapshot: string[][] = [];
  async function visit(path: string, depth: number) {
    if (depth > 16 || snapshot.length >= 256) throw Error('MEDIA_BASELINE_SCAN_LIMIT');
    const identity = await trustedMediaDirectoryIdentity(path);
    await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
    const before = await lstat(path, { bigint: true });
    snapshot.push([path, ...identity, before.mtimeNs.toString(), before.ctimeNs.toString()]);
    const dir = await opendir(path);
    for await (const entry of dir) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error('MEDIA_BASELINE_STORAGE_NOT_EMPTY');
      await visit(join(path, entry.name), depth + 1);
    }
    const after = await lstat(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw Error('MEDIA_BASELINE_STORAGE_CHANGED');
  }
  for (const root of roots) await visit(root, 0);
  return boundHash(snapshot.sort((a, b) => a[0]!.localeCompare(b[0]!)));
}

/** Offline maintenance: stop ALL media writers first. SQL locks cannot stop arbitrary filesystem writers. */
export async function initializeEmptyMediaBaseline(
  db: PrismaClient,
  input: { database: string; roots: Roots }
): Promise<'initialized' | 'already-initialized'> {
  return db.$transaction(
    async (tx) => {
      const state = await lockEmptyMediaBaselineTarget(tx, input.database);
      const fingerprint = await rootFingerprint(input.roots);
      if (state?.baselineInitializedAt) {
        if (state.baselineBytes !== 0n || state.baselineFingerprint !== fingerprint)
          throw Error('MEDIA_BUDGET_BASELINE_ALREADY_SET');
        // Do not scan newly uploaded files or alter any usage/receipt on an idempotent rerun.
        return 'already-initialized';
      }
      if (
        state &&
        (state.baselineBytes !== 0n ||
          state.baselineFingerprint !== null ||
          state.committedBytes !== 0n ||
          state.reservedBytes !== 0n ||
          state.creditedBytes !== 0n)
      )
        throw Error('MEDIA_BASELINE_STATE_NOT_EMPTY');
      await assertEmptyMediaBaselineTarget(tx);
      const snapshot = await emptySnapshot(input.roots);
      await initializeMediaBudgetBaseline(tx, { bytes: 0n, fingerprint, now: new Date() });
      if (
        (await emptySnapshot(input.roots)) !== snapshot ||
        (await rootFingerprint(input.roots)) !== fingerprint
      )
        throw Error('MEDIA_BASELINE_STORAGE_CHANGED');
      return 'initialized';
    },
    { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 30000 }
  );
}
