import { constants } from 'node:fs';
import { open, lstat, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve, join } from 'node:path';
import { PHOTO_RULES } from './photo-contract.js';
import { isMemberId } from '@artzoo/domain';

import type { MediaWriteNamespace } from './media-write.js';

export type BoundWriteProof = object & { readonly __boundWriteProof: unique symbol };
type Kind =
  'avatar' | 'knowledge' | 'official' | 'daily' | 'wish' | 'lottery-image' | 'album-comment' | 'album-photo';
type Part =
  | 'avatar-full'
  | 'avatar-small'
  | 'knowledge-journal'
  | 'official-original'
  | 'official-preview'
  | 'official-thumbnail'
  | 'photo-original'
  | 'photo-preview'
  | 'photo-thumbnail';
export interface BoundDescription {
  kind: Kind;
  objectId: string;
  part: Part;
  contentHash: string;
  bytes: bigint;
  physicalFingerprint: string;
  originalBytes?: bigint;
  mediaBytes?: bigint;
  requestFingerprint?: string;
}
/** Structural IO port only. Its return values gain authority solely through private proof registries. */
export interface MediaRetirementNamespace extends MediaWriteNamespace {
  inspect(
    id: string,
    part: BoundDescription['part'],
    expected: string,
    charged: bigint,
    assertActive?: () => void
  ): Promise<object>;
  describe(ticket: object): BoundDescription | null;
  close(ticket: object): Promise<void>;
  remove(ticket: object): Promise<object>;
}
interface Held {
  owner: BoundNamespace;
  file: FileHandle;
  path: string;
  description: BoundDescription;
  dev: bigint;
  ino: bigint;
  rootHash: string;
  closed: boolean;
}
const held = new WeakMap<object, Held>(),
  written = new WeakMap<object, BoundDescription>(),
  removed = new WeakMap<object, BoundDescription>();
export const boundHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = (s: string) => /^[a-f0-9]{64}$/.test(s);
function description(map: WeakMap<object, BoundDescription>, ticket: object) {
  const d = map.get(ticket);
  return d ? { ...d } : null;
}
export const verifiedBoundWrite = (ticket: object) => description(written, ticket);
export const verifiedBoundRemoval = (ticket: object) => description(removed, ticket);
/** Shared trust check for persistent media directories; never creates directories. */
export async function trustedMediaDirectoryIdentity(root: string) {
  if (!isAbsolute(root) || resolve(root) !== root || root === '/') throw Error('MEDIA_BOUND_ROOT');
  let current = '/';
  let namespaceIdentity: string[] | undefined;
  if (typeof process.getuid !== 'function') throw Error('MEDIA_BOUND_PLATFORM');
  const uid = BigInt(process.getuid());
  const top = await lstat('/', { bigint: true });
  if (!top.isDirectory() || top.isSymbolicLink() || top.uid !== 0n || (top.mode & 0o022n) !== 0n)
    throw Error('MEDIA_BOUND_UNTRUSTED_ROOT');
  for (const part of root.split('/').filter(Boolean)) {
    current = join(/* turbopackIgnore: true */ current, part);
    const stat = await lstat(current, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.uid !== uid && stat.uid !== 0n) ||
      (stat.mode & 0o022n) !== 0n
    )
      throw Error('MEDIA_BOUND_UNTRUSTED_ROOT');
    // Validate ALL ancestors every time; bind only the persistent namespace identity.
    // Image/container ancestor inodes may legitimately change across a deployment.
    namespaceIdentity = [stat.dev.toString(), stat.ino.toString(), stat.uid.toString()];
  }
  if ((await realpath(root)) !== root) throw Error('MEDIA_BOUND_UNTRUSTED_ROOT');
  if (!namespaceIdentity) throw Error('MEDIA_BOUND_ROOT');
  return namespaceIdentity;
}

/** Purely real FS proofs. No generic callback, flag, caller-provided identity or proof constructor. */
export class BoundNamespace {
  private readonly root: string;
  constructor(
    root: string,
    private readonly kind: Kind
  ) {
    if (!isAbsolute(root)) throw Error('MEDIA_BOUND_ROOT');
    this.root = resolve(/* turbopackIgnore: true */ root);
    if (this.root === '/') throw Error('MEDIA_BOUND_ROOT');
  }
  private async rootIdentity() {
    return boundHash([this.kind, this.root, await trustedMediaDirectoryIdentity(this.root)]);
  }
  private path(id: string, part: Part) {
    if (!isMemberId(id)) throw Error('MEDIA_BOUND_KEY');
    if (this.kind === 'avatar' && (part === 'avatar-full' || part === 'avatar-small'))
      return join(
        /* turbopackIgnore: true */ this.root,
        id.toLowerCase() + '.' + (part === 'avatar-full' ? 'full' : 'small') + '.webp'
      );
    if (this.kind === 'knowledge' && part === 'knowledge-journal')
      return join(/* turbopackIgnore: true */ this.root, id.toLowerCase() + '.jsonl');
    if (
      this.kind === 'official' &&
      ['official-original', 'official-preview', 'official-thumbnail'].includes(part)
    )
      return join(
        /* turbopackIgnore: true */ this.root,
        id.toLowerCase() + '.' + part.slice('official-'.length)
      );
    if (
      (this.kind === 'daily' ||
        this.kind === 'wish' ||
        this.kind === 'lottery-image' ||
        this.kind === 'album-comment' ||
        this.kind === 'album-photo' ||
        this.kind === 'knowledge') &&
      ['photo-original', 'photo-preview', 'photo-thumbnail'].includes(part)
    )
      return join(
        /* turbopackIgnore: true */ this.root,
        id.toLowerCase() + '.' + part.slice('photo-'.length)
      );
    throw Error('MEDIA_BOUND_KEY');
  }
  private async readContent(
    file: FileHandle,
    part: Part,
    expected: string,
    amount: bigint,
    expectedId: string
  ) {
    if (!digest(expected) || amount <= 0n) throw Error('MEDIA_BOUND_CONTENT');
    const before = await file.stat({ bigint: true });
    const max =
      part === 'knowledge-journal'
        ? 8192n
        : part === 'photo-original'
          ? BigInt(PHOTO_RULES.maxBytes)
          : part.startsWith('photo-')
            ? BigInt(PHOTO_RULES.maxBytes * 2)
            : part === 'official-original'
              ? 5242880n
              : part.startsWith('official-')
                ? BigInt(PHOTO_RULES.maxBytes * 2)
                : 2000000n;
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid!()) ||
      before.size <= 0n ||
      before.size > max ||
      (before.mode & 0o022n) !== 0n
    )
      throw Error('MEDIA_BOUND_FILE');
    const official = part.startsWith('official-') || part.startsWith('photo-');
    // Official derived outputs retain PhotoStorage's larger limit without another whole-output copy.
    const bytes = Buffer.alloc(official ? Math.min(Number(before.size), 65536) : Number(before.size));
    let offset = 0;
    const content = official ? createHash('sha256') : null;
    while (offset < Number(before.size)) {
      const count = Math.min(bytes.length, Number(before.size) - offset);
      const n = await file.read(
        bytes,
        official ? 0 : offset,
        official ? count : bytes.length - offset,
        offset
      );
      if (n.bytesRead === 0) throw Error('MEDIA_BOUND_SHORT_READ');
      if (content) content.update(bytes.subarray(0, n.bytesRead));
      offset += n.bytesRead;
    }
    if (content && (before.size !== amount || content.digest('hex') !== expected))
      throw Error('MEDIA_BOUND_CONTENT');
    const after = await file.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n
    )
      throw Error('MEDIA_BOUND_CHANGED');
    let journal: { originalBytes: bigint; mediaBytes: bigint; requestFingerprint: string } | undefined;
    if (part === 'knowledge-journal') {
      if (BigInt(bytes.length) > amount) throw Error('MEDIA_BOUND_CONTENT');
      const lines = bytes.toString('utf8').split('\n');
      if (
        lines.pop() !== '' ||
        !lines.length ||
        lines.length > 4 ||
        sha(Buffer.from(lines[0] + '\n')) !== expected
      )
        throw Error('MEDIA_BOUND_CONTENT');
      const prepared = JSON.parse(lines[0]!);
      if (
        prepared.schemaVersion !== 1 ||
        prepared.state !== 'prepared' ||
        prepared.imageId !== expectedId ||
        !/^[a-f0-9]{64}$/.test(prepared.digest) ||
        !Array.isArray(prepared.variants) ||
        prepared.variants.length !== 3 ||
        prepared.variants.some(
          (v: { variant?: unknown; bytes?: unknown }, i: number) =>
            v.variant !== ['original', 'preview', 'thumbnail'][i] ||
            typeof v.bytes !== 'number' ||
            !Number.isSafeInteger(v.bytes) ||
            v.bytes <= 0
        )
      )
        throw Error('MEDIA_BOUND_CONTENT');
      journal = {
        originalBytes: BigInt(prepared.variants[0].bytes),
        mediaBytes: prepared.variants.reduce(
          (sum: bigint, v: { bytes: number }) => sum + BigInt(v.bytes),
          0n
        ),
        requestFingerprint: prepared.digest
      };
      for (const line of lines.slice(1)) {
        const note = JSON.parse(line);
        if (
          Object.keys(note).length !== 1 ||
          !['files-written', 'rollback-confirmed', 'pending', 'committed', 'replayed', 'discarded'].includes(
            note.state
          )
        )
          throw Error('MEDIA_BOUND_CONTENT');
      }
    } else if (!official && (BigInt(bytes.length) !== amount || sha(bytes) !== expected))
      throw Error('MEDIA_BOUND_CONTENT');
    return { stat: before, journal };
  }
  async inspect(id: string, part: Part, expected: string, charged: bigint) {
    const rootHash = await this.rootIdentity(),
      path = this.path(id, part),
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const { stat, journal } = await this.readContent(file, part, expected, charged, id),
        pathStat = await lstat(path, { bigint: true });
      if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino || pathStat.isSymbolicLink())
        throw Error('MEDIA_BOUND_CHANGED');
      const d: BoundDescription = {
        ...journal,
        kind: this.kind,
        objectId: id,
        part,
        contentHash: expected,
        bytes: charged,
        physicalFingerprint: boundHash([
          rootHash,
          id,
          part,
          stat.dev.toString(),
          stat.ino.toString(),
          stat.uid.toString(),
          expected
        ])
      };
      const ticket = Object.freeze({});
      held.set(ticket, {
        owner: this,
        file,
        path,
        description: d,
        dev: stat.dev,
        ino: stat.ino,
        rootHash,
        closed: false
      });
      return ticket;
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
  }
  async capture(id: string, part: Part, expected: string, charged: bigint): Promise<BoundWriteProof> {
    const ticket = await this.inspect(id, part, expected, charged),
      entry = held.get(ticket)!;
    try {
      await this.sync();
      if ((await this.rootIdentity()) !== entry.rootHash) throw Error('MEDIA_BOUND_CHANGED');
      await this.close(ticket);
      const proof = Object.freeze({}) as BoundWriteProof;
      written.set(proof, { ...entry.description });
      return proof;
    } finally {
      await this.close(ticket);
    }
  }
  describe(ticket: object) {
    const item = held.get(ticket);
    return item && item.owner === this && !item.closed ? { ...item.description } : null;
  }
  async close(ticket: object) {
    const item = held.get(ticket);
    if (item?.owner === this && !item.closed) {
      item.closed = true;
      await item.file.close();
    }
  }
  private async sync() {
    const file = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async remove(ticket: object) {
    const item = held.get(ticket);
    if (!item || item.owner !== this || item.closed) throw Error('MEDIA_BOUND_TICKET');
    try {
      if ((await this.rootIdentity()) !== item.rootHash) throw Error('MEDIA_BOUND_CHANGED');
      const read = await this.readContent(
          item.file,
          item.description.part,
          item.description.contentHash,
          item.description.bytes,
          item.description.objectId
        ),
        pathStat = await lstat(item.path, { bigint: true });
      const stat = read.stat;
      if (
        stat.dev !== item.dev ||
        stat.ino !== item.ino ||
        pathStat.dev !== item.dev ||
        pathStat.ino !== item.ino ||
        pathStat.isSymbolicLink()
      )
        throw Error('MEDIA_BOUND_CHANGED');
      // Namespace is private, root-checked and UUID keys are never reused. lstat/unlink is NOT an atomic compare-and-delete primitive.
      await unlink(item.path);
      const gone = await item.file.stat({ bigint: true });
      if (gone.nlink !== 0n || gone.dev !== item.dev || gone.ino !== item.ino)
        throw Error('MEDIA_BOUND_UNLINK_UNCERTAIN');
      await this.sync();
      if ((await this.rootIdentity()) !== item.rootHash) throw Error('MEDIA_BOUND_CHANGED');
      await this.close(ticket);
      const proof = Object.freeze({});
      removed.set(proof, { ...item.description });
      return proof;
    } finally {
      await this.close(ticket).catch(() => undefined);
    }
  }
}
