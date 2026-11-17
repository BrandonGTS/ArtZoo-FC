import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Exercise real content proofs and retirement twice, only in the disposable project.
export function recoveryFixture({ compose, sql }) {
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
      `const {getDatabase,disconnectDatabase}=await import('/app/packages/db/dist/index.js');
      const db=getDatabase();try{${code}}finally{await disconnectDatabase();}`
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const seed = () =>
    JSON.parse(
      tool(`
    const {seedRegistration}=await import('/app/tests/deployment/registration-fixture.mjs');
    const f=await seedRegistration(db,['/app/storage/original','/app/storage/derived','/app/storage/avatars'],['album-photo']);
    console.log(JSON.stringify({files:f.files,photo:f.albumPhoto}));`)
    );
  const remove = (photo) => {
    const before = BigInt(sql('SELECT "creditedBytes" FROM "MediaBudgetState";'));
    tool(`const {BoundNamespace,prepareAlbumPhotoRemoval,retireAlbumPhotoRemovals}=await import('/app/packages/media/dist/stock-retirement.js');
      const p=${JSON.stringify({ id: photo.id, albumId: photo.albumId })};
      await db.albumPhoto.update({where:{id:p.id},data:{removedAt:new Date()}});
      await db.$transaction(tx=>prepareAlbumPhotoRemoval(tx,p.id,p.albumId));
      const ns={original:new BoundNamespace('/app/storage/original/albums','album-photo'),derived:new BoundNamespace('/app/storage/derived/albums','album-photo')};
      for(let i=0;i<2;i++)if((await retireAlbumPhotoRemovals(db,ns,[p.id],()=>new Date())).status!=='complete')throw Error('DELETE_FAILED');`);
    assert.equal(BigInt(sql('SELECT "creditedBytes" FROM "MediaBudgetState";')), before + 384n);
    assert.equal(
      sql(`SELECT count(*) FROM "MediaStorageCredit" WHERE "componentId" IN
      (SELECT id FROM "MediaStoredComponent" WHERE "objectKey"='album-photo:${photo.id}');`),
      '3'
    );
  };
  return { tool, seed, remove };
}
