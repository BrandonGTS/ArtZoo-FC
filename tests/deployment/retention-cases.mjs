import assert from 'node:assert/strict';
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  truncateSync
} from 'node:fs';
import { join } from 'node:path';

export function refuseLowSpace({ root, invoke, docker, app }, command, extra = []) {
  const directory = process.env.ARTZOO_LOW_SPACE_DIR;
  assert.ok(directory, 'real small tmpfs is required for the space preflight acceptance test');
  const states = () =>
    ['web', 'worker'].map((s) =>
      docker(
        'inspect',
        '--format',
        '{{.Id}}|{{.State.Running}}|{{.State.StartedAt}}|{{.State.FinishedAt}}',
        app(s)
      ).stdout.trim()
    );
  const before = states();
  const pointers = () =>
    ['current', 'previous', 'pending', 'media-registration.pending'].map((n) => {
      const path = join(root, 'deploy', n);
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    });
  const records = pointers();
  const result = invoke(command, [...extra, '--backup-dir', directory]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /备份空间不足：需要 \d+ 字节，剩余 \d+ 字节/);
  assert.deepEqual(states(), before, 'refusal must not stop, start or recreate either application');
  assert.deepEqual(pointers(), records, 'refusal must not create or replace maintenance markers');
  assert.deepEqual(readdirSync(directory), [], 'no partial snapshot is created');
  console.log(`PASS: ${command} rejected on real small tmpfs before changing application state or markers`);
}

export function exerciseRetention(context) {
  const { root, pass, invoke, docker, app, run, args } = context;
  const directory = join(root, 'retention-backups');
  const options = ['--backup-dir', directory];
  const names = (kind) =>
    readdirSync(directory)
      .filter((n) => n.startsWith(kind + '-'))
      .sort();
  const empty = pass('status', options);
  assert.match(empty.stdout, /backup：份数=0；最新时间=无/);
  assert.equal(existsSync(directory), false, 'status never creates a backup directory');
  for (const value of ['0', '100', '-1', 'x']) {
    assert.equal(invoke('media-reregister', [...options, '--keep-maintenance', value]).status, 1);
    assert.equal(existsSync(directory), false);
  }
  for (const option of ['--keep', '--keep-maintenance', '--backup']) {
    assert.equal(invoke('status', [option, '1']).status, 1);
  }
  for (let i = 0; i < 5; i++) pass('media-reregister', options);
  assert.equal(names('register').length, 3, 'five real registrations retain exactly three snapshots');
  const source = join(directory, names('register')[0]);
  const suffix = names('register')[0].split('-').slice(2).join('-');
  const clone = (name) => {
    const path = join(directory, name);
    cpSync(source, path, { recursive: true });
    chmodSync(path, 0o700);
    return path;
  };
  const saved = {};
  for (const kind of ['backup', 'upgrade', 'rescue']) {
    saved[kind] = [];
    for (let i = 1; i <= 5; i++) saved[kind].push(clone(`${kind}-2000010${i}T000000000000000-${suffix}`));
  }
  pass('backup-verify', ['--backup', saved.backup[0]]);
  const damaged = clone(`upgrade-19990101T000000000000000-${suffix}`);
  writeFileSync(
    join(damaged, 'manifest'),
    readFileSync(join(damaged, 'manifest'), 'utf8').replace(/file [a-f0-9]{64}/, 'file ' + '0'.repeat(64))
  );
  const foreign = clone(`rescue-19990101T000000000000000-${suffix}`);
  writeFileSync(
    join(foreign, 'manifest'),
    readFileSync(join(foreign, 'manifest'), 'utf8').replace(/project .+/, 'project foreign-project')
  );
  const otherImage = clone(`rescue-19980101T000000000000000-${suffix}`);
  writeFileSync(
    join(otherImage, 'manifest'),
    readFileSync(join(otherImage, 'manifest'), 'utf8').replace(
      /postgres .+/,
      'postgres sha256:' + 'f'.repeat(64)
    )
  );
  const unknown = clone('upgrade-unknown');
  const partial = join(directory, '.partial.fixture');
  mkdirSync(partial, { mode: 0o700 });
  mkdirSync(join(directory, 'operator-notes'), { mode: 0o700 });
  const current = readFileSync(join(root, 'deploy/current'), 'utf8').trim().split(' ');
  const previous = join(root, 'deploy/previous');
  assert.equal(existsSync(previous), false);
  writeFileSync(previous, `${current[0]} ${current[1]} ${saved.upgrade[0]} ${current[2]}\n`, { mode: 0o600 });
  pass('media-reregister', [...options, '--keep', '2', '--keep-maintenance', '2']);
  assert.equal(names('register').length, 2);
  assert.equal(names('backup').length, 2);
  assert.equal(names('upgrade').length, 5, 'two recent + previous + damaged + unknown');
  assert.equal(names('rescue').length, 4, 'two recent + foreign project + other PostgreSQL image');
  for (const path of [
    saved.upgrade[0],
    saved.upgrade[4],
    saved.rescue[4],
    damaged,
    foreign,
    otherImage,
    unknown,
    partial
  ])
    assert.ok(existsSync(path), path);
  const status = pass('status', options);
  assert.match(status.stdout, /警告：最新 backup 备份已超过 36 小时/);
  assert.match(status.stdout, /upgrade：份数=5/);
  assert.match(status.stdout, /\.partial\.\*：数量=1；其他目录=1/);
  rmSync(previous);
  // A larger allowance cannot recreate snapshots already removed; a smaller one prunes each class.
  pass('backup', [...options, '--keep', '1', '--keep-maintenance', '1']);
  assert.equal(names('backup').length, 1);
  assert.equal(names('register').length, 1);
  assert.equal(existsSync(saved.upgrade[0]), false, 'released previous protection is pruned');
  assert.equal(names('upgrade').length, 3);
  assert.equal(names('rescue').length, 3);
  const snapshot = join(directory, names('backup')[0]);
  for (const command of ['backup', 'media-reregister', 'restore']) {
    refuseLowSpace(context, command, command === 'restore' ? ['--backup', snapshot] : []);
  }
  // Apparent bytes must account for sparse files that tar would materialize.
  const sparse = join(root, 'media/original/space-probe');
  writeFileSync(sparse, '');
  truncateSync(sparse, 24 * 1024 * 1024);
  const low = pass('status', ['--backup-dir', process.env.ARTZOO_LOW_SPACE_DIR]);
  assert.match(low.stdout, /警告：剩余空间低于下次备份估算值的 2 倍/);
  rmSync(sparse);
  const bin = join(root, 'statistics-fault');
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(join(bin, 'df'), '#!/bin/sh\nexit 77\n', { mode: 0o700 });
  const failedStats = run(['status', ...args, ...options], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  });
  assert.equal(failedStats.status, 0);
  assert.match(failedStats.stdout, /警告：备份统计未完成/);
  assert.equal(docker('stop', app('web'), app('worker')).status, 0);
  assert.equal(invoke('status', options).status, 1, 'backup reporting preserves failing health exit code');
  pass('start');
  console.log(
    'PASS: retention across all four classes; previous/latest/corrupt/foreign/unknown/partial protection; read-only statistics and warning exit codes'
  );
}
