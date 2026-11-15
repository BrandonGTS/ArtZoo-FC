import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BoundNamespace, boundHash } from '../../packages/media/dist/stock-bound-io.js';
import { locateComponent } from '../../packages/media/dist/stock-location.js';

// Synthetic content, real IO proofs and constrained SQL rows, only in disposable test databases.
export async function seedRegistration(
  db,
  roots,
  scopes = [
    'daily',
    'wish',
    'lottery-image',
    'knowledge',
    'album-comment',
    'album-photo',
    'official-image',
    'avatar',
    'quick-icon-manual'
  ]
) {
  const now = new Date(),
    files = [],
    rows = [];
  const account = await db.account.create({
    data: {
      phone: randomUUID(),
      membership: 'MEMBER',
      adminRole: 'NONE',
      passwordHash: 'SYNTHETIC-NONLOGIN',
      displayName: 'fixture'
    }
  });
  let albumPhoto;
  for (const scope of scopes) {
    const id = randomUUID(),
      generation = randomUUID(),
      key = randomUUID();
    const parts =
      scope === 'avatar'
        ? ['avatar-full', 'avatar-small']
        : scope.startsWith('quick-icon')
          ? ['quick-icon-bytea']
          : ['original', 'preview', 'thumbnail'].map(
              (v) => (scope === 'official-image' ? 'official-' : 'photo-') + v
            );
    if (scope === 'knowledge') parts.push('knowledge-journal');
    const objectKey =
      scope === 'lottery-image'
        ? `lottery:${account.id}:${id}`
        : (scope === 'official-image' ? 'official' : scope) + ':' + id;
    const components = [];
    for (const part of parts) {
      const journal =
        JSON.stringify({
          schemaVersion: 1,
          state: 'prepared',
          imageId: id,
          digest: 'a'.repeat(64),
          variants: ['original', 'preview', 'thumbnail'].map((variant) => ({ variant, bytes: 128 }))
        }) + '\n';
      const bytes = part === 'knowledge-journal' ? Buffer.from(journal) : Buffer.alloc(128, 42);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const row = {
        id: boundHash(['media-component-v1', scope, objectKey, generation, part]),
        sourceKind: 'RECEIPT',
        receiptScope: scope,
        receiptOperationKey: key,
        namespace: scope,
        objectKey,
        generation,
        part,
        policy:
          part === 'knowledge-journal'
            ? 'KNOWLEDGE_JOURNAL'
            : scope === 'avatar'
              ? 'AVATAR_VARIANT'
              : scope === 'official-image'
                ? 'OFFICIAL_VARIANT'
                : part === 'quick-icon-bytea'
                  ? 'QUICK_LINK_BYTEA'
                  : 'PHOTO_VARIANT',
        chargedBytes: BigInt(bytes.length),
        contentBindingSha256: hash,
        storageIdentityFingerprint: null,
        createdAt: now
      };
      const target = locateComponent(row);
      if (target) {
        const [base, ...tail] = target.directory.split('/');
        const directory = join(roots[['original', 'derived', 'avatars'].indexOf(base)], ...tail);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const filename =
          part === 'knowledge-journal'
            ? id + '.jsonl'
            : scope === 'avatar'
              ? id + '.' + part.slice(7) + '.webp'
              : id + '.' + part.split('-').at(-1);
        const path = join(directory, filename);
        await writeFile(path, bytes, { mode: 0o600 });
        files.push(path);
        const ns = new BoundNamespace(directory, target.kind),
          ticket = await ns.inspect(id, part, hash, row.chargedBytes);
        row.storageIdentityFingerprint = boundHash([generation, ns.describe(ticket).physicalFingerprint]);
        await ns.close(ticket);
      }
      components.push(row);
      rows.push(row);
    }
    await db.mediaUploadReceipt.create({
      data: {
        scope,
        operationKey: key,
        fingerprint: 'a'.repeat(64),
        accountId: account.id,
        day: '2026-11-15',
        rawBytes: 128n,
        storedBytes: components.reduce((n, c) => n + c.chargedBytes, 0n),
        state: 'COMMITTED',
        attemptId: generation,
        objectIdentity: objectKey,
        storageReservedAt: now,
        persistenceStartedAt: now,
        settledAt: now,
        createdAt: now,
        updatedAt: now
      }
    });
    await db.mediaStoredComponent.createMany({ data: components });
    if (scope === 'album-photo') {
      const album = await db.album.create({
        data: { creatorId: account.id, name: 'fixture', primary: 'DAILY', uploadMode: 'AUTHOR' }
      });
      albumPhoto = await db.albumPhoto.create({
        data: {
          id,
          albumId: album.id,
          uploaderId: account.id,
          batchId: randomUUID(),
          batchIndex: 0,
          digest: 'a'.repeat(64),
          originalName: 'fixture.webp',
          bytes: 128,
          mime: 'image/webp',
          width: 1,
          height: 1,
          frames: 1
        }
      });
    }
  }
  await db.mediaBudgetState.update({
    where: { id: 'global' },
    data: { committedBytes: { increment: rows.reduce((n, c) => n + c.chargedBytes, 0n) } }
  });
  return { files, rows, albumPhoto };
}
