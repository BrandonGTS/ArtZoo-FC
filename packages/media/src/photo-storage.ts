import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, link, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMemberId } from '@artzoo/domain';
import type { PhotoOutput } from './photo-processor.js';
import { PHOTO_RULES } from './photo-contract.js';
import { BoundNamespace, type MediaRetirementNamespace } from './stock-bound-io.js';
export type PhotoVariant = 'original' | 'preview' | 'thumbnail';
type BoundPart = Parameters<MediaRetirementNamespace['capture']>[1];
/** Write proofs for one storage directory may only name the parts that directory holds. */
export function restrictedWriteNamespace(
  namespace: MediaRetirementNamespace,
  parts: readonly BoundPart[]
): import('./media-write.js').MediaWriteNamespace {
  return Object.freeze({
    capture: async (id: string, part: BoundPart, hash: string, bytes: bigint) => {
      if (!parts.includes(part)) throw Error('MEDIA_BOUND_SCOPE');
      return namespace.capture(id, part, hash, bytes);
    }
  });
}
export interface PhotoStorage {
  writePhotoNamespaces?(
    scope: 'daily' | 'wish' | 'lottery-image' | 'knowledge' | 'album-comment' | 'album-photo'
  ): Promise<{
    original: import('./media-write.js').MediaWriteNamespace;
    derived: import('./media-write.js').MediaWriteNamespace;
  }>;
  writeNamespaces?(): Promise<{
    original: import('./media-write.js').MediaWriteNamespace;
    derived: import('./media-write.js').MediaWriteNamespace;
  }>;
  boundPhotoNamespaces?(
    scope: 'daily' | 'wish' | 'lottery-image' | 'knowledge' | 'album-comment' | 'album-photo'
  ): Promise<{ original: MediaRetirementNamespace; derived: MediaRetirementNamespace }>;
  boundNamespaces?(): Promise<{ original: MediaRetirementNamespace; derived: MediaRetirementNamespace }>;
  put(id: string, output: PhotoOutput): Promise<void>;
  read(id: string, variant: PhotoVariant): Promise<Buffer>;
  discardUncommitted(id: string): Promise<void>;
  /** Removes the three files of a photo whose record is already deleted. Idempotent. */
  removeDeleted?(id: string): Promise<void>;
  /** True while any of the three files still exists. */
  storedExists?(id: string): Promise<boolean>;
}
async function safeDirectory(value: string) {
  if (!isAbsolute(value)) throw new Error('Photo directory must be absolute');
  const directory = resolve(/* turbopackIgnore: true */ value);
  let current = '/';
  for (const part of directory.split('/').filter(Boolean)) {
    current = join(/* turbopackIgnore: true */ current, part);
    await mkdir(current, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe photo directory');
  }
  if ((await realpath(directory)) !== directory) throw new Error('Unsafe photo directory');
  return directory;
}
function defaults() {
  const cwd = resolve(/* turbopackIgnore: true */ process.cwd());
  return join(
    /* turbopackIgnore: true */ cwd.endsWith('/apps/web') ? dirname(dirname(cwd)) : cwd,
    '.local',
    'photo-media'
  );
}
export class LocalPhotoStorage implements PhotoStorage {
  constructor(
    private readonly originalDirectory = process.env.ARTZOO_MEDIA_ORIGINAL_DIR ??
      (process.env.NODE_ENV === 'production'
        ? '/app/storage/original/photos'
        : join(/* turbopackIgnore: true */ defaults(), 'original')),
    private readonly derivedDirectory = process.env.ARTZOO_MEDIA_DERIVED_DIR ??
      (process.env.NODE_ENV === 'production'
        ? '/app/storage/derived/photos'
        : join(/* turbopackIgnore: true */ defaults(), 'derived'))
  ) {}
  async boundNamespaces() {
    return {
      original: new BoundNamespace(await safeDirectory(this.originalDirectory), 'official'),
      derived: new BoundNamespace(await safeDirectory(this.derivedDirectory), 'official')
    };
  }
  async boundPhotoNamespaces(
    scope: 'daily' | 'wish' | 'lottery-image' | 'knowledge' | 'album-comment' | 'album-photo'
  ) {
    if (
      scope !== 'daily' &&
      scope !== 'wish' &&
      scope !== 'lottery-image' &&
      scope !== 'knowledge' &&
      scope !== 'album-comment' &&
      scope !== 'album-photo'
    )
      throw Error('MEDIA_BOUND_SCOPE');
    return {
      original: new BoundNamespace(await safeDirectory(this.originalDirectory), scope),
      derived: new BoundNamespace(await safeDirectory(this.derivedDirectory), scope)
    };
  }
  async writePhotoNamespaces(
    scope: 'daily' | 'wish' | 'lottery-image' | 'knowledge' | 'album-comment' | 'album-photo'
  ) {
    const bound = await this.boundPhotoNamespaces(scope);
    return {
      original: restrictedWriteNamespace(bound.original, ['photo-original']),
      derived: restrictedWriteNamespace(bound.derived, ['photo-preview', 'photo-thumbnail'])
    };
  }
  async writeNamespaces() {
    const bound = await this.boundNamespaces();
    return {
      original: restrictedWriteNamespace(bound.original, ['official-original']),
      derived: restrictedWriteNamespace(bound.derived, ['official-preview', 'official-thumbnail'])
    };
  }
  private async path(id: string, variant: PhotoVariant) {
    if (!isMemberId(id) || !['original', 'preview', 'thumbnail'].includes(variant))
      throw new Error('Invalid photo key');
    return join(
      /* turbopackIgnore: true */ await safeDirectory(
        variant === 'original' ? this.originalDirectory : this.derivedDirectory
      ),
      `${id.toLowerCase()}.${variant}`
    );
  }
  async put(id: string, output: PhotoOutput) {
    const created: string[] = [];
    try {
      for (const variant of ['original', 'preview', 'thumbnail'] as const) {
        const target = await this.path(id, variant),
          temp = `${target}.${randomUUID()}.tmp`;
        const file = await open(
          temp,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600
        );
        try {
          await file.writeFile(output[variant]);
          await file.sync();
          await file.close();
          await link(temp, target);
          created.push(target);
        } finally {
          await file.close().catch(() => undefined);
          await unlink(temp).catch(() => undefined);
        }
      }
    } catch (error) {
      for (const path of created) await unlink(path).catch(() => undefined);
      throw error;
    }
  }
  async read(id: string, variant: PhotoVariant) {
    const file = await open(await this.path(id, variant), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > (variant === 'original' ? PHOTO_RULES.maxBytes : PHOTO_RULES.maxBytes * 2)
      )
        throw new Error('Unsafe photo object');
      return await file.readFile();
    } finally {
      await file.close();
    }
  }
  // A proven uncommitted upload, or (via removeDeleted) a photo whose record is already deleted.
  async discardUncommitted(id: string) {
    for (const variant of ['original', 'preview', 'thumbnail'] as const) {
      const path = await this.path(id, variant);
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw new Error('Unsafe photo object');
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  async removeDeleted(id: string) {
    await this.discardUncommitted(id);
  }
  async storedExists(id: string) {
    for (const variant of ['original', 'preview', 'thumbnail'] as const) {
      try {
        await lstat(await this.path(id, variant));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return false;
  }
}
