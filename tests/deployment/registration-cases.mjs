import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from 'node:fs';
import { recoveryFixture } from './recovery-fixture.mjs';
import { join } from 'node:path';

export function exerciseRegistration({ root, pass, invoke, sql, docker, app, compose }) {
  const { seed, remove } = recoveryFixture({ compose, sql });
  // The older lifecycle check deliberately left an unallocated 64-byte scalar counter.
  sql('UPDATE "MediaBudgetState" SET "committedBytes"=0;');
  const fixture = seed();
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
  const mark = join(root, 'deploy/media-registration.pending');
  for (const mode of ['running', 'stopped']) {
    if (mode === 'stopped') assert.equal(docker('stop', app('web'), app('worker')).status, 0);
    const restored = pass('restore', ['--backup-dir', backups, '--backup', saved]);
    assert.match(
      restored.stdout,
      /bash .* media-reregister --bundle .* --root .* --project .* --backup-dir /
    );
    stopped();
    assert.equal(readFileSync(mark, 'utf8'), mode + '\n');
    assert.equal(invoke('start').status, 1);
    pass('media-reregister', ['--backup-dir', backups]);
    assert.equal(existsSync(mark), false);
    if (mode === 'stopped') {
      stopped();
      pass('start');
    }
    pass('status');
    assert.equal(check().components.consistent, 3);
    if (mode === 'running') remove(fixture.photo);
    console.log(`PASS: restore from ${mode}, registration state preserved`);
  }
  for (const file of fixture.files) {
    const p = file.replace('/app/storage', root + '/media');
    renameSync(p, join(root, p.split('/').at(-1) + '.held'));
  }
  pass('restore', ['--backup-dir', backups, '--backup', saved, '--keep-stopped', 'true']);
  stopped();
  assert.equal(readFileSync(mark, 'utf8'), 'stopped\n');
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
  remove(fixture.photo);
  assert.equal(sql('SELECT "creditedBytes" FROM "MediaBudgetState";'), '384');
  const history = snapshot();
  pass('media-reregister', ['--backup-dir', backups]);
  assert.equal(snapshot(), history);
  assert.equal(check().skippedCredited, 3);
  console.log(
    'MEDIA REGISTER: real restore -> register 3 consistent; changed content refused atomically, start blocked, recovery succeeds; deletion credited 384 bytes once; history preserved.'
  );
}
