import dns from 'node:dns';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validOfficialEventImageUrl, validOfficialEventSourceUrl } from '@artzoo/db';
import type {
  OfficialImageSource,
  OfficialPreparedImage,
  OfficialUnusedBatch,
  MediaBudgetTransactionPort,
  PrismaClient,
  Prisma,
  MediaBoundAllocationTicket
} from '@artzoo/db';
import { mediaBudgetPolicy, type MediaBudgetPolicy } from '@artzoo/domain';
import { processPhoto, withPhotoSlot } from './photo-processor.js';
import { bindOfficialWrite, retireOfficialUnusedBatch, type MediaWriteProof } from './stock-retirement.js';
import { LocalPhotoStorage, type PhotoStorage } from './photo-storage.js';
import { createPhotoStorage } from './cos-routed-storage.js';
import { verifiedBoundWrite } from './stock-bound-io.js';

const MAX_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 8000;
const imageMimes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const kinds = new Set<OfficialImageSource['kind']>([
  'API',
  'NEWS',
  'TOPIC_METADATA',
  'TOPIC_SECTION',
  'MANUAL'
]);
const benchmarkV4 = new BlockList();
benchmarkV4.addSubnet('198.18.0.0', 15, 'ipv4');
const fakeIpAliases: Readonly<Record<string, string>> = {
  'fu5.web.sdo.com': 'fu5.web.sdo.com.wswebcdn.com',
  'static.web.sdo.com': 'static.web.sdo.com.wswebcdn.com'
};
const MAX_DNS_ANSWERS = 32;
const privateV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const)
  privateV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList(),
  specialV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3ffe::', 16],
  ['3fff::', 20],
  ['2620:4f:8000::', 48]
] as const)
  specialV6.addSubnet(address, prefix, 'ipv6');
function publicAddress(address: string, family: number) {
  if (isIP(address) !== family) return false;
  return family === 4
    ? !privateV4.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6');
}
function imageUrl(value: string) {
  if (!validOfficialEventImageUrl(value)) throw new Error('Untrusted official image URL');
  const url = new URL(value);
  // Reject parser normalization, encoded path and default-port spelling as well.
  if (
    value !== url.href ||
    /[%\\\u0000-\u0020\u007f]/.test(value) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error('Untrusted official image URL');
  return url;
}
export type OfficialImageDownload = (
  url: string,
  signal?: AbortSignal
) => Promise<{ bytes: Buffer; mime: string }>;
const download: OfficialImageDownload = (value, signal) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const url = imageUrl(value);
    let request: ClientRequest | undefined,
      response: IncomingMessage | undefined,
      settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      request?.destroy();
      reject(new Error(message));
    };
    // One wall-clock deadline covers DNS, connection/TLS, headers and every body byte.
    const onAbort = () => fail('Official image download aborted');
    const cleanup = () => {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
    };
    const deadline = setTimeout(() => fail('Official image download timed out'), DOWNLOAD_TIMEOUT);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    const connect = (addresses: dns.LookupAddress[]) => {
      if (settled) return;
      if (!addresses.length || addresses.some((item) => !publicAddress(item.address, item.family)))
        return fail('Official image address is not public');
      const selected = addresses.find((item) => item.family === 4) ?? addresses[0]!;
      const lookup: LookupFunction = (hostname, _options, callback) => {
        if (hostname !== url.hostname) return callback(new Error('Official image host changed'), '', 0);
        // Every connector form receives only this exact reviewed address.
        if (_options.all) callback(null, [{ address: selected.address, family: selected.family }]);
        else callback(null, selected.address, selected.family);
      };
      try {
        request = https.request(
          url,
          {
            method: 'GET',
            agent: false,
            family: selected.family,
            lookup,
            servername: url.hostname,
            rejectUnauthorized: true,
            headers: { Accept: 'image/jpeg, image/png, image/webp, image/gif', 'Accept-Encoding': 'identity' }
          },
          (incoming) => {
            if (settled) {
              incoming.destroy();
              return;
            }
            response = incoming;
            // No redirect following, cookies, referrer, compression or partial response.
            if (incoming.statusCode !== 200) return fail('Official image response was not successful');
            const contentType = incoming.headers['content-type'];
            const mime =
              typeof contentType === 'string' ? contentType.split(';', 1)[0]!.trim().toLowerCase() : '';
            const encoding = incoming.headers['content-encoding'];
            if (!imageMimes.has(mime) || (encoding !== undefined && encoding !== 'identity'))
              return fail('Official image response format is unsupported');
            const advertised = incoming.headers['content-length'];
            if (
              advertised !== undefined &&
              (typeof advertised !== 'string' ||
                !/^[1-9]\d*$/.test(advertised) ||
                !Number.isSafeInteger(Number(advertised)) ||
                Number(advertised) > MAX_BYTES)
            )
              return fail('Official image exceeds download limit');
            const chunks: Buffer[] = [];
            let size = 0;
            incoming.on('data', (chunk: Buffer) => {
              if (settled) return;
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += bytes.length;
              if (size > MAX_BYTES) {
                fail('Official image exceeds download limit');
                return;
              }
              chunks.push(bytes);
            });
            incoming.once('error', () => fail('Official image response was interrupted'));
            incoming.once('aborted', () => fail('Official image response was interrupted'));
            incoming.once('close', () => {
              if (!incoming.complete && !settled) fail('Official image response was interrupted');
            });
            incoming.once('end', () => {
              if (settled) return;
              if (!size || (advertised !== undefined && Number(advertised) !== size))
                return fail('Official image response was incomplete');
              settled = true;
              cleanup();
              resolve({ bytes: Buffer.concat(chunks, size), mime });
            });
          }
        );
        request.once('error', () => fail('Official image connection failed'));
        request.end();
      } catch {
        fail('Official image connection failed');
      }
    };
    const resolveFakeIpAlias = () => {
      const alias = fakeIpAliases[url.hostname];
      if (!alias || settled) return fail('Official image address is not public');
      // Use only the already configured resolver. A benchmark answer permits two exact queries,
      // never a connection to the benchmark IP or arbitrary CNAME traversal.
      try {
        dns.resolveAny(url.hostname, (error, records) => {
          if (settled) return;
          if (
            error ||
            !Array.isArray(records) ||
            records.length !== 1 ||
            records[0]?.type !== 'CNAME' ||
            records[0].value !== alias
          )
            return fail('Official image address is not public');
          try {
            dns.resolveAny(alias, (aliasError, aliasRecords) => {
              if (settled) return;
              if (
                aliasError ||
                !Array.isArray(aliasRecords) ||
                !aliasRecords.length ||
                aliasRecords.length > MAX_DNS_ANSWERS
              )
                return fail('Official image address is not public');
              const reviewed: dns.LookupAddress[] = [];
              for (const record of aliasRecords) {
                if (!record || (record.type !== 'A' && record.type !== 'AAAA'))
                  return fail('Official image address is not public');
                const family = record.type === 'A' ? 4 : 6;
                if (typeof record.address !== 'string' || !publicAddress(record.address, family))
                  return fail('Official image address is not public');
                reviewed.push({ address: record.address, family });
              }
              connect(reviewed);
            });
          } catch {
            fail('Official image address lookup failed');
          }
        });
      } catch {
        fail('Official image address lookup failed');
      }
    };
    try {
      dns.lookup(url.hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (settled) return;
        if (error || !addresses.length) return fail('Official image address is not public');
        if (
          addresses.every(
            (item) => item.family === 4 && isIP(item.address) === 4 && benchmarkV4.check(item.address, 'ipv4')
          )
        )
          return resolveFakeIpAlias();
        connect(addresses);
      });
    } catch {
      fail('Official image address lookup failed');
    }
  });

function defaultStorage() {
  const directory = resolve(
    /* turbopackIgnore: true */ dirname(fileURLToPath(import.meta.url)),
    '../../../.local/official-event-media'
  );
  const legacy =
    process.env.NODE_ENV === 'production'
      ? new LocalPhotoStorage('/app/storage/original/official-events', '/app/storage/derived/official-events')
      : new LocalPhotoStorage(join(directory, 'original'), join(directory, 'derived'));
  return createPhotoStorage({ scope: 'official', legacy });
}
export function createOfficialImagePorts(
  options: {
    storage?: PhotoStorage;
    download?: OfficialImageDownload;
    budget?: { db: MediaBudgetTransactionPort; policy: MediaBudgetPolicy; now?: () => Date };
  } = {}
) {
  const storage = options.storage ?? defaultStorage(),
    fetchImage = options.download ?? download,
    budget = options.budget;
  // Process-local recognition supplements the persistent locator check below.
  const remoteWrites = new Set<string>();
  return {
    storage,
    async stage(
      source: OfficialImageSource,
      options: { signal?: AbortSignal } = {}
    ): Promise<OfficialPreparedImage> {
      const { signal } = options;
      signal?.throwIfAborted();
      const url = imageUrl(source.url);
      if (!kinds.has(source.kind) || !validOfficialEventSourceUrl(source.pageUrl))
        throw new Error('Untrusted official image source');
      const downloaded = await fetchImage(url.href, signal);
      signal?.throwIfAborted();
      if (
        !Buffer.isBuffer(downloaded.bytes) ||
        !downloaded.bytes.length ||
        downloaded.bytes.length > MAX_BYTES
      )
        throw new Error('Official image exceeds download limit');
      const mime = downloaded.mime.split(';', 1)[0]!.trim().toLowerCase();
      if (!imageMimes.has(mime)) throw new Error('Official image response format is unsupported');
      const budgetEnabled = budget ? undefined : process.env.ARTZOO_MEDIA_BUDGET_ENABLED;
      const policy =
        budget?.policy ??
        (budgetEnabled === undefined || budgetEnabled === '0' ? null : mediaBudgetPolicy(process.env));
      if (policy?.enabled) {
        // System assets never consume a person's daily quota, including manual administrator syncs.
        const {
          createMediaBudgetAdapter,
          getDatabase,
          confirmOfficialCandidate,
          prepareOfficialUnusedBatchTx
        } = await import('@artzoo/db');
        const db: MediaBudgetTransactionPort = budget?.db ?? getDatabase(),
          now = budget?.now ?? (() => new Date()),
          id = randomUUID(),
          fingerprint = createHash('sha256').update(downloaded.bytes).digest('hex');
        const prepared = await createMediaBudgetAdapter(db, policy, now).prepare({
          scope: 'official-image',
          operationKey: randomUUID(),
          fingerprint,
          accountId: null,
          rawBytes: BigInt(downloaded.bytes.length),
          objectIdentity: 'official:' + id
        });
        if (prepared.kind !== 'owner') throw new Error('Official image budget is pending');
        const attempt = prepared.attempt;
        let beginAttempted = false;
        try {
          return await withPhotoSlot(async () => {
            signal?.throwIfAborted();
            const output = await processPhoto(downloaded.bytes, url.pathname.split('/').pop()!, {
              timeoutSeconds: 5
            });
            signal?.throwIfAborted();
            if (output.mime !== mime) throw new Error('Official image MIME does not match decoded data');
            if (!output.original.length || output.original.length > MAX_BYTES)
              throw new Error('Official sanitized original exceeds storage limit');
            const image: OfficialPreparedImage = {
              id,
              sourceUrl: url.href,
              sourcePageUrl: source.pageUrl,
              sourceKind: source.kind,
              fingerprint,
              mime: output.mime,
              width: output.width,
              height: output.height,
              frames: output.frames,
              originalBytes: output.original.length
            };
            // Missing optional capability preserves legacy aggregate accounting; a failing capability fails closed.
            const namespaces = storage.writeNamespaces
              ? await storage.writeNamespaces()
              : storage.boundNamespaces
                ? await storage.boundNamespaces()
                : null;
            let allocation: MediaBoundAllocationTicket | undefined;
            if (namespaces) {
              allocation = await attempt.allocateBoundComponents({
                kind: 'official',
                originalBytes: BigInt(output.original.length),
                previewBytes: BigInt(output.preview.length),
                thumbnailBytes: BigInt(output.thumbnail.length),
                contentHashes: {
                  original: createHash('sha256').update(output.original).digest('hex'),
                  preview: createHash('sha256').update(output.preview).digest('hex'),
                  thumbnail: createHash('sha256').update(output.thumbnail).digest('hex')
                }
              });
            } else {
              await attempt.allocate(
                BigInt(output.original.length) +
                  BigInt(output.preview.length) +
                  BigInt(output.thumbnail.length)
              );
            }
            signal?.throwIfAborted();
            // An ambiguous begin acknowledgement is already beyond the safe prewrite-release boundary.
            beginAttempted = true;
            await attempt.begin();
            signal?.throwIfAborted();
            await storage.put(id, output);
            // COMMITTED journals a persisted system asset, not event attachment/publication.
            // No event/business lock is taken while this independent short quota transaction runs.
            const proofs: MediaWriteProof[] | null = namespaces ? [] : null;
            if (namespaces && proofs)
              for (const variant of ['original', 'preview', 'thumbnail'] as const) {
                proofs.push(
                  await (variant === 'original' ? namespaces.original : namespaces.derived).capture(
                    id,
                    `official-${variant}`,
                    createHash('sha256').update(output[variant]).digest('hex'),
                    BigInt(output[variant].length)
                  )
                );
              }
            if (proofs?.some((proof) => !verifiedBoundWrite(proof))) remoteWrites.add(id);
            await db.$transaction(async (tx) => {
              await attempt.commit(tx);
              if (allocation && proofs)
                await bindOfficialWrite(tx as Prisma.TransactionClient, allocation, id, proofs);
            });
            const candidate = allocation
              ? await confirmOfficialCandidate(db as Pick<PrismaClient, '$transaction'>, allocation)
              : null;
            if (candidate)
              Object.defineProperty(image, 'stockCandidate', {
                value: candidate,
                enumerable: false,
                writable: false,
                configurable: false
              });
            if (signal?.aborted) {
              // Only this confirmed COMMITTED candidate has never escaped to a business owner.
              if (remoteWrites.has(id)) throw new Error('COS_DELETE_UNSUPPORTED');
              if (candidate && namespaces && storage.boundNamespaces) {
                const batch = await db.$transaction((tx) =>
                  prepareOfficialUnusedBatchTx(tx as Prisma.TransactionClient, [candidate], now())
                );
                if (batch)
                  await retireOfficialUnusedBatch(
                    db as Pick<PrismaClient, '$queryRaw' | '$transaction'>,
                    await storage.boundNamespaces(),
                    batch,
                    now
                  );
              } else await storage.discardUncommitted(id);
              signal.throwIfAborted();
            }
            return image;
          });
        } catch (error) {
          try {
            if (beginAttempted) await attempt.unknown();
            else await attempt.failBeforePersistence();
          } catch {
            console.warn('Official image budget outcome requires reconciliation');
          }
          // Unknown persistence/commit outcomes retain files; never infer safety from absent event rows.
          throw error;
        }
      }
      return withPhotoSlot(async () => {
        signal?.throwIfAborted();
        const output = await processPhoto(downloaded.bytes, url.pathname.split('/').pop()!, {
          timeoutSeconds: 5
        });
        signal?.throwIfAborted();
        if (output.mime !== mime) throw new Error('Official image MIME does not match decoded data');
        if (!output.original.length || output.original.length > MAX_BYTES)
          throw new Error('Official sanitized original exceeds storage limit');
        const id = randomUUID();
        const prepared: OfficialPreparedImage = {
          id,
          sourceUrl: url.href,
          sourcePageUrl: source.pageUrl,
          sourceKind: source.kind,
          fingerprint: createHash('sha256').update(downloaded.bytes).digest('hex'),
          mime: output.mime,
          width: output.width,
          height: output.height,
          frames: output.frames,
          originalBytes: output.original.length
        };
        // put atomically cleans up only its own partial files on failure. No DB-presence cleanup is performed here.
        await storage.put(id, output);
        if (signal?.aborted) {
          // This candidate has never been returned to the DB owner: its successful put is still uncommitted.
          await storage.discardUncommitted(id);
          signal.throwIfAborted();
        }
        return prepared;
      });
    },
    async discardUnused(batch: OfficialUnusedBatch) {
      if (!storage.boundNamespaces) throw new Error('MEDIA_BOUND_PROOF_REQUIRED');
      const { getDatabase, verifiedOfficialUnusedBatch, findCosObjects } = await import('@artzoo/db');
      const db = (budget?.db ?? getDatabase()) as Pick<
        PrismaClient,
        '$queryRaw' | '$executeRaw' | '$transaction'
      >;
      const description = verifiedOfficialUnusedBatch(batch);
      if (!description) throw new Error('MEDIA_BOUND_OWNER_REQUIRED');
      for (const candidate of description.candidates) {
        if (
          remoteWrites.has(candidate.id) ||
          (options.storage === undefined &&
            (
              await findCosObjects(db, {
                scope: 'official',
                objectId: candidate.id,
                accountId: null
              })
            ).length > 0)
        )
          throw new Error('COS_DELETE_UNSUPPORTED');
      }
      await retireOfficialUnusedBatch(
        db,
        await storage.boundNamespaces(),
        batch,
        budget?.now ?? (() => new Date())
      );
    },
    discard(id: string) {
      return storage.discardUncommitted(id);
    }
  };
}
