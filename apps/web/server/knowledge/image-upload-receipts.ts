import {
  encodeKnowledgeJournalPrepared,
  encodeKnowledgeJournalNote,
  KnowledgeJournalAllowance,
  type KnowledgeJournalBudgetQuote
} from './image-upload-journal-budget';
export { quoteKnowledgeUploadJournal } from './image-upload-journal-budget';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isMemberId } from '@artzoo/domain';
import type { PrismaClient } from '@artzoo/db';

type UploadState =
  'prepared' | 'files-written' | 'rollback-confirmed' | 'pending' | 'committed' | 'replayed' | 'discarded';
export interface KnowledgeUploadRecord {
  schemaVersion: 1;
  imageId: string;
  digest: string;
  variants: { variant: 'original' | 'preview' | 'thumbnail'; bytes: number }[];
}
type ReceiptIdentity = { dev: number; ino: number };
async function safeDirectory(value: string) {
  if (!isAbsolute(value)) throw new Error('Knowledge receipt directory must be absolute');
  const directory = resolve(/* turbopackIgnore: true */ value);
  let current = '/';
  for (const part of directory.split('/').filter(Boolean)) {
    current = join(/* turbopackIgnore: true */ current, part);
    await mkdir(current, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe knowledge receipt directory');
  }
  if ((await realpath(directory)) !== directory) throw new Error('Unsafe knowledge receipt directory');
  return directory;
}
function defaultDirectory() {
  const cwd = resolve(/* turbopackIgnore: true */ process.cwd()),
    base = join(
      /* turbopackIgnore: true */ cwd.endsWith('/apps/web') ? dirname(dirname(cwd)) : cwd,
      '.local',
      'knowledge-media',
      'original'
    );
  return join(
    /* turbopackIgnore: true */ process.env.ARTZOO_KNOWLEDGE_ORIGINAL_DIR ??
      (process.env.NODE_ENV === 'production' ? '/app/storage/original/knowledge' : base),
    '.upload-receipts'
  );
}
async function syncDirectory(directory: string) {
  const file = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
/** Internal, exact-object journal. It never enumerates media or stores session/account data. */
export class KnowledgeImageUploadReceipts {
  constructor(private readonly directory = defaultDirectory()) {}
  async boundNamespace() {
    const { BoundNamespace } = await import('@artzoo/media/stock-retirement');
    return new BoundNamespace(this.directory, 'knowledge');
  }
  private async path(imageId: string) {
    if (!isMemberId(imageId)) throw new Error('Invalid knowledge receipt key');
    return join(
      /* turbopackIgnore: true */ await safeDirectory(this.directory),
      imageId.toLowerCase() + '.jsonl'
    );
  }
  async create(record: KnowledgeUploadRecord, budget?: KnowledgeJournalBudgetQuote) {
    const prepared = budget ? encodeKnowledgeJournalPrepared(record) : null;
    const allowance = budget ? new KnowledgeJournalAllowance(budget, prepared!) : undefined;
    const path = await this.path(record.imageId),
      file = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600
      );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe knowledge receipt');
      await file.writeFile(prepared ?? encodeKnowledgeJournalPrepared(record));
      await file.sync();
      await syncDirectory(dirname(path));
      return new KnowledgeImageUploadReceipt(
        file,
        () => this.remove(record.imageId, { dev: stat.dev, ino: stat.ino }),
        allowance
      );
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
  }
  async inspect(imageId: string) {
    const file = await open(await this.path(imageId), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192) throw new Error('Unsafe knowledge receipt');
      const lines = (await file.readFile('utf8')).trim().split('\n'),
        record = JSON.parse(lines[0]!) as KnowledgeUploadRecord & { state: string };
      if (
        record.schemaVersion !== 1 ||
        record.imageId !== imageId ||
        !/^[a-f0-9]{64}$/.test(record.digest) ||
        record.state !== 'prepared' ||
        !Array.isArray(record.variants) ||
        record.variants.length !== 3 ||
        record.variants.some(
          (entry, index) =>
            entry.variant !== ['original', 'preview', 'thumbnail'][index] ||
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes <= 0
        )
      )
        throw new Error('Invalid knowledge receipt');
      // A partial final append remains pending; the durable first record identifies the exact object.
      return { record, identity: { dev: stat.dev, ino: stat.ino } };
    } finally {
      await file.close();
    }
  }
  async remove(imageId: string, identity: ReceiptIdentity) {
    const path = await this.path(imageId),
      stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino
    )
      throw new Error('Unsafe knowledge receipt');
    await unlink(path);
    await syncDirectory(dirname(path));
  }
}
class KnowledgeImageUploadReceipt {
  constructor(
    private readonly file: FileHandle,
    private readonly removeFile: () => Promise<void>,
    private readonly allowance?: KnowledgeJournalAllowance
  ) {}
  async note(state: UploadState) {
    await this.file.writeFile(
      this.allowance ? this.allowance.note(state) : encodeKnowledgeJournalNote(state)
    );
    await this.file.sync();
  }
  async close() {
    await this.file.close();
  }
  async remove() {
    await this.close();
    await this.removeFile();
  }
}
/** A missing row cannot establish rollback. Reconciliation only settles a proven committed receipt, retaining all media. */
export async function reconcileKnowledgeImageUpload(
  receipts: KnowledgeImageUploadReceipts,
  db: Pick<PrismaClient, 'knowledgeImage'>,
  imageId: string
) {
  const { record, identity } = await receipts.inspect(imageId),
    image = await db.knowledgeImage.findUnique({ where: { id: imageId } });
  if (!image || image.digest !== record.digest || image.bytes !== record.variants[0]!.bytes)
    return { imageId, state: 'pending' as const };
  await receipts.remove(imageId, identity);
  return { imageId, state: 'committed' as const };
}
