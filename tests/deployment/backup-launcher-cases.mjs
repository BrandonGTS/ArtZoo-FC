import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';

// Same installed entry is reused before/after upgrade and rollback, with real Docker.
export function backupLauncher({ root, bundle, project, run, docker, app }) {
  const entry = process.env.ARTZOO_BACKUP_LAUNCHER || join(root, 'fixed-backup');
  if (!existsSync(entry)) {
    copyFileSync(join(bundle, 'artzoo-backup-launcher.sh'), entry);
    chmodSync(entry, 0o755);
  }
  const state = join(root, 'deploy');
  const record = join(state, 'backup-last');
  const store = join(root, 'scheduled-backups');
  const args = [
    '--root',
    root,
    '--project',
    project,
    '--backup-dir',
    store,
    '--keep',
    '2',
    '--keep-maintenance',
    '3'
  ];
  let request = 0;
  const launch = () => {
    if (!process.env.ARTZOO_BACKUP_SERVICE_PROBE) return run(args, { entry });
    const response = join(root, `service-response-${++request}`);
    console.log(`SERVICE_REQUEST ${JSON.stringify({ pid: process.pid, root, project, response })}`);
    const waited = run([], {
      command: `timeout 180 bash -c 'until test -f "$1"; do sleep 1; done' bash '${response}'`
    });
    assert.equal(waited.status, 0, 'host systemd probe must respond');
    return {
      status: Number(readFileSync(response, 'utf8')),
      stdout: '',
      stderr: 'See host systemd probe log'
    };
  };
  const last = () => readFileSync(record, 'utf8');
  const status = () =>
    run(['status', '--root', root, '--project', project], {
      entry: join(bundle, 'deployment-maintenance.sh')
    });
  const success = () => {
    if (process.env.ARTZOO_BACKUP_LAUNCHER) {
      assert.equal(statSync(entry).uid, 0);
      assert.equal(statSync(entry).mode & 0o777, 0o755);
    }
    const result = launch();
    assert.equal(result.status, 0, result.stderr);
    const version = readFileSync(join(state, 'current'), 'utf8').split(' ')[1];
    assert.match(last(), new RegExp(`result=success release=${version} backup=`));
    const snapshot = last().trim().split(' backup=')[1];
    assert.ok(readFileSync(join(snapshot, 'manifest'), 'utf8').includes(`release ${version}\n`));
    assert.equal(statSync(record).mode & 0o777, 0o600);
    assert.equal(last().split('\n').length, 2);
    const checked = status();
    assert.equal(checked.status, 0, checked.stderr);
    assert.ok(checked.stdout.includes(last().trim()));
    console.log(`PASS: fixed backup launcher follows current; manifest release=${version}`);
  };
  const failures = () => {
    const before = ['web', 'worker'].map(
      (name) =>
        docker(
          'inspect',
          '--format',
          '{{.Id}} {{.State.Running}} {{.State.StartedAt}} {{.State.FinishedAt}}',
          app(name)
        ).stdout
    );
    const contents = readdirSync(store);
    for (const mark of ['pending', 'media-registration.pending']) {
      writeFileSync(join(state, mark), mark === 'pending' ? 'upgrade\n' : 'running\n', { mode: 0o600 });
      assert.notEqual(launch().status, 0);
      assert.ok(last().includes(`reason=${mark}`));
      const checked = status();
      assert.notEqual(checked.status, 0, 'pending status remains a refusal');
      assert.match(checked.stdout, /警告：最近一次备份失败/);
      rmSync(join(state, mark));
    }
    const locked = run([], {
      command: `flock '${root}/secrets/.maintenance.lock' bash '${entry}' ${args.map((a) => `'${a}'`).join(' ')}`
    });
    assert.notEqual(locked.status, 0);
    assert.match(locked.stderr, /另一维护操作/);
    assert.match(last(), /reason=maintenance-locked/);
    const checked = status();
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /警告：最近一次备份失败/);
    const current = join(state, 'current');
    const original = readFileSync(current, 'utf8');
    const link = join(root, 'linked-release');
    symlinkSync(bundle, link);
    for (const changed of [
      original.replace(bundle, join(root, 'missing')),
      original.replace(bundle, link),
      original + original,
      original.replace(/(git|dev)-[0-9a-f]{12}-[0-9]{14}-[0-9]+/, 'invalid'),
      original.replace(bundle, '/tmp')
    ]) {
      writeFileSync(current, changed);
      assert.notEqual(launch().status, 0);
      assert.match(last(), /result=failed .*reason=current-invalid/);
    }
    writeFileSync(current, original);
    rmSync(link);
    chmodSync(current, 0o666);
    assert.notEqual(launch().status, 0);
    chmodSync(current, 0o600);
    chmodSync(record, 0o000);
    const unreadable = status();
    assert.equal(unreadable.status, 0, unreadable.stderr);
    assert.match(unreadable.stdout, /警告：最近备份结果读取失败/);
    chmodSync(record, 0o600);
    const protectedFile = join(root, 'protected-record');
    writeFileSync(protectedFile, 'unchanged');
    rmSync(record);
    symlinkSync(protectedFile, record);
    writeFileSync(join(state, 'pending'), 'upgrade\n');
    assert.notEqual(launch().status, 0);
    assert.equal(readFileSync(protectedFile, 'utf8'), 'unchanged');
    rmSync(record);
    rmSync(join(state, 'pending'));
    assert.deepEqual(readdirSync(store), contents, 'no backups or partial directories on refusal');
    assert.deepEqual(
      ['web', 'worker'].map(
        (name) =>
          docker(
            'inspect',
            '--format',
            '{{.Id}} {{.State.Running}} {{.State.StartedAt}} {{.State.FinishedAt}}',
            app(name)
          ).stdout
      ),
      before,
      'refusals never stop or recreate apps'
    );
    console.log(
      'PASS: pending/registration/lock/current/path refusals recorded; status warns; site unchanged; symlink result refused'
    );
  };
  return { success, failures };
}
