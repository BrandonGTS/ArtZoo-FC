import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';

// Invoked inside the real packaged lifecycle fixture, after its application is healthy.
export function exerciseBackups({ root, pass, invoke, sql, docker, app, run, args, config }) {
  const store = join(root, 'backup-store');
  const options = ['--backup-dir', store, '--keep', '2'];
  const snapshots = (prefix = 'backup-') =>
    readdirSync(store)
      .filter((n) => n.startsWith(prefix))
      .sort();
  const media = join(root, 'media');
  const image = join(media, 'original', 'fixture.png');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
    'base64'
  );
  for (const directory of ['original', 'derived', 'avatars']) {
    writeFileSync(join(media, directory, 'fixture.png'), png, { mode: 0o600 });
  }
  sql("CREATE TABLE backup_probe (value text); INSERT INTO backup_probe VALUES ('before');");
  const secretConfig = readFileSync(config);
  const cleanOutput = (result) => {
    assert.doesNotMatch(result.stdout + result.stderr, /SyntheticPrivateSms|Synthetic-test-only/);
    return result;
  };
  cleanOutput(pass('backup', options));
  const original = join(store, snapshots()[0]);
  const verify = ['--backup', original];
  pass('backup-verify', verify);
  assert.deepEqual(readdirSync(original).sort(), [
    'database.dump',
    'manifest',
    'media.tar',
    'migrations.txt'
  ]);
  assert.ok(readFileSync(join(original, 'migrations.txt'), 'utf8').trim().length > 0);
  assert.ok(readFileSync(join(original, 'manifest'), 'utf8').includes('file '));
  assert.equal(statSync(original).mode & 0o777, 0o700);
  const manifest = readFileSync(join(original, 'manifest'), 'utf8');
  const archive = readFileSync(join(original, 'media.tar'));
  const sourceHash = createHash('sha256').update(archive).digest('hex');
  const rejected = () => {
    const result = cleanOutput(invoke('restore', [...options, ...verify]));
    assert.notEqual(result.status, 0, 'invalid backup must be refused');
    pass('status');
    assert.deepEqual(readFileSync(image), png);
    assert.equal(sql('SELECT value FROM backup_probe;'), 'before');
    assert.equal(snapshots('rescue-').length, 0, 'rejection precedes stopping/saving');
  };
  writeFileSync(join(original, 'media.tar'), Buffer.concat([archive, Buffer.from('corrupt')]));
  rejected();
  writeFileSync(join(original, 'media.tar'), archive);
  writeFileSync(
    join(original, 'manifest'),
    manifest.replace(/release \S+/, 'release git-aaaaaaaaaaaa-20000101000000-1')
  );
  rejected();
  writeFileSync(join(original, 'manifest'), manifest);
  rmSync(join(original, 'media.tar'));
  symlinkSync(image, join(original, 'media.tar'));
  rejected();
  rmSync(join(original, 'media.tar'));
  writeFileSync(join(original, 'media.tar'), archive);
  const badArchive = join(root, 'unsafe-media');
  mkdirSync(badArchive, { mode: 0o700 });
  for (const directory of ['original', 'derived', 'avatars'])
    mkdirSync(join(badArchive, directory), { mode: 0o700 });
  symlinkSync('../../secrets/compose.env', join(badArchive, 'original', 'escape'));
  // A correctly checksummed archive still must not carry links outside media.
  const makeUnsafe = docker(
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '1000:1000',
    '--mount',
    `type=bind,src=${badArchive},dst=/input,readonly`,
    '--mount',
    `type=bind,src=${original},dst=/output`,
    '--entrypoint',
    'tar',
    'postgres:17.11-bookworm',
    '-cf',
    '/output/media.tar',
    '-C',
    '/input',
    'original',
    'derived',
    'avatars'
  );
  assert.equal(makeUnsafe.status, 0, 'prepare unsafe tar fixture');
  const unsafe = readFileSync(join(original, 'media.tar'));
  writeFileSync(
    join(original, 'manifest'),
    manifest.replace(
      /file [a-f0-9]{64} \d+ media.tar/,
      `file ${createHash('sha256').update(unsafe).digest('hex')} ${unsafe.length} media.tar`
    )
  );
  rejected();
  writeFileSync(join(original, 'media.tar'), archive);
  writeFileSync(join(original, 'manifest'), manifest);

  // Fail tar only after real pg_dump has run and the application has stopped.
  const bin = join(root, 'fault-bin');
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(
    join(bin, 'tar'),
    '#!/bin/bash\nif [[ "$1" == --create ]]; then exit 77; fi\nexec /usr/bin/tar "$@"\n',
    { mode: 0o700 }
  );
  const injected = (command, extra = []) =>
    cleanOutput(
      run([command, ...args, ...options, ...extra], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
      })
    );
  assert.notEqual(injected('backup').status, 0);
  assert.equal(snapshots().length, 1);
  assert.ok(snapshots('.partial.').some((n) => statSync(join(store, n, 'database.dump')).size > 0));
  pass('status');
  assert.equal(
    createHash('sha256')
      .update(readFileSync(join(original, 'media.tar')))
      .digest('hex'),
    sourceHash
  );
  rmSync(join(bin, 'tar'));
  chmodSync(store, 0o500);
  assert.notEqual(cleanOutput(invoke('backup', options)).status, 0);
  chmodSync(store, 0o700);
  pass('status');
  sql("UPDATE backup_probe SET value='after'; CREATE TABLE backup_extra (id int);");
  writeFileSync(image, 'changed');
  writeFileSync(join(media, 'original', 'new.png'), png);

  // A real SQL error rolls back the database transaction and leaves the app stopped.
  writeFileSync(
    join(bin, 'docker'),
    '#!/bin/bash\n/usr/bin/docker "$@"\nresult=$?\nif [[ "$*" == *"--entrypoint pg_restore"* && "$*" != *"--list"* && "$result" == 0 ]]; then echo "SELECT 1/0;"; fi\nexit "$result"\n',
    { mode: 0o700 }
  );
  const failedRestore = injected('restore', verify);
  assert.notEqual(failedRestore.status, 0);
  assert.match(failedRestore.stderr, /数据库恢复失败，数据库事务已回滚/);
  assert.equal(sql('SELECT value FROM backup_probe;'), 'after');
  for (const service of ['web', 'worker']) {
    assert.equal(docker('inspect', '--format', '{{.State.Running}}', app(service)).stdout.trim(), 'false');
  }
  assert.equal(snapshots('rescue-').length, 1);
  rmSync(join(bin, 'docker'));
  cleanOutput(pass('restore', [...options, ...verify]));
  assert.equal(sql('SELECT value FROM backup_probe;'), 'before');
  assert.equal(sql("SELECT count(*) FROM information_schema.tables WHERE table_name='backup_extra';"), '0');
  for (const directory of ['original', 'derived', 'avatars']) {
    const file = join(media, directory, 'fixture.png');
    assert.deepEqual(readFileSync(file), png);
    assert.equal(statSync(file).uid, 1000);
    assert.equal(statSync(file).gid, 1000);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(existsSync(join(media, 'original', 'new.png')), false);
  assert.deepEqual(readFileSync(config), secretConfig, 'secret configuration is never restored');
  const rescue = join(store, snapshots('rescue-').at(-1));
  cleanOutput(pass('restore', [...options, '--backup', rescue]));
  assert.equal(sql('SELECT value FROM backup_probe;'), 'after', 'automatic rescue is usable');
  assert.equal(readFileSync(image, 'utf8'), 'changed');
  pass('backup', options);
  pass('backup', options);
  assert.equal(snapshots().length, 2);
  assert.equal(existsSync(original), false, 'oldest successful backup pruned only after new success');
  pass('backup', ['--backup-dir', store, '--keep', '1']);
  assert.equal(snapshots().length, 1);
  assert.equal(snapshots('rescue-').length, 3, 'rescue copies never automatically pruned');
  pass('backup-verify', ['--backup', join(store, snapshots()[0])]);
  pass('status');
  writeFileSync(join(bin, 'date'), '#!/bin/bash\nprintf "20000101T000000000000000\\n"\n', { mode: 0o700 });
  assert.equal(injected('backup', ['--keep', '1']).status, 0);
  assert.equal(snapshots().length, 1);
  assert.ok(snapshots()[0].startsWith('backup-20000101T000000000000000-'));
  rmSync(join(bin, 'date'));
  pass('backup-verify', ['--backup', join(store, snapshots()[0])]);
  console.log(
    'PASS: real backup/restore, archive rejection, restart on backup failure, transactional restore failure, rescue and retention'
  );
}
