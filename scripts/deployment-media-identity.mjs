// Input is a read-only database snapshot, never credentials. Mounted at /app/scripts/.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  BoundNamespace,
  boundHash,
  trustedMediaDirectoryIdentity
} from '../packages/media/dist/stock-bound-io.js';

const roots = ['original', 'derived', 'avatars'];
const folders = {
  daily: 'daily',
  wish: 'wishes',
  'lottery-image': 'lotteries',
  knowledge: 'knowledge',
  'album-comment': 'albums',
  'album-photo': 'albums',
  'official-image': 'official-events'
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const counts = () => ({ consistent: 0, inconsistent: 0, unchecked: 0 });

export function locateComponent(row) {
  const kind = row.namespace === 'official-image' ? 'official' : row.namespace;
  const keys = row.objectKey?.split(':') ?? [];
  if (kind === 'lottery-image') {
    if (keys.length !== 3 || keys[0] !== 'lottery' || !uuid.test(keys[1])) return null;
  } else if (keys.length !== 2 || keys[0] !== kind) return null;
  const id = keys.at(-1);
  if (!uuid.test(id ?? '')) return null;
  let directory;
  if (kind === 'avatar' && ['avatar-full', 'avatar-small'].includes(row.part)) directory = 'avatars';
  else if (kind === 'knowledge' && row.part === 'knowledge-journal') directory = 'original/knowledge';
  else if (folders[row.namespace]) {
    const prefix = kind === 'official' ? 'official-' : 'photo-';
    const variant = row.part?.startsWith(prefix) ? row.part.slice(prefix.length) : '';
    if (!['original', 'preview', 'thumbnail'].includes(variant)) return null;
    directory = `${variant === 'original' ? 'original' : 'derived'}/${folders[row.namespace]}`;
  }
  return directory ? { kind, id, directory } : null;
}

export async function inspectSnapshot(lines) {
  const report = {
    baseline: counts(),
    components: counts(),
    directories: {},
    skippedCredited: 0,
    skippedDatabase: 0,
    skippedAggregate: 0
  };
  let baselineSeen = false,
    ended = false;
  for await (const line of lines) {
    if (ended) throw Error('INVALID_SNAPSHOT');
    const row = JSON.parse(line);
    if (row.type === 'end') {
      ended = true;
      continue;
    }
    if (row.type === 'baseline') {
      if (baselineSeen) throw Error('INVALID_SNAPSHOT');
      baselineSeen = true;
      let outcome = 'unchecked';
      if (digest(row.fingerprint)) {
        try {
          const identities = [];
          for (const name of roots) {
            const path = `/app/storage/${name}`;
            identities.push([path, await trustedMediaDirectoryIdentity(path)]);
          }
          outcome =
            boundHash(['empty-media-baseline-v1', identities]) === row.fingerprint
              ? 'consistent'
              : 'inconsistent';
        } catch {
          /* Unreadable/untrusted roots are not a successful comparison. */
        }
      }
      report.baseline[outcome]++;
      continue;
    }
    if (row.type !== 'component' || !baselineSeen) throw Error('INVALID_SNAPSHOT');
    if (row.credited === true) {
      report.skippedCredited++;
      continue;
    }
    if (row.namespace === 'baseline' && row.part === 'aggregate') {
      report.skippedAggregate++;
      continue;
    }
    if (['quick-icon-manual', 'quick-icon-auto'].includes(row.namespace) && row.part === 'quick-icon-bytea') {
      report.skippedDatabase++;
      continue;
    }
    const target = locateComponent(row),
      directory = target?.directory ?? 'unknown';
    report.directories[directory] ??= counts();
    let outcome = 'unchecked';
    if (
      target &&
      digest(row.storageIdentityFingerprint) &&
      digest(row.contentBindingSha256) &&
      typeof row.generation === 'string'
    ) {
      const namespace = new BoundNamespace(`/app/storage/${directory}`, target.kind);
      let ticket;
      try {
        ticket = await namespace.inspect(
          target.id,
          row.part,
          row.contentBindingSha256,
          BigInt(row.chargedBytes)
        );
        outcome =
          boundHash([row.generation, namespace.describe(ticket).physicalFingerprint]) ===
          row.storageIdentityFingerprint
            ? 'consistent'
            : 'inconsistent';
      } catch {
        /* Missing, untrusted or changed content is reported without raw errors. */
      } finally {
        if (ticket) await namespace.close(ticket);
      }
    }
    report.components[outcome]++;
    report.directories[directory][outcome]++;
  }
  if (!baselineSeen || !ended) throw Error('INCOMPLETE_SNAPSHOT');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw Error('ARGUMENTS');
    const report = await inspectSnapshot(createInterface({ input: process.stdin, crlfDelay: Infinity }));
    console.log(JSON.stringify(report));
    process.exitCode =
      report.baseline.inconsistent +
      report.components.inconsistent +
      report.baseline.unchecked +
      report.components.unchecked
        ? 2
        : 0;
  } catch {
    console.error(
      'Media identity check incomplete; no database or media was changed. Raw diagnostics withheld.'
    );
    process.exitCode = 1;
  }
}
