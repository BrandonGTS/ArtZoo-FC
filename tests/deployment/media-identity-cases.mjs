import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Real tools-image proofs and SQL rows, in the disposable maintenance project only.
export function exerciseMediaIdentity({ root, bundle, invoke, pass, sql, docker, app }) {
  const image = readFileSync(join(bundle, 'images.tsv'), 'utf8')
    .split('\n')
    .find((s) => s.startsWith('tools'))
    .split(/\s+/)[1];
  const fixture = `
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { BoundNamespace, boundHash } = await import('/app/packages/media/dist/stock-bound-io.js');
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const rows = [];
    for (const [directory, kind, part, filename] of [
      ['original/daily', 'daily', 'photo-original', id+'.original'],
      ['derived/daily', 'daily', 'photo-preview', id+'.preview'],
      ['avatars', 'avatar', 'avatar-full', id+'.full.webp']
    ]) {
      const path = '/app/storage/'+directory;
      await mkdir(path, {recursive:true, mode:0o700});
      const bytes = Buffer.from('diagnostic-fixture');
      await writeFile(path+'/'+filename, bytes, {mode:0o600});
      const hash = createHash('sha256').update(bytes).digest('hex');
      const ns = new BoundNamespace(path, kind), ticket = await ns.inspect(id, part, hash, BigInt(bytes.length));
      rows.push({id: boundHash(['diagnostic-fixture', part]), sourceKind:'BASELINE', namespace:kind, objectKey:kind+':'+id, generation, part, policy:kind==='avatar'?'AVATAR_VARIANT':'PHOTO_VARIANT', chargedBytes:bytes.length, contentBindingSha256:hash, storageIdentityFingerprint:boundHash([generation, ns.describe(ticket).physicalFingerprint])});
      await ns.close(ticket);
    }
    console.log(JSON.stringify(rows));`;
  const mounts = ['original', 'derived', 'avatars'].flatMap((d) => [
    '--mount',
    `type=bind,src=${root}/media/${d},dst=/app/storage/${d}`
  ]);
  const seed = docker(
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '1000:1000',
    ...mounts,
    '--entrypoint',
    'node',
    image,
    '--input-type=module',
    '-e',
    fixture
  );
  assert.equal(seed.status, 0, 'real media proofs must be created');
  const rows = JSON.parse(seed.stdout);
  const baseline = sql('SELECT "baselineFingerprint" FROM "MediaBudgetState" WHERE id=\'global\';');
  for (const row of rows) {
    Object.assign(row, { baselineStateId: 'global', baselineFingerprint: baseline });
    const columns = Object.keys(row)
      .map((k) => `"${k}"`)
      .join(',');
    const values = Object.values(row)
      .map((v) => `'${String(v).replaceAll("'", "''")}'`)
      .join(',');
    sql(`INSERT INTO "MediaStoredComponent" (${columns},"createdAt") VALUES (${values},now());`);
  }
  const snapshot = () => sql('SELECT row_to_json(c)::text FROM "MediaStoredComponent" c ORDER BY id;');
  const before = snapshot();
  const check = (status) => {
    const result = invoke('media-identity');
    assert.equal(result.status, status, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /SyntheticPrivateSms|Synthetic-test-only/);
    assert.equal(snapshot(), before, 'diagnostic must never change stored identities');
    return JSON.parse(result.stdout.split('\n').find((s) => s.startsWith('{')));
  };
  assert.equal(check(0).components.consistent, 3);
  assert.equal(docker('restart', app('web'), app('worker')).status, 0);
  pass('start');
  assert.equal(check(0).components.consistent, 3, 'container restart preserves identities');
  const file = join(root, 'media/original/daily/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.original');
  const bytes = readFileSync(file);
  writeFileSync(file, 'changed-content');
  assert.equal(check(2).directories['original/daily'].unchecked, 1);
  writeFileSync(file, bytes);
  assert.equal(check(0).components.consistent, 3);
  const backups = join(root, 'identity-backups');
  pass('backup', ['--backup-dir', backups]);
  const backup = join(
    backups,
    readdirSync(backups).find((name) => name.startsWith('backup-'))
  );
  // Keep original inodes allocated outside the media tree, so restore cannot reuse them.
  const held = join(root, 'identity-held');
  mkdirSync(held, { mode: 0o700 });
  pass('stop');
  for (const directory of ['original', 'derived', 'avatars']) {
    mkdirSync(join(held, directory), { mode: 0o700 });
    for (const name of readdirSync(join(root, 'media', directory)))
      renameSync(join(root, 'media', directory, name), join(held, directory, name));
  }
  pass('start');
  pass('restore', ['--backup-dir', backups, '--backup', backup]);
  const restored = check(2);
  assert.equal(restored.components.inconsistent, 3);
  assert.equal(restored.baseline.consistent, 1);
  for (const directory of ['original/daily', 'derived/daily', 'avatars'])
    assert.equal(restored.directories[directory].inconsistent, 1);
  console.log(
    'MEDIA IDENTITY: container restart 3 consistent; restore 3 inconsistent, baseline consistent; read-only verified.'
  );
  // Restore the exact original fixture directories and remove only synthetic ledger rows.
  pass('stop');
  for (const directory of ['original', 'derived', 'avatars']) {
    for (const name of readdirSync(join(root, 'media', directory)))
      rmSync(join(root, 'media', directory, name), { recursive: true });
    for (const name of readdirSync(join(held, directory)))
      renameSync(join(held, directory, name), join(root, 'media', directory, name));
  }
  pass('start');
  sql(`DELETE FROM "MediaStoredComponent" WHERE id IN (${rows.map((row) => `'${row.id}'`).join(',')});`);
}
