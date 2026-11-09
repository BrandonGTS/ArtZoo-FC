import COS from 'cos-nodejs-sdk-v5';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

/** Server-only preparation. Not selected by any live runtime factory yet. */
export interface CosStorageConfig {
  bucket: string;
  region: 'ap-hongkong';
  prefix: string;
  timeoutMs: number;
}
export type CosObjectScope =
  | 'albums'
  | 'album-comments'
  | 'daily'
  | 'wishes'
  | 'lottery'
  | 'knowledge'
  | 'activity-shares'
  | 'avatars'
  | 'quick-icons'
  | 'official';
export type CosObjectPart = 'original' | 'preview' | 'thumbnail' | 'full' | 'small' | 'icon';
export interface CosObjectRef {
  scope: CosObjectScope;
  id: string;
  part: CosObjectPart;
  /** Required only for the existing account-scoped lottery namespace. */
  accountId?: string;
}
/** Storage observation, NOT a stock-retirement proof or permission to release quota. */
export interface CosObjectIdentity {
  readonly backend: 'cos';
  readonly bucket: string;
  readonly region: 'ap-hongkong';
  readonly key: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly etag: string;
  readonly fingerprint: string;
}
export type CosWriteProof = object & { readonly __cosWriteProof: unique symbol };
export interface CosWriteDescription extends CosObjectIdentity {
  readonly scope: CosObjectScope;
  readonly objectId: string;
  readonly part: CosObjectPart;
  readonly accountId: string | null;
}
// Only the real SDK factory grants issuer status. Injectable observation clients cannot mint proofs.
const trustedStores = new WeakSet<PrivateCosObjectStore>();
const writeProofs = new WeakMap<object, Readonly<CosWriteDescription>>();
const removalProofs = new WeakMap<object, Readonly<CosWriteDescription>>();
const removalTickets = new WeakMap<
  object,
  {
    store: PrivateCosObjectStore;
    ref: Readonly<CosObjectRef>;
    description: Readonly<CosWriteDescription>;
    closed: boolean;
    assertActive?: () => void;
  }
>();
/** Only an acknowledged, unversioned SDK DELETE followed by absence can mint this proof. */
export function verifiedCosRemoval(proof: object): CosWriteDescription | null {
  const description = removalProofs.get(proof);
  return description ? { ...description } : null;
}
export function verifiedCosWrite(proof: object): CosWriteDescription | null {
  const description = writeProofs.get(proof);
  return description ? { ...description } : null;
}
export interface CosObjectClient {
  headObject(params: COS.HeadObjectParams): Promise<COS.HeadObjectResult>;
  getBucketVersioning?(params: COS.GetBucketVersioningParams): Promise<COS.GetBucketVersioningResult>;
  deleteObject?(params: COS.DeleteObjectParams): Promise<COS.DeleteObjectResult>;
  putObject(params: COS.PutObjectParams): Promise<COS.PutObjectResult>;
  getObject(params: COS.GetObjectParams): Promise<COS.GetObjectResult>;
}
export class CosStorageError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CosStorageError';
  }
}
function fail(code: string): never {
  throw new CosStorageError(code);
}
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const scopes = new Set([
  'albums',
  'album-comments',
  'daily',
  'wishes',
  'lottery',
  'knowledge',
  'activity-shares',
  'avatars',
  'quick-icons',
  'official'
]);
const mimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/mpo'
]);
function validateConfig(input: CosStorageConfig): Readonly<CosStorageConfig> {
  if (
    !/^[a-z0-9][a-z0-9-]{0,49}-[0-9]{5,20}$/.test(input.bucket) ||
    input.region !== 'ap-hongkong' ||
    !/^[a-z0-9][a-z0-9-]{0,39}(?:\/[a-z0-9][a-z0-9-]{0,39}){0,3}$/.test(input.prefix) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1000 ||
    input.timeoutMs > 30000
  )
    fail('COS_CONFIG_INVALID');
  return Object.freeze({
    bucket: input.bucket,
    region: input.region,
    prefix: input.prefix,
    timeoutMs: input.timeoutMs
  });
}
/** Does not read credentials, create a client, change settings, or make any network request. */
export function readCosStorageConfig(
  env: Readonly<Record<string, string | undefined>>
): CosStorageConfig | null {
  if ((env.ARTZOO_MEDIA_STORAGE ?? 'local') === 'local') return null;
  if (env.ARTZOO_MEDIA_STORAGE !== 'cos') fail('COS_CONFIG_INVALID');
  return validateConfig({
    bucket: env.ARTZOO_COS_BUCKET ?? '',
    region: (env.ARTZOO_COS_REGION ?? '') as 'ap-hongkong',
    prefix: env.ARTZOO_COS_PREFIX ?? '',
    timeoutMs: env.ARTZOO_COS_TIMEOUT_MS === undefined ? 15000 : Number(env.ARTZOO_COS_TIMEOUT_MS)
  });
}
function address(config: Readonly<CosStorageConfig>, ref: CosObjectRef) {
  if (!scopes.has(ref.scope) || !uuid(ref.id)) fail('COS_KEY_INVALID');
  const parts =
    ref.scope === 'avatars'
      ? ['full', 'small']
      : ref.scope === 'quick-icons'
        ? ['icon']
        : ['original', 'preview', 'thumbnail'];
  if (
    !parts.includes(ref.part) ||
    (ref.scope === 'lottery' ? !uuid(ref.accountId) : ref.accountId !== undefined)
  )
    fail('COS_KEY_INVALID');
  const key = [
    config.prefix,
    ref.scope,
    ...(ref.accountId ? [ref.accountId.toLowerCase()] : []),
    ref.id.toLowerCase() + '.' + ref.part
  ].join('/');
  const maxBytes =
    ref.scope === 'avatars' || ref.scope === 'quick-icons'
      ? 2_000_000
      : ref.part === 'original'
        ? ref.scope === 'official'
          ? 5 * 1024 * 1024
          : 30 * 1024 * 1024
        : 60 * 1024 * 1024;
  return { key, maxBytes };
}
/** Pure server key construction shared with the durable locator; no network or credentials. */
export function cosObjectKey(config: CosStorageConfig, ref: CosObjectRef): string {
  return address(validateConfig(config), ref).key;
}
function fixedRef(config: Readonly<CosStorageConfig>, ref: CosObjectRef): Readonly<CosObjectRef> {
  address(config, ref);
  return Object.freeze({
    scope: ref.scope,
    id: ref.id.toLowerCase(),
    part: ref.part,
    ...(ref.accountId === undefined ? {} : { accountId: ref.accountId.toLowerCase() })
  });
}
function header(headers: COS.Headers | undefined, key: string): string | undefined {
  const value = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === key)?.[1];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}
function status(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined;
}
function uncertain(error: unknown) {
  const s = status(error);
  return s === undefined || s < 400 || s === 408 || s === 429 || s >= 500;
}
function safeError(error: unknown): CosStorageError {
  // SDK mutates stream errors with provider URL/headers. Never return the same object.
  if (
    error instanceof CosStorageError &&
    [
      'COS_OBJECT_INVALID',
      'COS_OBJECT_CHANGED',
      'COS_NOT_FOUND',
      'COS_ACCESS_DENIED',
      'COS_UNAVAILABLE'
    ].includes(error.code)
  )
    return new CosStorageError(error.code);
  const s = status(error);
  return new CosStorageError(
    s === 401 || s === 403
      ? 'COS_ACCESS_DENIED'
      : s === 404
        ? 'COS_NOT_FOUND'
        : s === 412
          ? 'COS_OBJECT_CHANGED'
          : 'COS_UNAVAILABLE'
  );
}

/** Immutable server-generated object keys. No bucket/ACL administration, URLs, listing or arbitrary-key delete API. */
export class PrivateCosObjectStore {
  #config: Readonly<CosStorageConfig>;
  #client: CosObjectClient;
  constructor(config: CosStorageConfig, client: CosObjectClient) {
    this.#config = validateConfig(config);
    this.#client = client;
  }
  #params(key: string): COS.ObjectParams {
    return { Bucket: this.#config.bucket, Region: this.#config.region, Key: key };
  }
  async #observe(
    key: string,
    maxBytes: number,
    assertActive?: () => void
  ): Promise<CosObjectIdentity | null> {
    assertActive?.();
    let result: COS.HeadObjectResult;
    try {
      result = await this.#client.headObject(this.#params(key));
    } catch (error) {
      if (status(error) === 404) return null;
      throw safeError(error);
    }
    const size = header(result.headers, 'content-length'),
      digest = header(result.headers, 'x-cos-meta-artzoo-sha256'),
      etag = result.ETag;
    if (
      result.statusCode !== 200 ||
      !size ||
      !/^[1-9][0-9]*$/.test(size) ||
      !Number.isSafeInteger(Number(size)) ||
      Number(size) > maxBytes ||
      !digest ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      typeof etag !== 'string' ||
      !/^"[!#-~]{1,128}"$/.test(etag) ||
      ((result.VersionId ?? header(result.headers, 'x-cos-version-id')) !== undefined &&
        (result.VersionId ?? header(result.headers, 'x-cos-version-id')) !== 'null')
    )
      fail('COS_OBJECT_INVALID');
    const identity = {
      backend: 'cos' as const,
      bucket: this.#config.bucket,
      region: this.#config.region,
      key,
      bytes: Number(size),
      sha256: digest,
      etag
    };
    return Object.freeze({
      ...identity,
      fingerprint: sha256(
        JSON.stringify([
          'artzoo-cos-object-v1',
          identity.bucket,
          identity.region,
          key,
          identity.bytes,
          digest,
          etag
        ])
      )
    });
  }
  async inspect(ref: CosObjectRef): Promise<CosObjectIdentity | null> {
    return this.#inspect(ref);
  }
  async #inspect(ref: CosObjectRef, assertActive?: () => void): Promise<CosObjectIdentity | null> {
    const { key, maxBytes } = address(this.#config, ref);
    return this.#observe(key, maxBytes, assertActive);
  }
  async put(ref: CosObjectRef, input: Buffer, mime: string): Promise<CosObjectIdentity> {
    ref = fixedRef(this.#config, ref);
    const { key, maxBytes } = address(this.#config, ref);
    if (!Buffer.isBuffer(input) || input.length === 0 || input.length > maxBytes || !mimeTypes.has(mime))
      fail('COS_CONTENT_INVALID');
    // Freeze the payload against caller mutation during the asynchronous write/reconciliation.
    const bytes = Buffer.from(input),
      digest = sha256(bytes);
    const matches = (identity: CosObjectIdentity) => {
      if (identity.bytes !== bytes.length || identity.sha256 !== digest) fail('COS_KEY_CONFLICT');
      return identity;
    };
    const verifyExisting = async (identity: CosObjectIdentity) => {
      matches(identity);
      await this.#read(ref, identity.fingerprint);
      return identity;
    };
    const existing = await this.#observe(key, maxBytes);
    if (existing) return verifyExisting(existing);
    const body = Readable.from([bytes]);
    let putResult: COS.PutObjectResult;
    try {
      putResult = await this.#client.putObject({
        ...this.#params(key),
        Body: body,
        ContentLength: bytes.length,
        ContentType: mime,
        CacheControl: 'private, no-store',
        ACL: 'private',
        StorageClass: 'STANDARD',
        'x-cos-meta-artzoo-sha256': digest,
        Headers: {
          'x-cos-forbid-overwrite': 'true',
          'Content-MD5': createHash('md5').update(bytes).digest('base64')
        }
      });
    } catch (error) {
      // COS SDK stream uploads do not retry the PUT. Reconcile a lost acknowledgement;
      // do not re-upload or erase possibly committed bytes on an uncertain result.
      if (![409, 412].includes(status(error) ?? 0) && !uncertain(error)) throw safeError(error);
      let found: CosObjectIdentity | null;
      try {
        found = await this.#observe(key, maxBytes);
      } catch {
        fail('COS_WRITE_UNCERTAIN');
      }
      if (found) {
        try {
          return await verifyExisting(found);
        } catch (verification) {
          if (verification instanceof CosStorageError && verification.code === 'COS_KEY_CONFLICT')
            throw new CosStorageError('COS_KEY_CONFLICT');
          fail('COS_WRITE_UNCERTAIN');
        }
      }
      fail('COS_WRITE_UNCERTAIN');
    } finally {
      body.destroy();
    }
    // Even a successful PUT must be observed before its bytes can be recorded as durable.
    let saved: CosObjectIdentity | null;
    try {
      saved = await this.#observe(key, maxBytes);
    } catch {
      fail('COS_WRITE_UNCERTAIN');
    }
    if (
      !saved ||
      putResult.statusCode !== 200 ||
      putResult.ETag !== saved.etag ||
      ((putResult.VersionId ?? header(putResult.headers, 'x-cos-version-id')) !== undefined &&
        (putResult.VersionId ?? header(putResult.headers, 'x-cos-version-id')) !== 'null')
    )
      fail('COS_WRITE_UNCERTAIN');
    return matches(saved);
  }
  /** A complete actual read, fixed payload and exact persisted locator identity are required. */
  async captureWrite(
    ref: CosObjectRef,
    expected: { sha256: string; bytes: number; fingerprint: string }
  ): Promise<CosWriteProof> {
    if (!trustedStores.has(this)) fail('COS_PROOF_ISSUER_REQUIRED');
    ref = fixedRef(this.#config, ref);
    expected = { sha256: expected.sha256, bytes: expected.bytes, fingerprint: expected.fingerprint };
    if (
      !/^[a-f0-9]{64}$/.test(expected.sha256) ||
      !/^[a-f0-9]{64}$/.test(expected.fingerprint) ||
      !Number.isSafeInteger(expected.bytes) ||
      expected.bytes <= 0
    )
      fail('COS_PROOF_CONTENT_INVALID');
    const identity = await this.#inspect(ref);
    if (
      !identity ||
      identity.sha256 !== expected.sha256 ||
      identity.bytes !== expected.bytes ||
      identity.fingerprint !== expected.fingerprint
    )
      fail('COS_PROOF_CONTENT_INVALID');
    const content = await this.#read(ref, identity.fingerprint);
    if (content.length !== expected.bytes || sha256(content) !== expected.sha256)
      fail('COS_PROOF_CONTENT_INVALID');
    const proof = Object.freeze({}) as CosWriteProof;
    writeProofs.set(
      proof,
      Object.freeze({
        ...identity,
        scope: ref.scope,
        objectId: ref.id.toLowerCase(),
        part: ref.part,
        accountId: ref.accountId?.toLowerCase() ?? null
      })
    );
    return proof;
  }
  async #unversioned(assertActive?: () => void) {
    assertActive?.();
    if (!this.#client.getBucketVersioning) fail('COS_DELETE_UNSUPPORTED');
    let result: COS.GetBucketVersioningResult;
    try {
      result = await this.#client.getBucketVersioning({
        Bucket: this.#config.bucket,
        Region: this.#config.region
      });
    } catch (error) {
      throw safeError(error);
    }
    // A suspended bucket can retain historical bytes too. Never request version deletion.
    if (
      result.statusCode !== 200 ||
      !result.VersioningConfiguration ||
      Object.keys(result.VersioningConfiguration).length !== 0
    )
      fail('COS_VERSIONING_UNSUPPORTED');
  }
  /** Inspection is not business permission: callers must durably fence all references before remove. */
  async inspectRemoval(
    ref: CosObjectRef,
    expected: { sha256: string; bytes: number; fingerprint: string },
    assertActive?: () => void
  ): Promise<object> {
    if (!trustedStores.has(this)) fail('COS_PROOF_ISSUER_REQUIRED');
    ref = fixedRef(this.#config, ref);
    expected = { sha256: expected.sha256, bytes: expected.bytes, fingerprint: expected.fingerprint };
    if (
      !/^[a-f0-9]{64}$/.test(expected.sha256) ||
      !/^[a-f0-9]{64}$/.test(expected.fingerprint) ||
      !Number.isSafeInteger(expected.bytes) ||
      expected.bytes <= 0
    )
      fail('COS_PROOF_CONTENT_INVALID');
    await this.#unversioned(assertActive);
    const identity = await this.#inspect(ref, assertActive);
    if (
      !identity ||
      identity.sha256 !== expected.sha256 ||
      identity.bytes !== expected.bytes ||
      identity.fingerprint !== expected.fingerprint
    )
      fail('COS_OBJECT_CHANGED');
    await this.#read(ref, identity.fingerprint, assertActive);
    const ticket = Object.freeze({});
    removalTickets.set(ticket, {
      store: this,
      ref,
      closed: false,
      assertActive,
      description: Object.freeze({
        ...identity,
        scope: ref.scope,
        objectId: ref.id,
        part: ref.part,
        accountId: ref.accountId ?? null
      })
    });
    return ticket;
  }
  describeRemoval(ticket: object): CosWriteDescription | null {
    const held = removalTickets.get(ticket);
    return held?.store === this && !held.closed ? { ...held.description } : null;
  }
  async closeRemoval(ticket: object): Promise<void> {
    const held = removalTickets.get(ticket);
    if (held?.store === this) held.closed = true;
  }
  /** UUID keys are never reused and application PUT forbids overwrite. COS has no documented
   * atomic compare-and-delete: do not mistake a HEAD or an If-Match header for that guarantee.
   * Only existing DB retirement plans may call this after their durable permanent fence. */
  async remove(ticket: object): Promise<object> {
    const held = removalTickets.get(ticket);
    if (!trustedStores.has(this) || held?.store !== this || held.closed) fail('COS_REMOVAL_TICKET_REQUIRED');
    // Consume before any await: no concurrent/repeated request, including after an uncertain result.
    held.closed = true;
    const d = held.description,
      assertActive = held.assertActive;
    if (!this.#client.deleteObject) fail('COS_DELETE_UNSUPPORTED');
    await this.#unversioned(assertActive);
    const current = await this.#inspect(held.ref, assertActive);
    if (!current || current.fingerprint !== d.fingerprint) fail('COS_OBJECT_CHANGED');
    await this.#read(held.ref, d.fingerprint, assertActive);
    let result: COS.DeleteObjectResult;
    try {
      assertActive?.();
      result = await this.#client.deleteObject(this.#params(d.key));
    } catch (error) {
      if (!uncertain(error) && status(error) !== 404) throw safeError(error);
      fail('COS_DELETE_UNCERTAIN');
    }
    // The SDK maps DELETE 404 to a resolved BucketNotFound result. It is not an acknowledgement.
    if (
      result.statusCode !== 204 ||
      header(result.headers, 'x-cos-delete-marker') !== undefined ||
      header(result.headers, 'x-cos-version-id') !== undefined
    )
      fail('COS_DELETE_UNCERTAIN');
    try {
      await this.#unversioned(assertActive);
      if (await this.#inspect(held.ref, assertActive)) fail('COS_DELETE_UNCERTAIN');
    } catch {
      fail('COS_DELETE_UNCERTAIN');
    }
    const proof = Object.freeze({});
    removalProofs.set(proof, Object.freeze({ ...d }));
    return proof;
  }
  async read(ref: CosObjectRef, expectedFingerprint?: string): Promise<Buffer> {
    return this.#read(ref, expectedFingerprint);
  }
  async #read(ref: CosObjectRef, expectedFingerprint?: string, assertActive?: () => void): Promise<Buffer> {
    const { key, maxBytes } = address(this.#config, ref),
      identity = await this.#observe(key, maxBytes, assertActive);
    if (!identity) fail('COS_NOT_FOUND');
    if (expectedFingerprint !== undefined && expectedFingerprint !== identity.fingerprint)
      fail('COS_OBJECT_CHANGED');
    const chunks: Buffer[] = [];
    let total = 0;
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        total += chunk.length;
        if (total > identity.bytes) return callback(new CosStorageError('COS_OBJECT_INVALID'));
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });
    // Attach the rejection handler before giving the stream to the SDK.
    const completed = finished(output);
    completed.catch(() => undefined);
    try {
      assertActive?.();
      const result = await this.#client.getObject({
        ...this.#params(key),
        Output: output,
        Range: `bytes=0-${identity.bytes - 1}`,
        IfMatch: identity.etag
      });
      await completed;
      if (
        ![200, 206].includes(result.statusCode ?? 0) ||
        result.ETag !== identity.etag ||
        ((result.VersionId ?? header(result.headers, 'x-cos-version-id')) !== undefined &&
          (result.VersionId ?? header(result.headers, 'x-cos-version-id')) !== 'null') ||
        total !== identity.bytes
      )
        fail('COS_OBJECT_CHANGED');
      const bytes = Buffer.concat(chunks, total);
      if (sha256(bytes) !== identity.sha256) fail('COS_OBJECT_CHANGED');
      return bytes;
    } catch (error) {
      throw safeError(error);
    } finally {
      output.destroy();
    }
  }
}

/** Credentials are supplied only by an explicitly configured server runtime, never by a browser. */
export function createPrivateCosStore(
  config: CosStorageConfig,
  credentials: {
    secretId: string;
    secretKey: string;
    securityToken?: string;
  }
): PrivateCosObjectStore {
  const checked = validateConfig(config);
  if (!credentials.secretId || !credentials.secretKey) fail('COS_CREDENTIALS_REQUIRED');
  const client = new COS({
    SecretId: credentials.secretId,
    SecretKey: credentials.secretKey,
    SecurityToken: credentials.securityToken,
    Protocol: 'https:',
    StrictSsl: true,
    ForceSignHost: true,
    FollowRedirect: false,
    AutoSwitchHost: false,
    UseAccelerate: false,
    CorrectClockSkew: false,
    Timeout: checked.timeoutMs,
    ChunkRetryTimes: 0
  });
  const store = new PrivateCosObjectStore(checked, {
    headObject: (params) => client.headObject(params),
    getObject: (params) => client.getObject(params),
    putObject: (params) => client.putObject(params),
    getBucketVersioning: (params) => client.getBucketVersioning(params),
    deleteObject: async (params) => {
      // Pinned SDK base DELETE retries by default, even with ChunkRetryTimes=0.
      // Its supported request API with an empty stream disables base request replay.
      // Bucket/region/key are still the fixed validated object address, never a URL.
      const body = Readable.from([]);
      try {
        return await client.request({
          Bucket: params.Bucket,
          Region: params.Region,
          Key: params.Key,
          Method: 'DELETE',
          Body: body,
          Headers: { 'Content-Length': '0' },
          RawBody: true
        });
      } finally {
        body.destroy();
      }
    }
  });
  trustedStores.add(store);
  return store;
}
