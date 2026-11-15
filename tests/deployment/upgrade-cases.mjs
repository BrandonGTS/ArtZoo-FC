import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Real, separately built bundles: harmless migration, failing SQL, unhealthy web, new configuration.
export function exerciseUpgrades({ root, bundle, project, run, sql, docker, app, config }) {
  const variants = process.env.ARTZOO_UPGRADE_TEST_BUNDLES;
  if (!variants) return;
  const good = join(variants, 'good');
  const bad = join(variants, 'bad');
  const unhealthy = join(variants, 'unhealthy');
  const required = join(variants, 'config');
  const store = join(root, 'upgrade-backups');
  const state = join(root, 'deploy');
  const originalConfig = readFileSync(config, 'utf8');
  const invoke = (command, selected, extra = [], options = {}) => {
    const result = run(
      [command, '--root', root, '--project', project, ...(selected ? ['--bundle', selected] : []), ...extra],
      { entry: join(good, 'deployment-maintenance.sh'), ...options }
    );
    assert.doesNotMatch(result.stdout + result.stderr, /SyntheticPrivateSms|Synthetic-test-only/);
    return result;
  };
  const pass = (command, selected, extra = []) => {
    const result = invoke(command, selected, extra);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return result;
  };
  const upgrade = (selected, extra = []) => invoke('upgrade', selected, ['--backup-dir', store, ...extra]);
  const backups = () =>
    existsSync(store) ? readdirSync(store).filter((n) => n.startsWith('upgrade-')).length : 0;
  const current = () => readFileSync(join(state, 'current'), 'utf8').split(' ')[0];
  const stopped = () => {
    for (const service of ['web', 'worker'])
      assert.equal(docker('inspect', '--format', '{{.State.Running}}', app(service)).stdout.trim(), 'false');
    assert.notEqual(invoke('start', bundle).status, 0, 'pending migration cannot be bypassed with start');
  };
  const rollback = (failure) => {
    if (failure) {
      const line = failure.stderr.split('\n').find((s) => s.includes('回退会丢弃'));
      assert.ok(line, 'failure prints an executable rollback command');
      const command = line.slice(line.indexOf('bash '));
      // The printed command consists only of shell-escaped fixture paths and fixed options.
      const executed = run([], { command });
      assert.equal(executed.status, 0, executed.stderr);
    } else pass('rollback', good, ['--backup-dir', store]);
    assert.equal(current(), bundle);
    assert.equal(existsSync(join(state, 'pending')), false);
    pass('status');
  };
  assert.equal(current(), bundle, 'enable-budget registers the initial version');
  const initialRecord = readFileSync(join(state, 'current'), 'utf8');
  const initialVersion = initialRecord.trim().split(' ')[1];
  const mismatched = initialRecord.trim().split(' ');
  mismatched[1] = 'git-aaaaaaaaaaaa-20000101000000-1';
  writeFileSync(join(state, 'current'), mismatched.join(' ') + '\n');
  assert.notEqual(upgrade(good).status, 0, 'current must match its verified release');
  assert.equal(backups(), 0);
  writeFileSync(join(state, 'current'), initialRecord);
  pass('stop');
  pass('start');
  sql("CREATE TABLE upgrade_probe (value text); INSERT INTO upgrade_probe VALUES ('before');");
  const image = join(root, 'media/original/upgrade.png');
  writeFileSync(image, 'before');
  assert.notEqual(upgrade(bundle).status, 0);
  assert.equal(backups(), 0);
  assert.notEqual(invoke('upgrade', good, ['--backup-dir', bundle]).status, 0);
  assert.equal(backups(), 0);
  const missing = upgrade(required);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /ARTZOO_UPGRADE_REQUIRED/);
  assert.equal(backups(), 0);
  pass('status');
  writeFileSync(
    config,
    originalConfig.replace(/^POSTGRES_PASSWORD=.*$/m, `POSTGRES_PASSWORD=${'f'.repeat(64)}`)
  );
  const credentials = upgrade(good);
  assert.notEqual(credentials.status, 0, 'new tools must authenticate before stopping');
  assert.ok(!(credentials.stdout + credentials.stderr).includes('f'.repeat(64)));
  assert.equal(backups(), 0);
  writeFileSync(config, originalConfig);
  pass('status');
  const bin = join(root, 'upgrade-fault');
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(
    join(bin, 'tar'),
    '#!/bin/bash\nif [[ "$1" == --create ]]; then exit 77; fi\nexec /usr/bin/tar "$@"\n',
    { mode: 0o700 }
  );
  const beforeMigration = invoke('upgrade', good, ['--backup-dir', store], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  });
  assert.notEqual(beforeMigration.status, 0);
  assert.equal(backups(), 0);
  assert.equal(existsSync(join(state, 'pending')), false);
  pass('status');
  // Bootstrap an existing deployment without touching its container IDs.
  console.log(
    'PASS: current/config/credentials preflight, repeated version refusal and restart after backup failure'
  );
  rmSync(join(state, 'current'));
  assert.notEqual(upgrade(good).status, 0);
  const successful = upgrade(good, ['--from', bundle]);
  assert.equal(successful.status, 0, successful.stderr);
  assert.match(successful.stdout, /upgrade_probe_migration/);
  assert.equal(current(), good);
  assert.equal(sql("SELECT count(*) FROM information_schema.tables WHERE table_name='upgrade_marker';"), '1');
  assert.equal(sql('SELECT value FROM upgrade_probe;'), 'before');
  console.log('PASS: harmless migration applied and existing data preserved');
  const count = backups();
  assert.notEqual(upgrade(good).status, 0);
  assert.equal(backups(), count);
  assert.notEqual(upgrade(bundle).status, 0, 'unknown applied migration rejects downgrade');
  assert.equal(backups(), count);
  pass('status');
  sql("UPDATE upgrade_probe SET value='after';");
  writeFileSync(image, 'after');
  rollback();
  assert.equal(sql('SELECT value FROM upgrade_probe;'), 'before');
  assert.equal(readFileSync(image, 'utf8'), 'before');
  assert.equal(sql("SELECT count(*) FROM information_schema.tables WHERE table_name='upgrade_marker';"), '0');
  assert.notEqual(invoke('rollback', good).status, 0, 'only one rollback level');
  console.log('PASS: manual rollback restored data/media/schema and consumed the previous pointer');
  for (const candidate of [bad, unhealthy]) {
    const failed = upgrade(candidate);
    assert.notEqual(failed.status, 0);
    stopped();
    rollback(failed);
    assert.equal(sql('SELECT value FROM upgrade_probe;'), 'before');
    assert.equal(readFileSync(image, 'utf8'), 'before');
    assert.equal(sql("SELECT to_regclass('public.upgrade_marker') IS NULL;"), 't');
    assert.equal(
      sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL;'),
      '0'
    );
    console.log(
      `PASS: ${candidate === bad ? 'failed migration' : 'unhealthy release'} stayed stopped; printed rollback restored the old version`
    );
  }
  // A new host setting is accepted, but does not prevent old-version recovery/status.
  writeFileSync(config, originalConfig + '\nARTZOO_UPGRADE_REQUIRED=1\n');
  const withConfig = upgrade(required);
  assert.equal(withConfig.status, 0, withConfig.stderr);
  rollback();
  assert.ok(readFileSync(config, 'utf8').includes('ARTZOO_UPGRADE_REQUIRED=1'));
  writeFileSync(config, originalConfig);
  const log = readFileSync(join(state, 'history.log'), 'utf8');
  assert.match(log, /upgrade .*result=success/);
  assert.match(log, /upgrade .*result=failed/);
  assert.match(log, /rollback .*result=success/);
  assert.ok(
    log
      .split('\n')
      .some((line) => line.includes('rollback from=') && line.includes(`to=artzoo-web:${initialVersion} `))
  );
  pass('status');
  console.log(
    'PASS: real upgrade, failed migration, unhealthy release, printed rollback, one-level recovery, config preflight and repeat refusal'
  );
}
