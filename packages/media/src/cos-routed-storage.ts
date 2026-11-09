import { createHash } from 'node:crypto';
import {
  confirmCosObject,
  findCosObjects,
  getDatabase,
  reserveCosObjects,
  validateCosObjectLookup,
  type MediaCosObjectRecord,
  type MediaCosObjectTx
} from '@artzoo/db';
import {
  cosObjectKey,
  createPrivateCosStore,
  CosStorageError,
  readCosStorageConfig,
  type CosObjectPart,
  type CosObjectRef,
  type CosObjectScope,
  type CosStorageConfig,
  type PrivateCosObjectStore
} from './cos-object-storage.js';
import type { PhotoOutput } from './photo-processor.js';
import type { PhotoStorage, PhotoVariant } from './photo-storage.js';
import type { BoundDescription, MediaRetirementNamespace } from './stock-bound-io.js';
import type { MediaWriteNamespace } from './cos-stock-write.js';

/** Caller authorizes the business operation and begins its budget before put.
 * Short database transactions contain no network IO; this adapter never settles
 * quota or discovers runtime credentials. Removal ports require the existing durable retirement plans. */
export interface CosRoutingDatabase extends MediaCosObjectTx {
  $transaction<T>(work: (tx: MediaCosObjectTx) => Promise<T>): Promise<T>;
}
interface RoutingOptions {
  /** Explicit server/test ports. Injected observation clients gain no proof authority. */
  database?: CosRoutingDatabase;
  env?: Readonly<Record<string, string | undefined>>;
  createStore?: (config: CosStorageConfig) => PrivateCosObjectStore;
}
export type PhotoStorageScope = Exclude<CosObjectScope, 'avatars' | 'quick-icons'>;
type PhotoBudgetScope = 'daily' | 'wish' | 'lottery-image' | 'knowledge' | 'album-comment' | 'album-photo';
const photoScopes = {
  daily: 'daily',
  wish: 'wishes',
  'lottery-image': 'lottery',
  knowledge: 'knowledge',
  'album-comment': 'album-comments',
  'album-photo': 'albums'
} as const;
const photoParts = ['original', 'preview', 'thumbnail'] as const;
const avatarParts = ['full', 'small'] as const;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fail(code: string): never {
  throw new CosStorageError(code);
}
type Fragment = { part: CosObjectPart; content: Buffer; mime: string };

class RoutedObjects {
  readonly accountId: string | null;
  private readonly env: Readonly<Record<string, string | undefined>>;
  constructor(
    readonly scope: CosObjectScope,
    private readonly parts: readonly CosObjectPart[],
    accountId: string | undefined,
    private readonly options: RoutingOptions
  ) {
    this.accountId = accountId?.toLowerCase() ?? null;
    this.env = options.env ?? process.env;
    // Validate scope/owner even before an object is supplied. This is purely local.
    this.lookup('00000000-0000-4000-8000-000000000000');
  }
  private database(): CosRoutingDatabase {
    return this.options.database ?? getDatabase();
  }
  private lookup(id: string) {
    if (typeof id !== 'string') fail('COS_KEY_INVALID');
    const lookup = { scope: this.scope, objectId: id.toLowerCase(), accountId: this.accountId };
    validateCosObjectLookup({ ...lookup, part: this.parts[0]! });
    return lookup;
  }
  private ref(id: string, part: CosObjectPart): CosObjectRef {
    const lookup = this.lookup(id);
    if (!this.parts.includes(part)) fail('COS_KEY_INVALID');
    return {
      scope: this.scope,
      id: lookup.objectId,
      part,
      ...(this.accountId === null ? {} : { accountId: this.accountId })
    };
  }
  async locations(id: string): Promise<MediaCosObjectRecord[]> {
    return (await findCosObjects(this.database(), this.lookup(id))).map((row) => ({ ...row }));
  }
  private config(row: MediaCosObjectRecord): CosStorageConfig {
    // A changed writing backend/bucket/prefix must not relocate an existing object.
    return {
      bucket: row.bucket,
      region: row.region,
      prefix: row.prefix,
      timeoutMs: this.env.ARTZOO_COS_TIMEOUT_MS === undefined ? 15000 : Number(this.env.ARTZOO_COS_TIMEOUT_MS)
    };
  }
  private store(config: CosStorageConfig): PrivateCosObjectStore {
    if (this.options.createStore) return this.options.createStore(config);
    // No dotenv, shared local smoke file, SDK discovery or credential fallback.
    return createPrivateCosStore(config, {
      secretId: this.env.ARTZOO_COS_SECRET_ID ?? '',
      secretKey: this.env.ARTZOO_COS_SECRET_KEY ?? '',
      securityToken: this.env.ARTZOO_COS_SECURITY_TOKEN
    });
  }
  private complete(id: string, rows: MediaCosObjectRecord[], observed: boolean) {
    const lookup = this.lookup(id);
    if (rows.length !== this.parts.length || new Set(rows.map((row) => row.part)).size !== rows.length)
      fail('COS_OBJECT_INCOMPLETE');
    for (const row of rows) {
      if (
        row.scope !== this.scope ||
        row.objectId !== lookup.objectId ||
        row.accountId !== this.accountId ||
        !this.parts.includes(row.part) ||
        cosObjectKey(this.config(row), this.ref(id, row.part)) !== row.objectKey
      )
        fail('COS_LOCATOR_CONFLICT');
      if (observed && (!row.etag || !row.identityFingerprint)) fail('COS_OBJECT_INCOMPLETE');
    }
    return rows;
  }
  private async assertNotRetired(id: string, rows: readonly MediaCosObjectRecord[]) {
    const kinds = {
      albums: 'album-photo',
      'album-comments': 'album-comment',
      daily: 'daily',
      wishes: 'wish',
      lottery: 'lottery-image',
      knowledge: 'knowledge',
      avatars: 'avatar',
      official: 'official'
    } as const;
    if (!Object.hasOwn(kinds, this.scope)) return;
    const kind = kinds[this.scope as keyof typeof kinds];
    const objectKey =
      kind === 'lottery-image'
        ? 'lottery:' + this.accountId + ':' + id.toLowerCase()
        : (kind === 'avatar' ? 'avatar' : kind === 'official' ? 'official' : kind) + ':' + id.toLowerCase();
    const fences = await this.database().$queryRaw<
      { generation: string; storageIdentityFingerprint: string; part: string }[]
    >`
      /*cos-locator:retirement-fence*/ SELECT c.generation,c."storageIdentityFingerprint",c.part
      FROM "MediaStoredComponent" c JOIN "MediaRetirementIntent" i ON i."componentId"=c.id
      JOIN "MediaUploadReceipt" r ON r.scope=c."receiptScope" AND r."operationKey"=c."receiptOperationKey"
      WHERE c.namespace=${kind === 'official' ? 'official-image' : kind} AND c."objectKey"=${objectKey}
        AND c.generation=r."attemptId" AND r.state='COMMITTED'
        AND i."identityFingerprint"=c."storageIdentityFingerprint"`;
    for (const fence of fences)
      for (const row of rows) {
        const part =
          (kind === 'avatar' ? 'avatar-' : kind === 'official' ? 'official-' : 'photo-') + row.part;
        if (
          fence.part === part &&
          row.identityFingerprint &&
          fence.storageIdentityFingerprint ===
            createHash('sha256')
              .update(JSON.stringify([fence.generation, row.identityFingerprint]))
              .digest('hex')
        )
          fail('COS_OBJECT_RETIRED');
      }
  }
  async put(id: string, fragments: readonly Fragment[], local: () => Promise<void>): Promise<void> {
    // Snapshot all caller-owned bytes before the first asynchronous operation.
    this.lookup(id);
    const owned = fragments.map((fragment) => {
      if (!Buffer.isBuffer(fragment.content) || !fragment.content.length) fail('COS_CONTENT_INVALID');
      return { ...fragment, content: Buffer.from(fragment.content) };
    });
    let rows = await this.locations(id);
    if (rows.length === 0) {
      const config = readCosStorageConfig(this.env);
      if (!config) return local();
      // Missing credentials/configuration fail before writing any reservation.
      this.store(config);
      const lookup = this.lookup(id);
      const inputs = owned.map((fragment) => ({
        ...lookup,
        part: fragment.part,
        bucket: config.bucket,
        region: config.region,
        prefix: config.prefix,
        objectKey: cosObjectKey(config, this.ref(id, fragment.part)),
        bytes: BigInt(fragment.content.length),
        sha256: sha256(fragment.content)
      }));
      rows = await this.database().$transaction((tx) => reserveCosObjects(tx, inputs));
    }
    this.complete(id, rows, false);
    await this.assertNotRetired(id, rows);
    // Detect all conflicting payloads before the first remote write.
    for (const fragment of owned) {
      const row = rows.find((row) => row.part === fragment.part)!;
      if (!row || row.bytes !== BigInt(fragment.content.length) || row.sha256 !== sha256(fragment.content))
        fail('COS_LOCATOR_CONFLICT');
    }
    for (const fragment of owned) {
      const row = rows.find((row) => row.part === fragment.part)!;
      // A confirmed immutable key is never recreated, including after retirement or manual loss.
      // Only incomplete reservations can retry PUT; they cannot obtain retirement authority.
      if (row.etag && row.identityFingerprint) {
        const content = await this.store(this.config(row)).read(
          this.ref(id, fragment.part),
          row.identityFingerprint
        );
        if (sha256(content) !== row.sha256 || BigInt(content.length) !== row.bytes)
          fail('COS_LOCATOR_CONFLICT');
        continue;
      }
      const saved = await this.store(this.config(row)).put(
        this.ref(id, fragment.part),
        fragment.content,
        fragment.mime
      );
      if (
        saved.bucket !== row.bucket ||
        saved.region !== row.region ||
        saved.key !== row.objectKey ||
        saved.sha256 !== row.sha256 ||
        BigInt(saved.bytes) !== row.bytes
      )
        fail('COS_LOCATOR_CONFLICT');
      // A failed/uncertain confirmation leaves all reservations and possibly saved
      // bytes in place. There is deliberately no cleanup or local fallback here.
      await this.database().$transaction((tx) =>
        confirmCosObject(tx, row.id, { sha256: row.sha256, bytes: row.bytes }, saved.etag, saved.fingerprint)
      );
    }
  }
  async read(id: string, part: CosObjectPart, local: () => Promise<Buffer>): Promise<Buffer> {
    this.ref(id, part);
    const rows = await this.locations(id);
    if (!rows.length) return local();
    const row = this.complete(id, rows, true).find((row) => row.part === part)!;
    await this.assertNotRetired(id, rows);
    return this.store(this.config(row)).read(this.ref(id, part), row.identityFingerprint!);
  }
  namespace(
    allowed: Readonly<Partial<Record<BoundDescription['part'], CosObjectPart>>>,
    local: () => Promise<MediaWriteNamespace>
  ): MediaWriteNamespace {
    return Object.freeze({
      capture: async (id: string, part: BoundDescription['part'], hash: string, bytes: bigint) => {
        const objectPart = Object.hasOwn(allowed, part) ? allowed[part] : undefined;
        if (!objectPart) fail('MEDIA_BOUND_SCOPE');
        this.ref(id, objectPart);
        const rows = await this.locations(id);
        if (!rows.length) return (await local()).capture(id, part, hash, bytes);
        const row = this.complete(id, rows, true).find((row) => row.part === objectPart)!;
        if (row.sha256 !== hash || row.bytes !== bytes) fail('COS_PROOF_CONTENT_INVALID');
        return this.store(this.config(row)).captureWrite(this.ref(id, objectPart), {
          sha256: hash,
          bytes: Number(bytes),
          fingerprint: row.identityFingerprint!
        });
      }
    });
  }
  retirementNamespace(
    allowed: Readonly<Partial<Record<BoundDescription['part'], CosObjectPart>>>,
    kind: BoundDescription['kind'],
    local: () => Promise<MediaRetirementNamespace>
  ): MediaRetirementNamespace {
    const tickets = new WeakMap<
      object,
      {
        namespace?: MediaRetirementNamespace;
        store?: PrivateCosObjectStore;
        inner: object;
        description: BoundDescription;
        closed: boolean;
      }
    >();
    const port: MediaRetirementNamespace = {
      capture: this.namespace(allowed, local).capture,
      inspect: async (id, part, hash, bytes, assertActive) => {
        assertActive?.();
        const objectPart = Object.hasOwn(allowed, part) ? allowed[part] : undefined;
        if (!objectPart) fail('MEDIA_BOUND_SCOPE');
        this.ref(id, objectPart);
        const rows = await this.locations(id);
        let entry;
        if (!rows.length) {
          const namespace = await local(),
            inner = await namespace.inspect(id, part, hash, bytes);
          const description = namespace.describe(inner);
          if (!description) {
            await namespace.close(inner);
            fail('MEDIA_BOUND_PROOF_REQUIRED');
          }
          entry = { namespace, inner, description, closed: false };
        } else {
          const row = this.complete(id, rows, true).find((row) => row.part === objectPart)!;
          if (row.sha256 !== hash || row.bytes !== bytes) fail('COS_PROOF_CONTENT_INVALID');
          const store = this.store(this.config(row));
          const inner = await store.inspectRemoval(
            this.ref(id, objectPart),
            {
              sha256: hash,
              bytes: Number(bytes),
              fingerprint: row.identityFingerprint!
            },
            assertActive
          );
          entry = {
            store,
            inner,
            closed: false,
            description: {
              kind,
              objectId: id.toLowerCase(),
              part,
              contentHash: row.sha256,
              bytes: row.bytes,
              physicalFingerprint: row.identityFingerprint!
            }
          };
        }
        const ticket = Object.freeze({});
        tickets.set(ticket, entry);
        return ticket;
      },
      describe: (ticket) => {
        const p = tickets.get(ticket);
        return p && !p.closed ? { ...p.description } : null;
      },
      close: async (ticket) => {
        const p = tickets.get(ticket);
        if (!p || p.closed) return;
        p.closed = true;
        if (p.store) await p.store.closeRemoval(p.inner);
        else await p.namespace!.close(p.inner);
      },
      remove: async (ticket) => {
        const p = tickets.get(ticket);
        if (!p || p.closed) fail('COS_REMOVAL_TICKET_REQUIRED');
        p.closed = true;
        return p.store ? p.store.remove(p.inner) : p.namespace!.remove(p.inner);
      }
    };
    return Object.freeze(port);
  }
  async retainCosOrDeleteLocal(id: string, local: () => Promise<void>) {
    if ((await this.locations(id)).length) fail('COS_DELETE_UNSUPPORTED');
    return local();
  }
}

export function createPhotoStorage(
  options: RoutingOptions & { scope: PhotoStorageScope; accountId?: string; legacy: PhotoStorage }
): PhotoStorage {
  const { legacy, scope } = options;
  if (
    ![
      'albums',
      'album-comments',
      'daily',
      'wishes',
      'lottery',
      'knowledge',
      'activity-shares',
      'official'
    ].includes(scope)
  )
    fail('MEDIA_BOUND_SCOPE');
  const route = new RoutedObjects(scope, photoParts, options.accountId, options);
  const localNamespaces = async (budgetScope?: PhotoBudgetScope) => {
    if (budgetScope !== undefined) {
      if (!legacy.boundPhotoNamespaces) fail('MEDIA_BOUND_SCOPE');
      return legacy.boundPhotoNamespaces(budgetScope);
    }
    if (!legacy.boundNamespaces) fail('MEDIA_BOUND_SCOPE');
    return legacy.boundNamespaces();
  };
  const writeNamespaces = (budgetScope?: PhotoBudgetScope) => {
    const official = budgetScope === undefined;
    if (official ? scope !== 'official' : photoScopes[budgetScope] !== scope) fail('MEDIA_BOUND_SCOPE');
    return {
      original: route.namespace(
        official ? { 'official-original': 'original' } : { 'photo-original': 'original' },
        async () => (await localNamespaces(budgetScope)).original
      ),
      derived: route.namespace(
        official
          ? { 'official-preview': 'preview', 'official-thumbnail': 'thumbnail' }
          : { 'photo-preview': 'preview', 'photo-thumbnail': 'thumbnail' },
        async () => (await localNamespaces(budgetScope)).derived
      )
    };
  };
  return {
    async put(id: string, output: PhotoOutput) {
      return route.put(
        id,
        photoParts.map((part) => ({
          part,
          content: output[part],
          mime: part === 'original' ? output.mime : 'image/webp'
        })),
        () => legacy.put(id, output)
      );
    },
    read: (id: string, variant: PhotoVariant) => route.read(id, variant, () => legacy.read(id, variant)),
    discardUncommitted: (id) => route.retainCosOrDeleteLocal(id, () => legacy.discardUncommitted(id)),
    boundPhotoNamespaces: async (budgetScope) => {
      if (photoScopes[budgetScope] !== scope) fail('MEDIA_BOUND_SCOPE');
      // This release enables remote reclamation only for explicit album-photo deletions.
      if (budgetScope !== 'album-photo') return localNamespaces(budgetScope);
      return {
        original: route.retirementNamespace(
          { 'photo-original': 'original' },
          budgetScope,
          async () => (await localNamespaces(budgetScope)).original
        ),
        derived: route.retirementNamespace(
          { 'photo-preview': 'preview', 'photo-thumbnail': 'thumbnail' },
          budgetScope,
          async () => (await localNamespaces(budgetScope)).derived
        )
      };
    },
    ...(legacy.boundNamespaces ? { boundNamespaces: legacy.boundNamespaces.bind(legacy) } : {}),
    writePhotoNamespaces: async (budgetScope) => writeNamespaces(budgetScope),
    writeNamespaces: async () => writeNamespaces()
  };
}

/** Structural server port avoids making the media package depend on the web app. */
export interface RoutedAvatarStorage {
  put(id: string, output: { full: Buffer; small: Buffer; width: number; height: number }): Promise<void>;
  read(id: string, variant: 'full' | 'small'): Promise<Buffer>;
  delete(id: string): Promise<void>;
  boundNamespace?(): Promise<MediaRetirementNamespace>;
  writeNamespace?(): Promise<MediaWriteNamespace>;
}
export function createAvatarStorage(
  options: RoutingOptions & { legacy: RoutedAvatarStorage }
): RoutedAvatarStorage {
  const { legacy } = options;
  const route = new RoutedObjects('avatars', avatarParts, undefined, options);
  return {
    put: (id, output) =>
      route.put(
        id,
        avatarParts.map((part) => ({ part, content: output[part], mime: 'image/webp' })),
        () => legacy.put(id, output)
      ),
    read: (id, variant) => route.read(id, variant, () => legacy.read(id, variant)),
    delete: (id) => route.retainCosOrDeleteLocal(id, () => legacy.delete(id)),
    ...(legacy.boundNamespace ? { boundNamespace: legacy.boundNamespace.bind(legacy) } : {}),
    writeNamespace: async () =>
      route.namespace({ 'avatar-full': 'full', 'avatar-small': 'small' }, async () => {
        if (!legacy.boundNamespace) fail('MEDIA_BOUND_SCOPE');
        return legacy.boundNamespace();
      })
  };
}
