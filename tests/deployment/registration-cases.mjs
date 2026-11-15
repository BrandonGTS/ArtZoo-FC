import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export function exerciseRegistration({ root, pass, invoke, sql, docker, app, compose }) {
  const helper = fileURLToPath(new URL('./registration-fixture.mjs', import.meta.url));
  const tool = (code) => {
    const result = compose(
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--volume',
      helper + ':/app/tests/deployment/registration-fixture.mjs:ro',
      '--entrypoint',
      'node',
      'tools',
      '--input-type=module',
      '-e',
      `
      const {getDatabase,disconnectDatabase}=await import('/app/packages/db/dist/index.js');
      const db=getDatabase();try{${code}}finally{await disconnectDatabase();}`
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  // The older lifecycle check deliberately left an unallocated 64-byte scalar counter.
  sql('UPDATE "MediaBudgetState" SET "committedBytes"=0;');
  const fixture = JSON.parse(
    tool(`const {seedRegistration}=await import('/app/tests/deployment/registration-fixture.mjs');
    const f=await seedRegistration(db,['/app/storage/original','/app/storage/derived','/app/storage/avatars'],['album-photo']);
    console.log(JSON.stringify({files:f.files,photo:f.albumPhoto}));`)
  );
  const path = fixture.files[0].replace('/app/storage', root + '/media');
  const snapshot = () =>
    sql(`SELECT jsonb_build_array(
    (SELECT jsonb_agg(s) FROM "MediaBudgetState" s),
    (SELECT jsonb_agg(c ORDER BY id) FROM "MediaStoredComponent" c),
    (SELECT jsonb_agg(i ORDER BY id) FROM "MediaRetirementIntent" i),
    (SELECT jsonb_agg(c ORDER BY "componentId") FROM "MediaStorageCredit" c));`);
  const check = () =>
    JSON.parse(
      pass('media-identity')
        .stdout.split('\n')
        .find((s) => s.startsWith('{'))
    );
  const stopped = () => {
    for (const s of ['web', 'worker'])
      assert.equal(docker('inspect', '--format', '{{.State.Running}}', app(s)).stdout.trim(), 'false');
  };
  const backups = join(root, 'registration-backups');
  pass('backup', ['--backup-dir', backups]);
  const saved = join(
    backups,
    readdirSync(backups).find((n) => n.startsWith('backup-'))
  );
  for (const file of fixture.files) {
    const p = file.replace('/app/storage', root + '/media');
    renameSync(p, join(root, p.split('/').at(-1) + '.held'));
  }
  pass('restore', ['--backup-dir', backups, '--backup', saved, '--keep-stopped', 'true']);
  stopped();
  assert.equal(invoke('start').status, 1);
  pass('media-reregister', ['--backup-dir', backups]);
  stopped();
  assert.equal(check().components.consistent, 3);
  pass('start');
  const before = snapshot(),
    bytes = readFileSync(path);
  writeFileSync(path, Buffer.alloc(bytes.length, 43));
  const refused = invoke('media-reregister', ['--backup-dir', backups]);
  assert.equal(refused.status, 1);
  assert.doesNotMatch(refused.stdout + refused.stderr, /SyntheticPrivateSms|Synthetic-test-only/);
  stopped();
  assert.equal(snapshot(), before);
  assert.equal(invoke('start').status, 1);
  assert.ok(readdirSync(backups).filter((n) => n.startsWith('register-')).length >= 2);
  writeFileSync(path, bytes);
  pass('media-reregister', ['--backup-dir', backups]);
  pass('status');
  assert.equal(check().components.consistent, 3);
  const p = fixture.photo;
  tool(`const {BoundNamespace,prepareAlbumPhotoRemoval,retireAlbumPhotoRemovals}=await import('/app/packages/media/dist/stock-retirement.js');
    const p=${JSON.stringify({ id: p.id, albumId: p.albumId })};
    await db.albumPhoto.update({where:{id:p.id},data:{removedAt:new Date()}});
    await db.$transaction(tx=>prepareAlbumPhotoRemoval(tx,p.id,p.albumId));
    const ns={original:new BoundNamespace('/app/storage/original/albums','album-photo'),derived:new BoundNamespace('/app/storage/derived/albums','album-photo')};
    for(let i=0;i<2;i++)if((await retireAlbumPhotoRemovals(db,ns,[p.id],()=>new Date())).status!=='complete')throw Error('DELETE_FAILED');`);
  assert.equal(sql('SELECT "creditedBytes" FROM "MediaBudgetState";'), '384');
  const history = snapshot();
  pass('media-reregister', ['--backup-dir', backups]);
  assert.equal(snapshot(), history);
  assert.equal(check().skippedCredited, 3);
  console.log(
    'MEDIA REGISTER: real restore -> register 3 consistent; changed content refused atomically, start blocked, recovery succeeds; deletion credited 384 bytes once; history preserved.'
  );
}
