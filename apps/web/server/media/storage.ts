import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMemberId } from '@artzoo/domain';
import type { AvatarOutput } from './processor';

export type AvatarVariant = 'full' | 'small';
// A later object-storage adapter implements this interface; keys stay server-owned and reads stay authenticated.
export interface AvatarStorage {
  writeNamespace?(): Promise<import('@artzoo/media/stock-retirement').MediaWriteNamespace>;
  put(id: string, output: AvatarOutput): Promise<void>;
  read(id: string, variant: AvatarVariant): Promise<Buffer>;
  delete(id: string): Promise<void>;
  boundNamespace?(): Promise<import('@artzoo/media/stock-retirement').MediaRetirementNamespace>;
}
async function safeDirectory(directory: string): Promise<string> {
  const path = resolve(directory),
    root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe avatar storage directory');
  }
  if ((await realpath(path)) !== path) throw new Error('Unsafe avatar storage directory');
  return path;
}
function storageRoot(): string {
  if (process.env.ARTZOO_AVATAR_DIR) {
    if (!isAbsolute(process.env.ARTZOO_AVATAR_DIR))
      throw new Error('Avatar storage requires an absolute directory');
    return process.env.ARTZOO_AVATAR_DIR;
  }
  // pnpm/Next runs with apps/web as cwd; CLI tests can run from the repository root.
  // Runtime media are external data, never build-traced application assets.
  const cwd = resolve(/* turbopackIgnore: true */ process.cwd());
  return join(cwd.endsWith('/apps/web') ? dirname(dirname(cwd)) : cwd, '.local', 'avatars');
}
export class LocalAvatarStorage implements AvatarStorage {
  constructor(private readonly directory = storageRoot()) {}
  async boundNamespace() {
    const { BoundNamespace } = await import('@artzoo/media/stock-retirement');
    return new BoundNamespace(this.directory, 'avatar');
  }
  async writeNamespace() {
    const { restrictedWriteNamespace } = await import('@artzoo/media/photo-storage');
    return restrictedWriteNamespace(await this.boundNamespace(), ['avatar-full', 'avatar-small']);
  }
  private async path(id: string, variant: AvatarVariant): Promise<string> {
    if (!isMemberId(id) || !['full', 'small'].includes(variant))
      throw new Error('Invalid avatar storage key');
    return join(await safeDirectory(this.directory), `${id.toLowerCase()}.${variant}.webp`);
  }
  async put(id: string, output: AvatarOutput): Promise<void> {
    const created: string[] = [];
    try {
      for (const variant of ['full', 'small'] as const) {
        const target = await this.path(id, variant),
          temporary = `${target}.${randomUUID()}.tmp`;
        const file = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600
        );
        try {
          await file.writeFile(output[variant]);
          await file.sync();
          await file.close();
          // Hard-link publication is atomic and refuses to overwrite an existing asset.
          await link(temporary, target);
          created.push(target);
        } finally {
          await file.close().catch(() => undefined);
          await unlink(temporary).catch(() => undefined);
        }
      }
    } catch (error) {
      for (const path of created) await unlink(path).catch(() => undefined);
      throw error;
    }
  }
  async read(id: string, variant: AvatarVariant): Promise<Buffer> {
    const file = await open(await this.path(id, variant), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 2_000_000 || stat.nlink !== 1)
        throw new Error('Unsafe avatar object');
      return await file.readFile();
    } finally {
      await file.close();
    }
  }
  async delete(id: string): Promise<void> {
    for (const variant of ['full', 'small'] as const) {
      const path = await this.path(id, variant);
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw new Error('Unsafe avatar object');
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}
