import { lockMediaReregistration, readMediaReregistrationPage, type PrismaClient } from '@artzoo/db';
import {
  BoundNamespace,
  boundHash,
  trustedMediaDirectoryIdentity,
  type BoundDescription
} from './stock-bound-io.js';
import { locateComponent } from './stock-location.js';

type Row = Awaited<ReturnType<typeof readMediaReregistrationPage>>[number];
type Roots = readonly [string, string, string];
const digest = (value: string | null): value is string => !!value && /^[a-f0-9]{64}$/.test(value);
function fail(code: string): never {
  throw Error('MEDIA_REGISTER_' + code);
}
const policies: Record<string, string[]> = {
  AVATAR_VARIANT: ['avatar-full', 'avatar-small'],
  PHOTO_VARIANT: ['photo-original', 'photo-preview', 'photo-thumbnail'],
  OFFICIAL_VARIANT: ['official-original', 'official-preview', 'official-thumbnail'],
  KNOWLEDGE_JOURNAL: ['knowledge-journal'],
  QUICK_LINK_BYTEA: ['quick-icon-bytea']
};
function validate(row: Row) {
  const r = row.receipt;
  if (
    !r ||
    r.state !== 'COMMITTED' ||
    !r.persistenceStartedAt ||
    !r.settledAt ||
    row.namespace !== r.scope ||
    row.objectKey !== r.objectIdentity ||
    row.generation !== r.attemptId ||
    row.id !== boundHash(['media-component-v1', r.scope, r.objectIdentity, r.attemptId, row.part]) ||
    r.components.reduce((n, c) => n + c.chargedBytes, 0n) !== r.storedBytes ||
    !digest(row.contentBindingSha256)
  )
    fail('RECEIPT');
  const expected =
    row.namespace === 'knowledge'
      ? [...policies.PHOTO_VARIANT!, 'knowledge-journal']
      : row.namespace === 'avatar'
        ? policies.AVATAR_VARIANT!
        : row.namespace === 'official-image'
          ? policies.OFFICIAL_VARIANT!
          : row.policy === 'QUICK_LINK_BYTEA'
            ? policies.QUICK_LINK_BYTEA!
            : policies.PHOTO_VARIANT!;
  if (
    !Object.hasOwn(policies, row.policy) ||
    !policies[row.policy]!.includes(row.part) ||
    r.components.length !== expected.length ||
    expected.some((part) => r.components.filter((c) => c.part === part).length !== 1)
  )
    fail('PARTS');
  const i = row.retirement,
    c = row.credit;
  const bytea = row.policy === 'QUICK_LINK_BYTEA';
  if (
    bytea &&
    (!['quick-icon-manual', 'quick-icon-auto'].includes(row.namespace) ||
      row.storageIdentityFingerprint !== null)
  )
    fail('COMPONENT');
  if (!i && !c) return 'current';
  const keys = row.objectKey.split(':');
  const identity = bytea
    ? boundHash([
        'quick-icon-bytea-v1',
        keys[1],
        row.contentBindingSha256,
        Number(row.chargedBytes),
        row.generation
      ])
    : row.storageIdentityFingerprint;
  const intentId = bytea
    ? boundHash(['quick-icon-retirement-v1', row.id, row.generation])
    : i && boundHash(['media-retirement-v1', row.id, i.identityFingerprint, i.authorityFingerprint]);
  if (
    !i ||
    !c ||
    i.state !== 'ACKNOWLEDGED' ||
    !i.acknowledgedAt ||
    i.identityFingerprint !== identity ||
    c.intentId !== i.id ||
    c.bytes !== row.chargedBytes ||
    c.createdAt.getTime() !== i.acknowledgedAt.getTime() ||
    i.id !== intentId
  )
    fail('RETIREMENT');
  const prefix =
    row.namespace === 'album-photo'
      ? 'album-photo-durable-removal-v1'
      : ['daily', 'wish', 'lottery-image', 'knowledge', 'album-comment'].includes(row.namespace) &&
          row.part !== 'knowledge-journal'
        ? row.namespace + '-durable-unlink-v1'
        : 'durable-unlink-v1';
  const evidence = bytea
    ? boundHash(['atomic-bytea-replacement-v1', identity, i.authorityFingerprint])
    : boundHash([prefix, i.id, row.id, row.generation, row.storageIdentityFingerprint]);
  if (c.evidenceFingerprint !== evidence) fail('CREDIT');
  return 'credited';
}
async function baseline(roots: Roots) {
  if (new Set(roots).size !== 3) fail('ROOTS');
  const identities = [];
  for (const root of roots) identities.push([root, await trustedMediaDirectoryIdentity(root)]);
  return boundHash(['empty-media-baseline-v1', identities]);
}
async function inspect(row: Row, roots: Roots) {
  const target = locateComponent(row);
  if (!target || !digest(row.storageIdentityFingerprint)) fail('COMPONENT');
  const [base, ...tail] = target.directory.split('/');
  const index = ['original', 'derived', 'avatars'].indexOf(base!);
  const root = roots[index];
  if (!root) fail('ROOTS');
  const ns = new BoundNamespace([root, ...tail].join('/'), target.kind as BoundDescription['kind']);
  const ticket = await ns.inspect(
    target.id,
    row.part as BoundDescription['part'],
    row.contentBindingSha256!,
    row.chargedBytes
  );
  try {
    const d = ns.describe(ticket);
    if (!d) fail('PROOF');
    return boundHash([row.generation, d.physicalFingerprint]);
  } finally {
    await ns.close(ticket);
  }
}

/** No caller-supplied fingerprints, proof factory, IO callbacks, skip flags or partial commits. */
export async function reregisterMediaIdentity(db: PrismaClient, input: { database: string; roots: Roots }) {
  return db.$transaction(
    async (tx) => {
      // Disk work holds SQL locks: bound idle time too, rather than losing the transaction mid-scan.
      await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout = '240s'`;
      const { state, count } = await lockMediaReregistration(tx, input.database);
      const fingerprint = await baseline(input.roots);
      const verified = new Map<string, { old: string; next: string }>();
      const report = {
        checked: 0,
        updated: 0,
        credited: 0,
        database: 0,
        baselineChanged: state.baselineFingerprint !== fingerprint
      };
      let after = '',
        total = 0,
        bytes = 0n;
      while (true) {
        const rows = await readMediaReregistrationPage(tx, after);
        if (!rows.length) break;
        for (const row of rows) {
          if (++total > 10000) fail('LIMIT');
          const disposition = validate(row);
          if (disposition === 'credited') {
            report.credited++;
            continue;
          }
          if (row.policy === 'QUICK_LINK_BYTEA') {
            if (
              !['quick-icon-manual', 'quick-icon-auto'].includes(row.namespace) ||
              row.storageIdentityFingerprint !== null
            )
              fail('COMPONENT');
            report.database++;
            continue;
          }
          bytes += row.chargedBytes;
          if (bytes > 10000000000n) fail('LIMIT');
          const next = await inspect(row, input.roots);
          verified.set(row.id, { old: row.storageIdentityFingerprint!, next });
          report.checked++;
        }
        after = rows.at(-1)!.id;
      }
      if (total !== count) fail('SET_CHANGED');
      // Re-read every file before updating it. A late failure rolls back earlier SQL changes too.
      after = '';
      while (true) {
        const rows = await readMediaReregistrationPage(tx, after);
        if (!rows.length) break;
        for (const row of rows) {
          const proof = verified.get(row.id);
          if (!proof) continue;
          if ((await inspect(row, input.roots)) !== proof.next) fail('CHANGED');
          if (proof.old === proof.next) continue;
          const changed = await tx.mediaStoredComponent.updateMany({
            where: {
              id: row.id,
              storageIdentityFingerprint: proof.old,
              generation: row.generation,
              contentBindingSha256: row.contentBindingSha256
            },
            data: { storageIdentityFingerprint: proof.next }
          });
          if (changed.count !== 1) fail('SET_CHANGED');
          report.updated++;
        }
        after = rows.at(-1)!.id;
      }
      if ((await baseline(input.roots)) !== fingerprint || (await tx.mediaStoredComponent.count()) !== count)
        fail('CHANGED');
      const changed = await tx.mediaBudgetState.updateMany({
        where: { id: 'global', baselineFingerprint: state.baselineFingerprint },
        data: { baselineFingerprint: fingerprint }
      });
      if (changed.count !== 1) fail('SET_CHANGED');
      return report;
    },
    { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 240000 }
  );
}
